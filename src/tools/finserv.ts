/**
 * 一卡通财务平台（fin-serv）工具集。
 *
 * 工具名与 ChillEast 完全一致；`query_electricity` / `query_bill` 是
 * `recharge_electricity` / `query_card_transactions` 的**同一实现别名**
 * （用工厂函数传名字生成，对齐 Dart 里 `McpTool.create({String? toolName})` 的写法）。
 *
 * 与客户端（无状态）相比，这里唯一的架构差异是宿舍来源：ChillEast 从
 * `SharedPreferences` 读「上次绑定的宿舍」，服务端没有这份持久状态，改成
 * **显式传参 + 缺参时返回候选列表**的两段式交互（同 `query_empty_classrooms`）。
 */

import { textResult, type McpToolResult } from '../mcp/protocol';
import type { ToolContext, ToolDefinition } from '../mcp/registry';
import { runWithSession } from '../auth/session-manager';
import { getEffectiveSessionKey, open, seal } from '../auth/crypto-box';
import {
  connectFinServ,
  createElectricityPreOrder,
  displayRoomName,
  fetchCardInfo,
  fetchCardTransactions,
  fetchElectricAreas,
  fetchElectricBalance,
  fetchElectricBuildings,
  fetchElectricRooms,
  isHashedRoomName,
  resolveElectricityTarget,
  resolveTransactionRange,
  roomNameFromAccount,
  type CardTransaction,
  type ElectricityArea,
  type ElectricityBalance,
  type ElectricityBuilding,
  type ElectricityPreOrder,
  type ElectricityRoom,
  type ElectricityTarget,
  type FinServCardInfo,
} from '../school/hunau/finserv';

// ---- 参数读取（MCP 客户端可能给数字也可能给数字字符串，都收） ----

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const ELECTRICITY_ACTIONS = [
  'query_balance',
  'recharge',
  'get_areas',
  'get_buildings',
  'get_rooms',
] as const;

type ElectricityAction = (typeof ELECTRICITY_ACTIONS)[number];

function readAction(value: unknown): ElectricityAction {
  const text = readString(value);
  for (const action of ELECTRICITY_ACTIONS) {
    if (action === text) return action;
  }
  return 'query_balance';
}

/** 流水最多回 100 条，保护模型上下文（对齐 Dart 工具里的 limit）。 */
const TRANSACTION_LIMIT = 100;

// ===========================================================================
// query_campus_card_balance
// ===========================================================================

function createCampusCardBalanceTool(): ToolDefinition {
  return {
    name: 'query_campus_card_balance',
    description:
      '查询湖南农业大学学生的校园卡账户信息，包括持卡人姓名、学号/卡号（idserial）以及当前校园卡可用余额。数据实时来自一卡通财务平台，不读缓存。',
    inputSchema: {
      type: 'object',
      properties: {
        forceRefresh: {
          type: 'boolean',
          description:
            '仅为兼容 ChillEast 旧调用方保留：服务端不缓存校园卡信息，每次调用都会重新授权并实时拉取，此参数不影响行为。',
        },
      },
      additionalProperties: false,
    },
    async handler(_args, toolContext: ToolContext) {
      const info = await runWithSession(
        toolContext.env,
        toolContext.credentials,
        async (session) => {
          const ctx = await connectFinServ(session.session, { log: toolContext.log });
          return await fetchCardInfo(ctx);
        },
      );

      const payload = {
        name: info.name,
        studentId: info.idserial,
        balance: info.balance,
        unit: '元',
        status: 'success',
      };
      return textResult(
        `${info.name}（学号 ${info.idserial}）校园卡余额：${info.balance} 元`,
        payload,
      );
    },
  };
}

// ===========================================================================
// recharge_electricity / query_electricity
// ===========================================================================

type ElectricityOutcome =
  | { kind: 'areas'; areas: ElectricityArea[] }
  | { kind: 'buildings'; areaName: string; buildings: ElectricityBuilding[] }
  | { kind: 'rooms'; areaName: string; buildingName: string; rooms: ElectricityRoom[] }
  | { kind: 'need-area'; action: ElectricityAction }
  | {
      kind: 'need-building';
      action: ElectricityAction;
      areaName: string;
      buildings: ElectricityBuilding[];
    }
  | {
      kind: 'need-room';
      action: ElectricityAction;
      areaName: string;
      buildingName: string;
      rooms: ElectricityRoom[];
    }
  | { kind: 'need-amount'; areaName: string; buildingName: string; roomName: string }
  | {
      kind: 'need-confirmation';
      target: ElectricityTarget;
      roomName: string;
      amount: number;
      card: FinServCardInfo;
      confirmationToken: string;
    }
  | { kind: 'balance'; target: ElectricityTarget; balance: ElectricityBalance; roomName: string }
  | {
      kind: 'meter-abnormal';
      target: ElectricityTarget;
      balance: ElectricityBalance;
      roomName: string;
    }
  | {
      kind: 'recharged';
      target: ElectricityTarget;
      roomName: string;
      amount: number;
      card: FinServCardInfo;
      order: ElectricityPreOrder;
    };

