/**
 * 图书馆工具。
 *
 * 其中 3 个工具名各带一个等价别名（同一实现注册成两个名字）：
 *   quick_reserve_library_seat ←→ quick_reserve
 *   search_library_books       ←→ query_books
 *   query_library_book_detail  ←→ query_book_detail
 *
 * 两条链路：座位预约（office.chaoxing.com）需要超星会话，且要先做一次凭证置换；
 * 图书检索（superlib.hunau.edu.cn）不需要任何鉴权，只靠超星 App UA + Referer。
 */

import {
  LoginError,
  SessionUnavailableError,
  runWithSession,
} from '../auth/session-manager';
import { errorResult, textResult } from '../mcp/protocol';
import type { ToolContext, ToolDefinition } from '../mcp/registry';
import {
  fetchSeatIndex,
  fullRoomName,
  matchSeat,
  reserveStatusLabel,
  seedSeatSession,
  submitQuickReservation,
  submitReservation,
  type SeatReserve,
} from '../school/hunau/library';
import {
  DEFAULT_MAX_PAGES,
  MAX_PAGE_LIMIT,
  SEARCH_TYPES,
  effectiveCatalogItems,
  fetchLibraryBookDetail,
  holdingIsAvailable,
  searchLibraryBooks,
} from '../school/hunau/library-book';
import {
  availableReserveDays,
  availableStartSlots,
  defaultEndTime,
  defaultStartTime,
  formatDayLabel,
  formatHourMinute,
  isValidRange,
  normalizeFloor,
} from '../school/hunau/library-time';

// ---- 参数解析 ----

function strArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function intArg(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- 最近一次预约 ----

interface LastReserve {
  reserve: SeatReserve;
}

/**
 * 取「最近一次预约」：查线上首页数据（当前预约 → 即将开始）。
 *
 * 注意：ChillEast 客户端还有一层「设备本地缓存」（LibraryStorage）兜底，
 * Worker 采用纯无状态零数据留存架构，服务端不设持久化存储，
 * 所以这里没有缓存兜底 —— 拿不到就是拿不到，如实返回。
 */
async function findLastReserve(ctx: ToolContext): Promise<LastReserve | null> {
  const index = await runWithSession(ctx.env, ctx.credentials, async (context) => {
    await seedSeatSession(context.session, ctx.log);
    return await fetchSeatIndex(context.session);
  });
  if (index.curReserves.length > 0) return { reserve: index.curReserves[0] };
  if (index.nearReserves.length > 0) return { reserve: index.nearReserves[0] };
  return null;
}

// ---- query_library_last_seat ----

function createLastSeatTool(): ToolDefinition {
  return {
    name: 'query_library_last_seat',
    description:
      '查询用户在图书馆最近或上一次预约的座位记录（包括阅览室名称、房间ID、座位编号、起止时段等）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(_args, ctx: ToolContext) {
      const last = await findLastReserve(ctx);
      if (last === null) {
        const payload = { found: false, message: '未找到用户过往的图书馆预约记录。' };
        return textResult(JSON.stringify(payload, null, 2), payload);
      }

      const days = availableReserveDays();
      let recommendedDay = days[0];
      if (availableStartSlots(recommendedDay).length === 0 && days.length > 1) {
        recommendedDay = days[1];
      }

      const payload = {
        found: true,
        roomId: last.reserve.roomId,
        roomName: fullRoomName(last.reserve),
        seatNum: last.reserve.seatNum,
        lastDay: last.reserve.today,
        lastStartTime: formatHourMinute(last.reserve.startTime),
        lastEndTime: formatHourMinute(last.reserve.endTime),
        status: last.reserve.status,
        statusLabel: reserveStatusLabel(last.reserve.status),
        recommendedDay,
        recommendedDayLabel: formatDayLabel(recommendedDay),
      };
      return textResult(JSON.stringify(payload, null, 2), payload);
    },
  };
}

// ---- reserve_library_seat ----

