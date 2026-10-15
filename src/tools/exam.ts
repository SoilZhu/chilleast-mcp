/**
 * MCP Tool: 考试日程与安排查询 (query_exams / query_exam_schedule)
 *
 * 对齐 ChillEast `lib/core/mcp/tools/exam_tool.dart`：
 * 同一份实现注册两个工具名（`query_exam_schedule` 是 `query_exams` 的别名），
 * 行为完全一致。数据实时来自超星 mooc1-api，不做本地缓存。
 */

import { textResult } from '../mcp/protocol';
import type { McpToolResult } from '../mcp/protocol';
import type { ToolContext, ToolDefinition } from '../mcp/registry';
import { runWithSession } from '../auth/session-manager';
import {
  fetchExamSchedules,
  isCurrentSemester,
  type ExamFetchResult,
  type ExamSchedule,
} from '../school/hunau/chaoxing-study';
import { formatBeijing, toIsoUtc } from '../school/hunau/time';

/** 考试列表页参数 Schema —— 与 Dart 的 inputSchema 一致。 */
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

interface ExamJson extends Record<string, unknown> {
  id: string;
  title: string;
  courseName: string;
  time: string;
  timeLocal: string;
  status: string;
  isPast: boolean;
  studentName: string;
  studentId: string;
  detailUrl: string;
}

function examToJson(exam: ExamSchedule, nowMs: number): ExamJson {
  const isPast = exam.timeMs < nowMs;
  return {
    id: exam.id,
    title: exam.title,
    courseName: exam.courseName,
    time: toIsoUtc(exam.timeMs),
    timeLocal: formatBeijing(exam.timeMs),
    // Dart: e.status.isNotEmpty ? e.status : (isPast ? '已结束' : '待考')
    status: exam.status !== '' ? exam.status : isPast ? '已结束' : '待考',
    isPast,
    studentName: exam.studentName,
    studentId: exam.studentId,
    detailUrl: exam.detailUrl,
    allTimes: exam.allTimesMs.map((ms) => formatBeijing(ms)),
    rawTimeStrs: exam.rawTimeStrs,
  };
}

export function createExamTools(): ToolDefinition[] {
  // 与 ChillEast 一样：同一个实现注册两个工具名（别名行为必须完全一致）
  const handler = async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<McpToolResult> => {
    const currentSemesterOnly = args['currentSemesterOnly'] !== false;
    const keyword = typeof args['keyword'] === 'string' ? args['keyword'].trim() : '';

    const fetched: ExamFetchResult = await runWithSession(
      ctx.env,
      ctx.credentials,
      async (context) => fetchExamSchedules(context.session),
    );

    const nowMs = Date.now();
    let exams = fetched.exams;

    if (currentSemesterOnly) {
      exams = exams.filter((exam) => isCurrentSemester(exam.timeMs, nowMs));
    }
    if (keyword !== '') {
      const lowered = keyword.toLowerCase();
      exams = exams.filter(
        (exam) =>
          exam.title.toLowerCase().includes(lowered) ||
          exam.courseName.toLowerCase().includes(lowered),
      );
    }

    const sorted = [...exams].sort((a, b) => a.timeMs - b.timeMs);
    const examList = sorted.map((exam) => examToJson(exam, nowMs));

    const semesterDesc = currentSemesterOnly ? '（本学期）' : '（全量）';
    return textResult(
      examList.length === 0
        ? `没有查询到考试${semesterDesc}。`
        : `共查询到 ${examList.length} 门考试${semesterDesc}：\n` + JSON.stringify(examList, null, 2),
      {
        summary: `共查询到 ${examList.length} 门考试${semesterDesc}`,
        total: examList.length,
        currentSemesterOnly,
        exams: examList,
        // 列表里有、但详情页没解析出时间的考试（不静默丢弃）
        unresolved: fetched.unresolved,
      },
    );
  };

  const makeTool = (name: string): ToolDefinition => ({
    name,
    description:
      '查询学生的超星/学习通考试日程与考试安排。支持按本学期筛选、关键词搜索；' +
      '每场考试会读取详情页解析考试时间、姓名与学号。',
    inputSchema: EXAM_INPUT_SCHEMA,
    handler,
  });

  return [makeTool('query_exams'), makeTool('query_exam_schedule')];
}
