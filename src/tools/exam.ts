/**
 * MCP Tool: 考试日程与安排查询 (query_exams / query_exam_schedule)
 * 迁移至 api.chilleast.soilzhu.su/api/academic/exams。
 */

import { textResult } from '../mcp/protocol';
import type { McpToolResult } from '../mcp/protocol';
import type { ToolContext, ToolDefinition } from '../mcp/registry';
import { callRelayApi } from '../api/client';
import { isCurrentSemester } from '../school/hunau/chaoxing-study';

const EXAM_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    currentSemesterOnly: {
      type: 'boolean',
      description: '是否仅查询本学期的考试。默认为 true。',
      default: true,
    },
    keyword: {
      type: 'string',
      description: '按考试名称关键词进行模糊搜索。',
    },
    forceRefresh: {
      type: 'boolean',
      description:
        '是否重新抓取最新考试数据。服务端每次调用都是实时抓取，本参数仅为兼容 ChillEast 而保留。',
      default: false,
    },
  },
  additionalProperties: false,
} as const;

export function createExamTools(): ToolDefinition[] {
  const handler = async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<McpToolResult> => {
    const currentSemesterOnly = args['currentSemesterOnly'] !== false;
    const keyword = typeof args['keyword'] === 'string' ? args['keyword'].trim() : '';

    const query = new URLSearchParams({
      ...(keyword ? { keyword } : {}),
    }).toString();

    const rawList = await callRelayApi<any[]>(
      ctx,
      `/api/academic/exams${query ? `?${query}` : ''}`,
    );

    let exams = Array.isArray(rawList) ? rawList : [];

    const nowMs = Date.now();
    if (currentSemesterOnly) {
      exams = exams.filter((exam) => {
        const timeMs = typeof exam.timeMs === 'number'
          ? exam.timeMs
          : exam.time ? new Date(exam.time).getTime() : nowMs;
        return isCurrentSemester(timeMs, nowMs);
      });
    }

    if (exams.length === 0) {
      const hint =
        keyword !== ''
          ? `没有找到匹配关键词 "${keyword}" 的考试。`
          : currentSemesterOnly
            ? '本学期暂无考试日程（超星系统中未查询到相关科目安排）。'
            : '未查询到任何考试日程。';
      return textResult(hint, { count: 0, exams: [] });
    }

    return textResult(`共 ${exams.length} 门考试：\n${JSON.stringify(exams, null, 2)}`, {
      count: exams.length,
      currentSemesterOnly,
      keyword: keyword === '' ? null : keyword,
      exams,
    });
  };

  const makeTool = (name: string): ToolDefinition => ({
    name,
    description:
      '查询学生的考试日程与考场安排（实时从超星学习通抓取）。默认仅查本学期；可传 keyword 过滤；返回考试名称、科目、时间与状态。',
    inputSchema: EXAM_INPUT_SCHEMA,
    handler,
  });

  return [makeTool('query_exams'), makeTool('query_exam_schedule')];
}