function createReserveTool(): ToolDefinition {
  return {
    name: 'reserve_library_seat',
    description:
      '预约图书馆阅览室座位。如果没有指定座位和房间，系统将默认采用用户上一次预约的历史座位。' +
      '【重要】：在正式执行预约之前，必须先向用户展示预约方案（阅览室名称、座位号、预约日期与起止时间），' +
      '征得用户明确同意确认后，传入 confirmed=true 方可真正提交预约。',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: {
          type: 'integer',
          description: '阅览室房间 ID（可选。若不指定，将默认自动使用上次预约的阅览室）。',
        },
        seatNum: {
          type: 'string',
          description: '座位编号，如 "034" 或 "052"（可选。若不指定，将默认自动使用上次预约的座位编号）。',
        },
        day: {
          type: 'string',
          description: '预约日期，格式为 YYYY-MM-DD（可选。默认自动选用今天或明天最近可约日期）。',
        },
        startTime: {
          type: 'string',
          description:
            '开始时间，格式为 HH:mm，如 "08:30" 或 "14:00"（可选。若不指定，优先沿用上次预约时段或推荐时段）。',
        },
        endTime: {
          type: 'string',
          description:
            '结束时间，格式为 HH:mm，如 "12:00" 或 "18:00"（可选。若不指定，优先沿用上次预约时段或推荐时段）。',
        },
        confirmed: {
          type: 'boolean',
          description:
            '用户是否已明确同意并确认预约。默认为 false。' +
            '【极为重要】：首次调用时若用户尚未对具体座位和时间进行明确确认，请保持 false。' +
            '工具将返回待确认的预约详情；待用户明确回复同意后，再将 confirmed 设为 true 重新调用以真正完成提交。',
          default: false,
        },
      },
      additionalProperties: false,
    },
    async handler(args, ctx: ToolContext) {
      let roomId = intArg(args['roomId']);
      let seatNum = strArg(args['seatNum']);
      let day = strArg(args['day']);
      let startTime = strArg(args['startTime']);
      let endTime = strArg(args['endTime']);
      const confirmed = args['confirmed'] === true;

      let roomName = '';
      let isDefaultedFromLastSeat = false;

      // 1. 没给全房间与座位号时，回退到上次的历史座位
      if (roomId === null || roomId <= 0 || seatNum === '') {
        const last = await findLastReserve(ctx);
        if (last === null) {
          return errorResult('未找到您上次预约的历史座位记录，请指定要预约的阅览室与座位号。');
        }
        if (roomId === null || roomId <= 0) roomId = last.reserve.roomId;
        if (seatNum === '') seatNum = last.reserve.seatNum;
        roomName = fullRoomName(last.reserve);
        isDefaultedFromLastSeat = true;
        if (startTime === '') startTime = formatHourMinute(last.reserve.startTime);
        if (endTime === '') endTime = formatHourMinute(last.reserve.endTime);
      }

      if (roomId === null || roomId <= 0 || seatNum === '') {
        return errorResult('历史座位记录不完整，请显式指定 roomId 与 seatNum。');
      }

      // 2. 确定预约日期
      const days = availableReserveDays();
      if (day === '') {
        day = days[0];
        if (availableStartSlots(day).length === 0 && days.length > 1) day = days[1];
      }

      // 3. 校验并计算预约时间段（与 Dart 一致：不合法就用默认时段覆盖）
      const now = new Date();
      if (!isValidRange(day, startTime, endTime, now)) {
        const fallbackStart = defaultStartTime(day, now);
        if (fallbackStart === null) {
          return errorResult(`${day} 已无可预约的时段，请选择其他日期。`);
        }
        startTime = fallbackStart;
        const fallbackEnd = defaultEndTime(startTime);
        if (fallbackEnd === null) {
          return errorResult(`无法为 ${startTime} 生成有效结束时段`);
        }
        endTime = fallbackEnd;
      }

      const dayLabel = formatDayLabel(day);
      const finalRoomId = roomId;
      const finalSeatNum = seatNum;
      const finalDay = day;
      const finalStart = startTime;
      const finalEnd = endTime;

      // 4. 未获得明确确认：只返回方案，不提交
      if (!confirmed) {
        const pending = {
          status: 'requires_confirmation',
          needsUserConsent: true,
          message:
            `已为您准备好座位预约方案${isDefaultedFromLastSeat ? '（未指定座位，已默认采用您上次的座位）' : ''}。` +
            '【重要】：请必须向用户清晰呈现以下预约详情，并明确询问用户是否同意确认为其预约。' +
            '只有用户明确回复同意/确认后，方可再次调用此工具并传入 confirmed: true。',
          pendingReservation: {
            roomName: roomName !== '' ? roomName : `阅览室ID: ${finalRoomId}`,
            roomId: finalRoomId,
            seatNum: finalSeatNum,
            day: finalDay,
            dayLabel,
            startTime: finalStart,
            endTime: finalEnd,
            isDefaultedFromLastSeat,
          },
        };
        return textResult(JSON.stringify(pending, null, 2), pending);
      }

      // 5. 已确认：真正提交
      try {
        const reserve = await runWithSession(ctx.env, ctx.credentials, async (context) => {
          await seedSeatSession(context.session, ctx.log);
          return await submitReservation(context.session, {
            roomId: finalRoomId,
            seatNum: finalSeatNum,
            day: finalDay,
            startTime: finalStart,
            endTime: finalEnd,
          });
        });
        const payload = {
          status: 'success',
          message: '图书馆座位预约成功！',
          reservation: {
            id: reserve.id,
            roomName: fullRoomName(reserve) !== '' ? fullRoomName(reserve) : roomName,
            roomId: reserve.roomId,
            seatNum: reserve.seatNum,
            day: finalDay,
            dayLabel,
            startTime: finalStart,
            endTime: finalEnd,
          },
        };
        return textResult(JSON.stringify(payload, null, 2), payload);
      } catch (error) {
        return errorResult(`提交图书馆座位预约失败: ${messageOf(error)}`);
      }
    },
  };
}