function renderElectricityOutcome(outcome: ElectricityOutcome): ReturnType<typeof textResult> {
  switch (outcome.kind) {
    case 'areas':
      return textResult(
        '请选择校区（areaName）后再次调用：\n' + JSON.stringify(outcome.areas, null, 2),
        { need: 'areaName', areas: outcome.areas },
      );

    case 'buildings':
      return textResult(
        `「${outcome.areaName}」下的楼栋（buildingName）：\n` +
          JSON.stringify(outcome.buildings, null, 2),
        { areaName: outcome.areaName, buildings: outcome.buildings },
      );

    case 'rooms':
      return textResult(
        `「${outcome.areaName} / ${outcome.buildingName}」下的房间（roomId）：\n` +
          JSON.stringify(outcome.rooms, null, 2),
        { areaName: outcome.areaName, buildingName: outcome.buildingName, rooms: outcome.rooms },
      );

    case 'need-area':
      return textResult(
        '需要先确定校区。请先调用 action=get_areas 取得校区列表，带上 areaName 再调用一次。',
        { need: 'areaName', action: outcome.action },
      );

    case 'need-building':
      return textResult(
        `「${outcome.areaName}」下的楼栋如下，请带上 buildingName 再次调用：\n` +
          JSON.stringify(outcome.buildings, null, 2),
        { need: 'buildingName', areaName: outcome.areaName, buildings: outcome.buildings },
      );

    case 'need-room':
      return textResult(
        `「${outcome.areaName} / ${outcome.buildingName}」下的房间如下，请带上 roomId 再次调用：\n` +
          JSON.stringify(outcome.rooms, null, 2),
        {
          need: 'roomId',
          areaName: outcome.areaName,
          buildingName: outcome.buildingName,
          rooms: outcome.rooms,
        },
      );

    case 'need-amount':
      return textResult(
        `已定位到宿舍：${outcome.areaName} / ${outcome.buildingName} / ${outcome.roomName}。\n` +
          '充值会在学校一卡通平台创建真实订单并从校园卡扣款，请确认后再带上 amount（元）调用一次。',
        {
          need: 'amount',
          areaName: outcome.areaName,
          buildingName: outcome.buildingName,
          roomName: outcome.roomName,
        },
      );

    case 'need-confirmation': {
      const payload = {
        status: 'requires_confirmation',
        location: `${outcome.target.areaName} - ${outcome.target.buildingName} - ${outcome.roomName}`,
        areaName: outcome.target.areaName,
        buildingName: outcome.target.buildingName,
        roomName: outcome.roomName,
        roomId: outcome.target.roomId,
        amount: outcome.amount,
        unit: '元',
        payWayLabel: '校园卡扣款',
        card: {
          name: outcome.card.name,
          studentId: outcome.card.idserial,
          balance: outcome.card.balance,
        },
        confirmationToken: outcome.confirmationToken,
        expiresIn: '5分钟',
      };
      return textResult(
        `【重要确认】即将从校园卡扣款并为宿舍充值电费：\n` +
          `• 宿舍位置：${payload.location}\n` +
          `• 充值金额：${payload.amount} 元\n` +
          `• 扣款卡号：${payload.card.name}（学号 ${payload.card.studentId}，卡当前余额 ${payload.card.balance} 元）\n\n` +
          `⚠️ 该操作会产生真实扣款。请向用户明确确认上述信息！\n` +
          `用户确认后，请带上相同参数和 confirmationToken="${outcome.confirmationToken}" 再次调用以完成充值（令牌5分钟内有效）。`,
        payload,
      );
    }

    case 'balance': {
      const payload = {
        location: `${outcome.target.areaName} - ${outcome.target.buildingName} - ${outcome.roomName}`,
        areaName: outcome.target.areaName,
        buildingName: outcome.target.buildingName,
        roomName: outcome.roomName,
        roomId: outcome.target.roomId,
        mertype: outcome.target.mertype,
        balance: outcome.balance.balance,
        balanceYuan: `${outcome.balance.balance} 元`,
        accountName: outcome.balance.accname,
        detail: outcome.balance.detail,
        unit: '元',
        status: 'success',
      };
      return textResult(
        `${payload.location} 电费余额：${outcome.balance.balance} 元`,
        payload,
      );
    }

    case 'meter-abnormal':
      return textResult(
        `电表状态异常（elestatus=${String(outcome.balance.elestatus)}），暂时读不到可信余额，请稍后重试。\n` +
          JSON.stringify(
            {
              location: `${outcome.target.areaName} - ${outcome.target.buildingName} - ${outcome.roomName}`,
              elestatus: outcome.balance.elestatus,
              lastKnownBalance: outcome.balance.balance,
            },
            null,
            2,
          ),
        { status: 'meter_abnormal', elestatus: outcome.balance.elestatus },
      );

    case 'recharged': {
      const amountText = String(outcome.amount);
      const payload = {
        success: true,
        location: `${outcome.target.areaName} - ${outcome.target.buildingName} - ${outcome.roomName}`,
        areaName: outcome.target.areaName,
        buildingName: outcome.target.buildingName,
        roomName: outcome.roomName,
        roomId: outcome.target.roomId,
        mertype: outcome.target.mertype,
        amount: outcome.amount,
        unit: '元',
        payWay: '2',
        payWayLabel: '校园卡扣款',
        card: {
          name: outcome.card.name,
          studentId: outcome.card.idserial,
          balanceBeforeRecharge: outcome.card.balance,
        },
        order: outcome.order.resultData,
        serverMessage: outcome.order.message,
      };
      return textResult(
        `已在学校一卡通平台创建电费预支付订单：${payload.location}，金额 ${amountText} 元（从校园卡扣款）。\n` +
          '请到一卡通/电费页面确认订单状态，并以实际扣款结果为准。\n' +
          JSON.stringify(payload, null, 2),
        payload,
      );
    }
  }
}

