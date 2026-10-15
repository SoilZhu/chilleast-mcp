/**
 * 超星通知查询 —— 直接用登录时拿到的 `.chaoxing.com` 会话 Cookie（UID）。
 * 对齐 ChillEast `NoticeService`。
 *
 * 这也是验证「登录链确实换到了超星身份」的最轻量工具：不需要任何额外换票。
 */

import { textResult } from '../mcp/protocol';
import type { ToolContext, ToolDefinition } from '../mcp/registry';
import { SessionExpiredError, runWithSession } from '../auth/session-manager';
import { DESKTOP_UA, HOSTS } from '../school/hunau/constants';

const NOTICE_LIST_URL = `${HOSTS.chaoxingNotice}/pc/notice/getNoticeList`;
const NOTICE_REFERER = `${HOSTS.chaoxingNotice}/pc/notice/myNotice`;

interface RawNotice {
  idCode?: unknown;
  content?: unknown;
  createrName?: unknown;
  insertTime?: unknown;
  isread?: unknown;
  uuid?: unknown;
  count_all?: unknown;
  count_read?: unknown;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function toInt(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** 通知标题：超星把标题放在 content 里，或者藏在附件字段里。 */
function extractTitle(notice: RawNotice): string {
  const content = typeof notice.content === 'string' ? notice.content : '';
  const firstLine = content.split('\n').map((line) => line.trim()).find((line) => line !== '');
  if (firstLine !== undefined) return firstLine.slice(0, 120);

  const attachment = (notice as Record<string, unknown>)['attachment'];
  if (typeof attachment === 'string' && attachment !== '') {
    try {
      const parsed = JSON.parse(attachment) as Array<Record<string, unknown>>;
      const name = parsed[0]?.['name'];
      if (typeof name === 'string') return name;
    } catch {
      // 附件不是 JSON，忽略
    }
  }
  return '(无标题)';
}

export function normalizeNotice(notice: RawNotice): Record<string, unknown> {
  const insertTime = toInt(notice.insertTime);
  const date = insertTime > 0 ? new Date(insertTime) : new Date();
  const isRead = toInt(notice.isread) === 1;
  const rawCountAll = optionalCount(notice.count_all);
  const rawCountRead = optionalCount(notice.count_read);
  return {
    uuid: typeof notice.uuid === 'string' ? notice.uuid : '',
    idCode: typeof notice.idCode === 'string' ? notice.idCode : '',
    title: extractTitle(notice),
    content: typeof notice.content === 'string' ? notice.content : '',
    sender: typeof notice.createrName === 'string' ? notice.createrName : '',
    sentAt: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`,
    isRead,
    // ⚠️ count_all / count_read 是**这条通知的接收人数与已读人数**（全校维度），
    // 不是「我的未读数」。已知某条通知是 34136，那是接收人数不是未读通知数。
    // 所以原样给出两个计数，不再自己算一个会被误读的 "unreadCount"。
    ...(rawCountAll === null ? {} : { recipientCount: rawCountAll }),
    ...(rawCountRead === null ? {} : { readCount: rawCountRead }),
  };
}

/** 只在字段确实存在且是数字时才返回，避免把缺失当成 0。 */
function optionalCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** 统一识别「会话失效」——超星侧失效时返回 HTML 登录页而不是 JSON。 */
export function parseJsonOrExpire(body: string): Record<string, unknown> {
  const trimmed = body.trim();
  if (trimmed.startsWith('<')) {
    throw new SessionExpiredError('超星会话已失效（返回了 HTML 而不是 JSON）');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new SessionExpiredError('超星通知接口返回了无法解析的内容');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SessionExpiredError('超星通知接口返回结构异常');
  }
  const data = parsed as Record<string, unknown>;

  // 关键：超星会话失效时返回的是**合法 JSON**，HTTP 200：
  //   {"msg":"您当前未登录","success":false}
  // 如果只识别 HTML 形态，这里会被当成"没有通知"，会话静默过期后永远恢复不了。
  if (data['success'] === false) {
    const message = typeof data['msg'] === 'string' ? data['msg'] : '';
    if (/未登录|登录|会话|过期|token/i.test(message)) {
      throw new SessionExpiredError(`超星会话已失效：${message}`);
    }
  }
  const message = data['msg'];
  if (typeof message === 'string' && /您当前未登录|未登录/.test(message)) {
    throw new SessionExpiredError(`超星会话已失效：${message}`);
  }
  return data;
}

export function createNoticeTools(): ToolDefinition[] {
  const listTool: ToolDefinition = {
    name: 'query_notices',
    description:
      '查询超星（学习通）通知公告列表，返回标题、发送人、时间与已读状态。支持翻页。',
    inputSchema: {
      type: 'object',
      properties: {
        lastValue: {
          type: 'string',
          description: '翻页标记。第一页不传；后续传上一页返回的 nextLastValue。',
        },
        year: { type: 'integer', description: '筛选年份，默认当前年份。' },
        keyword: { type: 'string', description: '按关键词筛选通知。' },
      },
      additionalProperties: false,
    },
    async handler(args, toolContext: ToolContext) {
      const lastValue = typeof args['lastValue'] === 'string' ? args['lastValue'] : '';
      const keyword = typeof args['keyword'] === 'string' ? args['keyword'] : '';
      const year =
        typeof args['year'] === 'number' ? args['year'] : new Date().getFullYear();

      return await runWithSession(toolContext.env, toolContext.credentials, async (ctx) => {
        const form = new URLSearchParams({
          type: '2',
          notice_type: '',
          lastValue,
          sort: '',
          folderUUID: '',
          kw: keyword,
          startTime: '',
          endTime: '',
          gKw: '',
          gName: '',
          year: String(year),
          tag: '',
          fidsCode: '',
          queryFolderNoticePrevYear: '0',
          filterSenderPuids: '',
          filterTags: '',
        });

        const response = await ctx.session.request(NOTICE_LIST_URL, {
          method: 'POST',
          body: form.toString(),
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': DESKTOP_UA,
            'X-Requested-With': 'XMLHttpRequest',
            Referer: NOTICE_REFERER,
          },
        });
        if (response.status !== 200) {
          throw new Error(`获取通知列表失败（HTTP ${response.status}）`);
        }

        const data = parseJsonOrExpire(response.body);
        const errorMessage = data['errorMsg'];
        if (typeof errorMessage === 'string' && errorMessage !== '') {
          throw new Error(`超星接口返回错误：${errorMessage}`);
        }

        const notices = data['notices'];
        if (typeof notices !== 'object' || notices === null) {
          return textResult('没有通知。', { count: 0, messages: [] });
        }
        const container = notices as Record<string, unknown>;
        const rawList = container['list'];
        if (!Array.isArray(rawList) || rawList.length === 0) {
          return textResult('没有通知。', { count: 0, messages: [] });
        }

        const messages = (rawList as RawNotice[]).map(normalizeNotice);
        const nextLastValue = container['lastGetId'];

        return textResult(
          `共 ${messages.length} 条通知：\n` +
            JSON.stringify(messages, null, 2) +
            (nextLastValue === undefined || nextLastValue === null
              ? ''
              : `\n\n下一页请传 lastValue=${String(nextLastValue)}`),
          { count: messages.length, messages, nextLastValue: nextLastValue ?? null },
        );
      });
    },
  };

  const detailTool: ToolDefinition = {
    name: 'query_notice_detail',
    description: '查询单条超星通知的详情，需要先通过 query_notices 拿到 uuid。',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: '通知的 uuid。' },
      },
      required: ['uuid'],
      additionalProperties: false,
    },
    async handler(args, toolContext: ToolContext) {
      const uuid = typeof args['uuid'] === 'string' ? args['uuid'].trim() : '';
      if (uuid === '') {
        return textResult('必须提供 uuid。');
      }

      return await runWithSession(toolContext.env, toolContext.credentials, async (ctx) => {
        const response = await ctx.session.get(
          `${HOSTS.chaoxingNotice}/pc/notice/${encodeURIComponent(uuid)}/getNoticeDetail?sendTag=0`,
          {
            headers: {
              'User-Agent': DESKTOP_UA,
              'X-Requested-With': 'XMLHttpRequest',
              Referer: NOTICE_REFERER,
            },
          },
        );
        if (response.status !== 200) {
          throw new Error(`获取通知详情失败（HTTP ${response.status}）`);
        }
        const data = parseJsonOrExpire(response.body);
        return textResult(JSON.stringify(data, null, 2), data);
      });
    },
  };

  return [listTool, detailTool];
}