// ---- quick_reserve_library_seat / quick_reserve ----

function createQuickReserveTool(): ToolDefinition {
  return {
    name: 'quick_reserve_library_seat',
    description:
      '快速预约图书馆座位（智能匹配空闲座位）。根据指定的时间段与位置偏好（楼层、阅览室）自动寻找可用座位并完成预约。' +
      '【写操作】confirmed=true 时会真实占用座位。' +
      '【重要原则】：在正式执行预约之前，必须先向用户展示匹配到的座位方案（阅览室名称、座位号、预约日期与起止时段），' +
      '征得用户明确同意确认后，传入 confirmed=true 方可真正提交预约。',
    inputSchema: {
      type: 'object',
      properties: {
        startTime: {
          type: 'string',
          description:
            '预约开始时间，格式为 HH:mm，如 "08:30" 或 "14:00"（可选。若不指定，自动按当前时间选用最近可约时段）。',
        },
        endTime: {
          type: 'string',
          description:
            '预约结束时间，格式为 HH:mm，如 "12:00" 或 "18:00"（可选。若不指定，默认按开始时间后 1.5~2 小时计算）。',
        },
        day: {
          type: 'string',
          description: '预约日期，格式为 YYYY-MM-DD（可选。默认选用今天，若今天已无可用时段则顺延至明天）。',
        },
        floor: {
          type: 'string',
          description: '楼层偏好，如 "2楼"、"3楼"、"4楼"、"5楼"、"6楼"（可选）。',
        },
        room: {
          type: 'string',
          description: '阅览室偏好，如 "301"、"自然科学图书阅览一区413"（可选）。',
        },
        roomId: {
          type: 'integer',
          description: '阅览室房间 ID（可选。若在确认步骤中，请传入此前匹配到的 roomId）。',
        },
        seatNum: {
          type: 'string',
          description: '座位编号，如 "042"（可选。若在确认步骤中，请传入此前匹配到的 seatNum）。',
        },
        confirmed: {
          type: 'boolean',
          description:
            '用户是否已明确同意并确认预约。默认为 false。' +
            '【极为重要】：首次调用时若用户尚未对具体匹配座位和时间明确同意，请保持 false。' +
            '工具将实时匹配空闲座位并返回待确认详情；待用户明确回复同意后，再将 confirmed 设为 true 重新调用以真正完成提交。',
          default: false,
        },
      },
      additionalProperties: false,
    },
    async handler(args, ctx: ToolContext) {
      let roomId = intArg(args['roomId']);
      let seatNum = strArg(args['seatNum']);
      let day = strArg(args['day']);
      let startTime = strArg(args['startTime']);
      let endTime = strArg(args['endTime']);
      const floor = strArg(args['floor']);
      const room = strArg(args['room']);
      const confirmed = args['confirmed'] === true;

      // 1. 确定预约日期
      const days = availableReserveDays();
      if (day === '') {
        day = days[0];
        if (availableStartSlots(day).length === 0 && days.length > 1) day = days[1];
      }

      // 2. 校验并补全预约时间段
      const now = new Date();
      if (!isValidRange(day, startTime, endTime, now)) {
        if (startTime === '') {
          const fallbackStart = defaultStartTime(day, now);
          if (fallbackStart === null) {
            return errorResult(`${day} 已无可预约的时段，请选择其他日期。`);
          }
          startTime = fallbackStart;
        }
        if (endTime === '') {
          const fallbackEnd = defaultEndTime(startTime);
          if (fallbackEnd === null) {
            return errorResult(`无法为 ${startTime} 生成有效结束时段`);
          }
          endTime = fallbackEnd;
        }
      }
      if (!isValidRange(day, startTime, endTime, now)) {
        // Dart 会把不合法的时段直接提交给服务端；这里提前拦住，避免无意义的写请求
        return errorResult(
          `${day} ${startTime}-${endTime} 不是可预约时段（需为 07:00-22:00 之间的整点/半点，且晚于当前时间）。`,
        );
      }

      // 3. 楼层与阅览室偏好规范化
      const secondLevel = normalizeFloor(floor);
      const thirdLevel = room;
      const dayLabel = formatDayLabel(day);

      // 4. 未给出明确座位时，让服务端智能匹配
      let matchedRoomName = '';
      let matchedDuration = '';
      if (roomId === null || roomId <= 0 || seatNum === '') {
        try {
          const matched = await runWithSession(ctx.env, ctx.credentials, async (context) => {
            await seedSeatSession(context.session, ctx.log);
            return await matchSeat(context.session, {
              startTime,
              endTime,
              firstLevelName: '图书馆',
              secondLevelName: secondLevel,
              thirdLevelName: thirdLevel,
            });
          });
          roomId = matched.roomId;
          seatNum = matched.seatNum;
          matchedRoomName = fullRoomName(matched);
          matchedDuration = matched.duration;
        } catch (error) {
          return errorResult(`快速匹配座位失败: ${messageOf(error)}`);
        }
      }

      if (roomId === null || roomId <= 0 || seatNum === '') {
        return errorResult('未能匹配到可用座位，请调整时间或位置偏好后重试。');
      }

      const finalRoomId = roomId;
      const finalSeatNum = seatNum;
      const finalDay = day;
      const finalStart = startTime;
      const finalEnd = endTime;

      // 5. 未获得明确确认：返回匹配结果供用户确认
      if (!confirmed) {
        const roomLabel = matchedRoomName !== '' ? matchedRoomName : `阅览室ID: ${finalRoomId}`;
        const pending = {
          status: 'requires_confirmation',
          needsUserConsent: true,
          message:
            `已为您快速匹配到空闲座位【${roomLabel}】${finalSeatNum}号。` +
            '【重要】：请必须向用户清晰呈现以下预约详情，并明确询问用户是否同意确认为其预约。' +
            '只有用户明确回复同意/确认后，方可再次调用此工具并传入 confirmed: true 以及 roomId 和 seatNum。',
          matchedSeat: {
            roomId: finalRoomId,
            seatNum: finalSeatNum,
            roomName: roomLabel,
            day: finalDay,
            dayLabel,
            startTime: finalStart,
            endTime: finalEnd,
            duration: matchedDuration !== '' ? `${matchedDuration}h` : '',
          },
        };
        return textResult(JSON.stringify(pending, null, 2), pending);
      }

      // 6. 已确认：真正提交快速预约（写操作）
      try {
        const reserve = await runWithSession(ctx.env, ctx.credentials, async (context) => {
          await seedSeatSession(context.session, ctx.log);
          return await submitQuickReservation(context.session, {
            roomId: finalRoomId,
            seatNum: finalSeatNum,
            day: finalDay,
            startTime: finalStart,
            endTime: finalEnd,
          });
        });
        const payload = {
          status: 'success',
          message: '图书馆座位快速预约成功！',
          reservation: {
            id: reserve.id,
            roomName: fullRoomName(reserve) !== '' ? fullRoomName(reserve) : `阅览室 ${finalRoomId}`,
            roomId: reserve.roomId,
            seatNum: reserve.seatNum,
            day: finalDay,
            dayLabel,
            startTime: finalStart,
            endTime: finalEnd,
          },
        };
        return textResult(JSON.stringify(payload, null, 2), payload);
      } catch (error) {
        return errorResult(`提交快速预约失败: ${messageOf(error)}`);
      }
    },
  };
}