/** 两个电费工具名共用同一份 schema。 */
const ELECTRICITY_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [...ELECTRICITY_ACTIONS],
      description:
        '操作类型：query_balance(查余额，默认)、recharge(充值，会产生真实订单并从校园卡扣款)、get_areas(校区列表)、get_buildings(楼栋列表)、get_rooms(房间列表)。',
      default: 'query_balance',
    },
    areaName: {
      type: 'string',
      description: '校区/公寓名称，取值来自 get_areas 返回的 areas[].name（例如「金岸公寓空调」）。',
    },
    buildingName: {
      type: 'string',
      description: '楼栋名称，取值来自 get_buildings 返回的 buildings[].name（例如「金岸1栋」）。',
    },
    roomId: {
      type: 'string',
      description:
        '房间号或房间ID，取值来自 get_rooms 返回的 rooms[].id（房号如「302」或 32 位哈希 ID）。',
    },
    roomName: {
      type: 'string',
      description: '可选的友好房间名（如「302室」）。不传时会用房间列表自动匹配出真实房号。',
    },
    mertype: {
      type: 'string',
      description: '电表类型（「yk」预付费表 / 「rt」实时表）。不传则由房间列表或默认值 yk 决定。',
    },
    amount: {
      type: 'number',
      description: '充值金额（元），action=recharge 时必填，须大于 0。金额会四舍五入到整数元后提交。',
    },
    confirmationToken: {
      type: 'string',
      description:
        '充值确认令牌。action=recharge 首次调用时无需传入，系统将生成确认详情与令牌；向用户二次确认后，带上此令牌再次调用才会真正发起校园卡扣款。',
    },
  },
  additionalProperties: false,
};

/**
 * 电费工具的唯一实现。`recharge_electricity` 与 `query_electricity`
 * 共用这个函数对象本身（不是复制一份），别名关系因此是可验证的。
 */
