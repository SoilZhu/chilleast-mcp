/**
 * 空教室查询 —— 走融合门户会话（FUSION Cookie），不需要超星侧凭据。
 * 对齐 ChillEast `ClassroomService`。
 */

import { textResult } from '../mcp/protocol';
import type { ToolContext, ToolDefinition } from '../mcp/registry';
import {
  SessionExpiredError,
  runWithSession,
  type SessionContext,
} from '../auth/session-manager';
import { DESKTOP_UA, URLS } from '../school/hunau/constants';

/** 用 HTMLRewriter 抓某个选择器下每个元素的文本。 */
async function collectText(html: string, selector: string): Promise<string[]> {
  // workerd 实测坑：`HTMLRewriter.transform().text()` 对**空响应体**永远不会
  // resolve（会一直挂到超时）。空输入本来也没有可解析的内容，直接短路。

  if (html.trim() === '') return [];

  const results: string[] = [];
  let buffer: string | null = null;
  await new HTMLRewriter()
    .on(selector, {
      element(element) {
        buffer = '';
        element.onEndTag(() => {
          results.push((buffer ?? '').trim());
          buffer = null;
        });
      },
      text(chunk) {
        if (buffer !== null) buffer += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();
  return results;
}

/** 抓每个元素的文本 + 指定属性。 */
async function collectWithAttribute(
  html: string,
  selector: string,
  attribute: string,
): Promise<Array<{ text: string; value: string }>> {
  // workerd 实测坑：`HTMLRewriter.transform().text()` 对**空响应体**永远不会
  // resolve（会一直挂到超时）。空输入本来也没有可解析的内容，直接短路。

  if (html.trim() === '') return [];

  const results: Array<{ text: string; value: string }> = [];
  let buffer: string | null = null;
  let current: { text: string; value: string } | null = null;
  await new HTMLRewriter()
    .on(selector, {
      element(element) {
        buffer = '';
        current = { text: '', value: element.getAttribute(attribute) ?? '' };
        const entry = current;
        element.onEndTag(() => {
          entry.text = (buffer ?? '').trim();
          results.push(entry);
          buffer = null;
          current = null;
        });
      },
      text(chunk) {
        if (buffer !== null) buffer += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();
  return results.filter((entry) => entry.text !== '');
}

interface ClassroomOptions {
  buildings: string[];
  sections: string[];
  weeks: string[];
  days: Array<{ label: string; value: string }>;
}

async function fetchOptions(context: SessionContext): Promise<ClassroomOptions> {
  const response = await context.session.get(URLS.portalClassroomIndex, {
    headers: {
      'User-Agent': DESKTOP_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  if (response.status !== 200) {
    throw new Error(`获取查询条件失败（HTTP ${response.status}）`);
  }
  const html = response.body;
  if (html.includes('CIMS.init') || /<input\b[^>]*type\s*=\s*["']?password/i.test(html)) {
    // 会话失效，交给外层重登
    throw new SessionExpiredError('融合门户会话已失效');
  }

  return {
    buildings: await collectText(html, '#jxlCondition a'),
    sections: await collectText(html, '#jcCondition a'),
    weeks: await collectText(html, '#zcCondition a'),
    days: (await collectWithAttribute(html, '#weekCondition a', 'data-value')).map(
      (entry) => ({ label: entry.text, value: entry.value }),
    ),
  };
}

interface ClassroomRow {
  [key: string]: unknown;
}

async function queryClassrooms(
  context: SessionContext,
  params: { building: string; week: string; section: string; day: string },
): Promise<ClassroomRow[]> {
  const query = new URLSearchParams({
    jxl: params.building,
    // 接口参数名反直觉：week 传的是星期几，zc 传的是第几周
    week: params.day,
    jc: params.section,
    zc: params.week,
  });
  const response = await context.session.get(`${URLS.portalClassroomQuery}?${query}`, {
    headers: {
      'User-Agent': DESKTOP_UA,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: URLS.portalClassroomIndex,
    },
  });
  if (response.status !== 200) {
    throw new Error(`空教室查询失败（HTTP ${response.status}）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new SessionExpiredError('空教室查询返回了非 JSON 内容（会话可能已失效）');
  }
  const data = (parsed as { data?: unknown }).data;
  return Array.isArray(data) ? (data as ClassroomRow[]) : [];
}

export function createClassroomTool(): ToolDefinition {
  return {
    name: 'query_empty_classrooms',
    description:
      '查询湖南农业大学空闲教室。不传任何参数时返回可选的教学楼、节次、周次、星期列表；' +
      '带上 building / week / section / day 四个参数则返回该条件下的空闲教室。',
    inputSchema: {
      type: 'object',
      properties: {
        building: {
          type: 'string',
          description: '教学楼名称，取值来自上一次不带参数调用的 buildings 列表。',
        },
        week: {
          type: 'string',
          description: '第几周（对应接口的 zc 参数），取值来自 weeks 列表。',
        },
        section: {
          type: 'string',
          description: '节次，取值来自 sections 列表，例如「第一大节」。',
        },
        day: {
          type: 'string',
          description: '星期几，取值来自 days 列表的 value 字段，例如「1」表示周一。',
        },
      },
      additionalProperties: false,
    },
    async handler(args, toolContext: ToolContext) {
      const building = typeof args['building'] === 'string' ? args['building'] : '';
      const week = typeof args['week'] === 'string' ? args['week'] : '';
      const section = typeof args['section'] === 'string' ? args['section'] : '';
      const day = typeof args['day'] === 'string' ? args['day'] : '';

      const result = await runWithSession(toolContext.env, toolContext.credentials, async (ctx) => {
        if (building === '' || week === '' || section === '' || day === '') {
          return { kind: 'options' as const, options: await fetchOptions(ctx) };
        }
        return {
          kind: 'rows' as const,
          rows: await queryClassrooms(ctx, { building, week, section, day }),
        };
      });

      if (result.kind === 'options') {
        return textResult(
          '请从下列取值中挑选 building / week / section / day 后再次调用：\n' +
            JSON.stringify(result.options, null, 2),
          result.options,
        );
      }
      if (result.rows.length === 0) {
        return textResult('该条件下没有空闲教室。');
      }
      return textResult(
        `共 ${result.rows.length} 条空闲教室记录：\n` +
          JSON.stringify(result.rows, null, 2),
        { count: result.rows.length, rows: result.rows },
      );
    },
  };
}