// ---- search_library_books / query_books ----

function createSearchBooksTool(): ToolDefinition {
  return {
    name: 'search_library_books',
    description:
      '检索湖南农业大学图书馆馆藏图书。支持按题名(书名)、责任者(作者)、主题词、标准编码(ISBN)进行检索，' +
      '返回匹配的图书列表、索书号、出版社、出版年、detailParam详情参数等。不需要登录。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '检索关键词，如书名、作者、主题或标准编码/ISBN。',
        },
        searchType: {
          type: 'string',
          description:
            '检索方式。可选: "title"(题名/书名，默认), "author"(责任者/作者), "subject"(主题词), "Identifier"(标准编码/ISBN)。',
          enum: [...SEARCH_TYPES],
          default: 'title',
        },
        maxPages: {
          type: 'integer',
          description:
            `最多翻几页（1-${MAX_PAGE_LIMIT}），默认 1 页。每页 20 条。` +
            '注意：实测超星移动端 OPAC 的第 2 页起会返回 0 条（与 ChillEast 行为一致），' +
            '所以除非确认需要，保持默认 1 页即可 —— 翻页只会增加耗时。',
          minimum: 1,
          maximum: MAX_PAGE_LIMIT,
          default: DEFAULT_MAX_PAGES,
        },
      },
      required: ['keyword'],
      additionalProperties: false,
    },
    async handler(args, _ctx: ToolContext) {
      const keyword = strArg(args['keyword']);
      if (keyword === '') return errorResult('请提供有效的检索关键词');

      const searchType = strArg(args['searchType']) || 'title';
      if (!(SEARCH_TYPES as readonly string[]).includes(searchType)) {
        return errorResult(`searchType 必须是 ${SEARCH_TYPES.join(' / ')} 之一`);
      }
      const maxPages = intArg(args['maxPages']) ?? DEFAULT_MAX_PAGES;

      try {
        const result = await searchLibraryBooks({ keyword, searchType, maxPages });
        const books = result.books.map((book) => ({
          title: book.title,
          author: book.author,
          callNumber: book.callNumber,
          publisher: book.publisher,
          publishYear: book.publishYear,
          isbn: book.isbn,
          detailParam: book.detailParam,
        }));
        const payload = {
          keyword,
          searchType,
          totalCount: result.totalCount,
          totalPages: result.totalPages,
          bookCount: books.length,
          books,
        };
        return textResult(JSON.stringify(payload, null, 2), payload);
      } catch (error) {
        return errorResult(`检索图书馆图书失败: ${messageOf(error)}`);
      }
    },
  };
}

