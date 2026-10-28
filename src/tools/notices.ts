/**
 * 超星通知查询 —— 迁移至 api.chilleast.soilzhu.su/api/campus/notices*。
 * 对齐 ChillEast `NoticeService`。
 */

import { textResult } from '../mcp/protocol';
import type { ToolContext, ToolDefinition } from '../mcp/registry';
import { SessionExpiredError } from '../auth/session-manager';
import { callRelayApi } from '../api/client';

export interface RawNotice {
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
      // 忽略
    }
  }
  return '(无标题)';
}

function optionalCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
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
    ...(rawCountAll === null ? {} : { recipientCount: rawCountAll }),
    ...(rawCountRead === null ? {} : { readCount: rawCountRead }),
  };
}

export function parseJsonOrExpire(body: string): Record<string, unknown> {
  const trimmed = body.trim();
  if (trimmed.startsWith('<')) {
    throw new SessionExpiredError('超星会话已失效（返回了 HTML 而不是 JSON）');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new SessionExpiredError('超星接口返回了无法解析的响应体');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SessionExpiredError('超星接口返回了畸形响应体');
  }
  const record = parsed as Record<string, unknown>;
  const msg = typeof record['msg'] === 'string' ? record['msg'] : '';
  if (msg.includes('未登录') || msg.includes('重新登录') || msg.includes('登陆')) {
    throw new SessionExpiredError(`超星会话已失效（接口提示：${msg}）`);
  }
  return record;
}

export function createNoticeTools(): ToolDefinition[] {
  const listTool: ToolDefinition = {
    name: 'query_notices',
    description:
      '查询学生的超星/学习通通知公告列表。支持按页游标 lastValue 继续翻页（第一页传空串）；' +
      '支持按关键词与年份过滤。返回通知标题、发送人、发送时间与未读状态。',
    inputSchema: {
      type: 'object',
      properties: {
        lastValue: {
          type: 'string',
          description:
            '翻页游标：上一页结果里的 nextLastValue。查第一页时传空字符串或不传。',
          default: '',
        },
        keyword: {
          type: 'string',
          description: '按标题或正文关键词搜索通知。',
        },
        year: {
          type: 'integer',
          description: '按年份过滤通知，默认为当前自然年。',
        },
      },
      additionalProperties: false,
    },
    async handler(args, toolContext: ToolContext) {
      const lastValue = typeof args['lastValue'] === 'string' ? args['lastValue'] : '';
      const keyword = typeof args['keyword'] === 'string' ? args['keyword'] : '';

      const query = new URLSearchParams({ lastValue }).toString();
      const res = await callRelayApi<any>(toolContext, `/api/campus/notices?${query}`);

      const rawList: any[] = Array.isArray(res?.list)
        ? res.list
        : Array.isArray(res)
          ? res
          : [];

      let messages = rawList.map((item) => {
        if (item.uuid && item.sentAt && item.sender !== undefined) {
          return item;
        }
        return normalizeNotice(item);
      });

      if (keyword.trim()) {
        const kw = keyword.toLowerCase();
        messages = messages.filter(
          (m) =>
            String(m.title || '').toLowerCase().includes(kw) ||
            String(m.content || '').toLowerCase().includes(kw),
        );
      }

      const nextLastValue = res?.lastGetId ?? null;

      return textResult(
        `共 ${messages.length} 条通知：\n` +
          JSON.stringify(messages, null, 2) +
          (nextLastValue ? `\n\n下一页请传 lastValue=${String(nextLastValue)}` : ''),
        { count: messages.length, messages, nextLastValue },
      );
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

      const data = await callRelayApi<any>(
        toolContext,
        `/api/campus/notices/detail?uuid=${encodeURIComponent(uuid)}`,
      );
      return textResult(JSON.stringify(data, null, 2), data);
    },
  };

  return [listTool, detailTool];
}