async function electricityHandler(
  args: Record<string, unknown>,
  toolContext: ToolContext,
): Promise<McpToolResult> {
  const action = readAction(args['action']);
  const areaName = readString(args['areaName']);
  const buildingName = readString(args['buildingName']);
  const roomId = readString(args['roomId']);
  const roomName = readString(args['roomName']);
  const mertype = readString(args['mertype']);
  const amount = readNumber(args['amount']);
  const confirmationToken = readString(args['confirmationToken']);

  const outcome = await runWithSession<ElectricityOutcome>(
    toolContext.env,
    toolContext.credentials,
    async (session) => {
      const ctx = await connectFinServ(session.session, { log: toolContext.log });

      if (action === 'get_areas') {
        return { kind: 'areas', areas: await fetchElectricAreas(ctx) };
      }
      if (areaName === '') {
        return { kind: 'need-area', action };
      }
      if (action === 'get_buildings') {
        return {
          kind: 'buildings',
          areaName,
          buildings: await fetchElectricBuildings(ctx, areaName),
        };
      }
      if (buildingName === '') {
        return {
          kind: 'need-building',
          action,
          areaName,
          buildings: await fetchElectricBuildings(ctx, areaName),
        };
      }
      if (action === 'get_rooms') {
        return {
          kind: 'rooms',
          areaName,
          buildingName,
          rooms: await fetchElectricRooms(ctx, areaName, buildingName),
        };
      }
      if (roomId === '') {
        return {
          kind: 'need-room',
          action,
          areaName,
          buildingName,
          rooms: await fetchElectricRooms(ctx, areaName, buildingName),
        };
      }

      const target = await resolveElectricityTarget(ctx, {
        areaName,
        buildingName,
        roomId,
        roomName,
        mertype,
      });

      if (action === 'recharge') {
        if (amount === null || amount <= 0) {
          return {
            kind: 'need-amount',
            areaName: target.areaName,
            buildingName: target.buildingName,
            roomName: displayRoomName(target),
          };
        }
        const roundedAmount = Math.round(amount);
        // 充值走校园卡扣款，idserial 只能从卡片信息里拿（Dart 也是这么做的）
        const card = await fetchCardInfo(ctx);
        const effectiveRoomName = displayRoomName(target);

        // 校验二次确认 Token
        const key = getEffectiveSessionKey(toolContext.env);
        let tokenValid = false;
        if (confirmationToken !== '') {
          try {
            const jsonStr = await open(confirmationToken, key);
            const tokenData = JSON.parse(jsonStr) as {
              type: string;
              areaName: string;
              buildingName: string;
              roomId: string;
              amount: number;
              idserial: string;
              exp: number;
            };

            if (
              tokenData.type === 'elec_recharge' &&
              tokenData.areaName === target.areaName &&
              tokenData.buildingName === target.buildingName &&
              tokenData.roomId === target.roomId &&
              tokenData.amount === roundedAmount &&
              tokenData.idserial === card.idserial &&
              tokenData.exp > Date.now()
            ) {
              tokenValid = true;
            }
          } catch {
            tokenValid = false;
          }
        }

        if (!tokenValid) {
          const newConfirmationToken = await seal(
            JSON.stringify({
              type: 'elec_recharge',
              areaName: target.areaName,
              buildingName: target.buildingName,
              roomId: target.roomId,
              amount: roundedAmount,
              idserial: card.idserial,
              exp: Date.now() + 5 * 60 * 1000,
            }),
            key,
          );
          return {
            kind: 'need-confirmation',
            target,
            roomName: effectiveRoomName,
            amount: roundedAmount,
            card,
            confirmationToken: newConfirmationToken,
          };
        }

        const order = await createElectricityPreOrder(ctx, target, card.idserial, roundedAmount);
        return {
          kind: 'recharged',
          target,
          roomName: effectiveRoomName,
          amount: roundedAmount,
          card,
          order,
        };
      }

      const balance = await fetchElectricBalance(ctx, target);
      let resolvedName = displayRoomName(target);
      if (resolvedName === '所选宿舍' || isHashedRoomName(target.roomName)) {
        const fromAccount = roomNameFromAccount(balance.accname);
        if (fromAccount !== '') resolvedName = fromAccount;
      }

      if (balance.elestatus !== null && balance.elestatus !== 1) {
        return { kind: 'meter-abnormal', target, balance, roomName: resolvedName };
      }
      return { kind: 'balance', target, balance, roomName: resolvedName };
    },
  );

  return renderElectricityOutcome(outcome);
}

function createElectricityTool(name: 'recharge_electricity' | 'query_electricity'): ToolDefinition {
  const description =
    name === 'recharge_electricity'
      ? '湖南农业大学宿舍电费余额查询与在线充值工具。' +
        '⚠️ action=recharge 会在学校一卡通平台创建【真实订单】并从校园卡扣款，属于资金操作。' +
        '为防止 AI 误触发扣款，本工具采用【两阶段确认】机制：首次调用 action=recharge 会返回需确认的宿舍、金额、卡信息及 confirmationToken；' +
        '向用户完成二次确认后，必须带上相同的参数及 confirmationToken 再次调用才会真正发起扣款。' +
        '不传 areaName / buildingName / roomId 时不会执行任何写操作，只返回可选列表供选择（两段式交互）；' +
        '也可以用 action=get_areas / get_buildings / get_rooms 主动逐级查询列表。' +
        '（别名 query_electricity 是同一实现，默认 action=query_balance。）'
      : '湖南农业大学宿舍电费余额查询工具（默认 action=query_balance，只读）。' +
        '与 recharge_electricity 是同一实现的别名：如需充值请显式传 action=recharge，那会在学校一卡通平台创建【真实订单】并从校园卡扣款（支持两阶段确认机制）。' +
        '不传 areaName / buildingName / roomId 时返回可选校区/楼栋/房间列表供选择。';

  return {
    name,
    description,
    inputSchema: ELECTRICITY_INPUT_SCHEMA,
    handler: electricityHandler,
  };
}