// ---- query_library_book_detail / query_book_detail ----

function createBookDetailTool(): ToolDefinition {
  return {
    name: 'query_library_book_detail',
    description:
      '查询图书馆具体图书的完整书目详情与馆藏副本分布信息（包括题名/责任者、索书号、出版项、载体形态、' +
      '各个校区/馆藏地点的馆藏副本条码、单册类型、状态及是否在库）。' +
      '支持直接传入 detailParam，或者传入 title/keyword 自动检索后提取详情。不需要登录。',
    inputSchema: {
      type: 'object',
      properties: {
        detailParam: {
          type: 'string',
          description:
            '图书详情参数字符串（如 "{\\"marc_no\\":\\"zyk0161024\\"}"，由 search_library_books 搜索结果中的 detailParam 字段提供）。若未指定，需提供 title 或 keyword。',
        },
        title: {
          type: 'string',
          description: '图书书名/题名（可选。若未提供 detailParam，系统将按此书名检索并查询首条图书详情）。',
        },
        keyword: {
          type: 'string',
          description: '检索关键词（可选。title 为空时的备用检索词，语义与 title 相同）。',
        },
        author: {
          type: 'string',
          description: '作者/责任者（可选）。',
        },
        publisher: {
          type: 'string',
          description: '出版社（可选）。',
        },
        callNumber: {
          type: 'string',
          description: '索书号（可选）。',
        },
      },
      additionalProperties: false,
    },
    async handler(args, _ctx: ToolContext) {
      let detailParam = strArg(args['detailParam']);
      let title = strArg(args['title']);
      let author = strArg(args['author']);
      let publisher = strArg(args['publisher']);
      let callNumber = strArg(args['callNumber']);

      try {
        // 没给 detailParam 就先检索一次，用首条结果的参数查详情
        if (detailParam === '') {
          const query = title !== '' ? title : strArg(args['keyword']);
          if (query === '') {
            return errorResult('请提供 detailParam 或书名 title 以查询图书详情');
          }

          const search = await searchLibraryBooks({
            keyword: query,
            searchType: 'title',
            maxPages: DEFAULT_MAX_PAGES,
          });
          if (search.books.length === 0) {
            return errorResult(`未在图书馆检索到与 "${query}" 匹配的图书`);
          }

          const first = search.books[0];
          detailParam = first.detailParam;
          if (title === '') title = first.title;
          if (author === '') author = first.author;
          if (publisher === '') publisher = first.publisher;
          if (callNumber === '') callNumber = first.callNumber;
        }

        const detail = await fetchLibraryBookDetail({
          detailParam,
          title,
          author,
          publisher,
        });

        const holdings = detail.holdings.map((holding) => ({
          barcode: holding.barcode,
          volume: holding.volume,
          accessionNo: holding.accessionNo,
          copyType: holding.copyType,
          status: holding.status,
          price: holding.price,
          holdingUnit: holding.holdingUnit,
          location: holding.location,
          notes: holding.notes,
          isAvailable: holdingIsAvailable(holding),
        }));

        const payload = {
          title: detail.title,
          author: detail.author,
          callNumber: detail.callNumber,
          subject: detail.subject,
          isbn: detail.isbn,
          price: detail.price,
          publishInfo: detail.publishInfo,
          physicalDesc: detail.physicalDesc,
          series: detail.series,
          summary: detail.summary,
          catalogItems: effectiveCatalogItems(detail),
          totalHoldings: holdings.length,
          availableHoldings: holdings.filter((holding) => holding.isAvailable).length,
          holdings,
        };
        return textResult(JSON.stringify(payload, null, 2), payload);
      } catch (error) {
        return errorResult(`查询图书详情失败: ${messageOf(error)}`);
      }
    },
  };
}

// ---- 汇总 ----

/** 生成 8 个图书馆工具（含 3 个别名，别名与主名共用同一个 handler）。 */
export function createLibraryTools(): ToolDefinition[] {
  const lastSeat = createLastSeatTool();
  const reserve = createReserveTool();
  const quickReserve = createQuickReserveTool();
  const searchBooks = createSearchBooksTool();
  const bookDetail = createBookDetailTool();

  return [
    lastSeat,
    reserve,
    quickReserve,
    {
      ...quickReserve,
      name: 'quick_reserve',
      description: `${quickReserve.description}（本工具与 quick_reserve_library_seat 完全等价，二选一调用即可，不要重复提交。）`,
    },
    searchBooks,
    {
      ...searchBooks,
      name: 'query_books',
      description: `${searchBooks.description}（本工具与 search_library_books 完全等价，二选一调用即可。）`,
    },
    bookDetail,
    {
      ...bookDetail,
      name: 'query_book_detail',
      description: `${bookDetail.description}（本工具与 query_library_book_detail 完全等价，二选一调用即可。）`,
    },
  ];
}

/** 供测试与诊断：图书馆相关工具名清单。 */
export const LIBRARY_TOOL_NAMES = [
  'query_library_last_seat',
  'reserve_library_seat',
  'quick_reserve_library_seat',
  'quick_reserve',
  'search_library_books',
  'query_books',
  'query_library_book_detail',
  'query_book_detail',
] as const;