// ===========================================================================
// query_card_transactions / query_bill
// ===========================================================================

function renderTransactions(
  range: { beginDate: string; endDate: string; tradeLabel: string },
  records: CardTransaction[],
): ReturnType<typeof textResult> {
  const truncated = records.length > TRANSACTION_LIMIT;
  const shown = truncated ? records.slice(0, TRANSACTION_LIMIT) : records;
  const payload = {
    beginDate: range.beginDate,
    endDate: range.endDate,
    tradeType: range.tradeLabel,
    count: records.length,
    truncated,
    records: shown,
    unit: '元',
    status: 'success',
  };

  if (records.length === 0) {
    return textResult(
      `${range.beginDate} ~ ${range.endDate}（${range.tradeLabel}）没有校园卡流水。`,
      payload,
    );
  }

  return textResult(
    `${range.beginDate} ~ ${range.endDate}（${range.tradeLabel}）共 ${records.length} 条校园卡流水` +
      (truncated ? `，此处只列前 ${TRANSACTION_LIMIT} 条` : '') +
      '：\n' +
      JSON.stringify(shown, null, 2),
    payload,
  );
}

/** 两个流水工具名共用同一份 schema。 */
const TRANSACTION_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    beginDate: {
      type: 'string',
      description: '起始日期，格式 yyyy-MM-dd（例如 2026-09-15）。不填则默认为 6 天前。',
    },
    endDate: {
      type: 'string',
      description: '截止日期，格式 yyyy-MM-dd（例如 2026-09-22），不能超过今天。不填则默认为今天。',
    },
    tradeType: {
      type: 'string',
      enum: ['全部', '消费', '充值', '补助', '转账'],
      description: '流水类型，默认为「全部」。',
      default: '全部',
    },
  },
  additionalProperties: false,
};

/** 流水工具的唯一实现，`query_card_transactions` 与 `query_bill` 共用。 */
async function transactionsHandler(
  args: Record<string, unknown>,
  toolContext: ToolContext,
): Promise<McpToolResult> {
  const resolved = resolveTransactionRange({
    beginDate: readString(args['beginDate']),
    endDate: readString(args['endDate']),
    tradeType: readString(args['tradeType']),
  });
  if (!resolved.ok) {
    return textResult(resolved.message);
  }
  const range = resolved.range;

  const records = await runWithSession(
    toolContext.env,
    toolContext.credentials,
    async (session) => {
      const ctx = await connectFinServ(session.session, { log: toolContext.log });
      return await fetchCardTransactions(ctx, range);
    },
  );

  return renderTransactions(range, records);
}

function createTransactionTool(name: 'query_card_transactions' | 'query_bill'): ToolDefinition {
  const description =
    name === 'query_card_transactions'
      ? '湖南农业大学校园卡账单（消费流水）查询工具。按起止日期与流水类型查询校园卡的每一笔消费/充值/补助/转账记录，每条包含商户名称、金额与时间。起止间隔最长 31 天，截止日期不能超过今天；未指定日期时默认查询近 7 天（含今天）。'
      : '湖南农业大学校园卡账单（消费流水）查询工具，与 query_card_transactions 是同一实现的别名。按起止日期与流水类型查询消费/充值/补助/转账记录。起止间隔最长 31 天，截止日期不能超过今天；未指定日期时默认查询近 7 天（含今天）。';

  return {
    name,
    description,
    inputSchema: TRANSACTION_INPUT_SCHEMA,
    handler: transactionsHandler,
  };
}

// ===========================================================================
// 导出
// ===========================================================================

/**
 * 五个工具：三个实现 + 两个别名。
 * 别名共用同一 handler，只有 `name`（与描述）不同。
 */
export function createFinServTools(): ToolDefinition[] {
  return [
    createCampusCardBalanceTool(),
    createElectricityTool('recharge_electricity'),
    createElectricityTool('query_electricity'),
    createTransactionTool('query_card_transactions'),
    createTransactionTool('query_bill'),
  ];
}
