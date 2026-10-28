/**
 * 移动教务工具：课表查询、成绩查询。
 * 迁移至 api.chilleast.soilzhu.su/api/academic/*。
 */

import { textResult } from '../mcp/protocol';
import type { ToolContext, ToolDefinition } from '../mcp/registry';
import { callRelayApi } from '../api/client';
import type { TimetableWeek } from '../school/hunau/ydjwxt';

const SEMESTER_ID_KEYS = [
  'semester',
  'semesterId',
  'semesterid',
  'xqid',
  'xqId',
  'dm',
  'id',
  'value',
  'code',
  'xnxq',
  'xnxqid',
] as const;

const SEMESTER_NAME_KEYS = [
  'semesterName',
  'semestername',
  'xqmc',
  'xqMc',
  'mc',
  'name',
  'label',
  'text',
  'title',
  'xnxqmc',
] as const;

function pickString(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number') return String(value);
  }
  return '';
}

/**
 * 把学期列表归一成 {semester, name}。
 */
export function normalizeSemesters(data: unknown): Array<{ semester: string; name: string }> {
  const candidates = collectArrayCandidates(data, 0);
  for (const rows of candidates) {
    const normalized = rows
      .map((row) => {
        if (typeof row === 'string' && row !== '') {
          return { semester: row, name: row };
        }
        if (typeof row !== 'object' || row === null) return null;
        const record = row as Record<string, unknown>;
        const semester = pickString(record, SEMESTER_ID_KEYS);
        const name = pickString(record, SEMESTER_NAME_KEYS);
        if (semester === '' && name === '') return null;
        return { semester: semester === '' ? name : semester, name: name === '' ? semester : name };
      })
      .filter((item): item is { semester: string; name: string } => item !== null);

    if (normalized.length > 0) return normalized;
  }
  return [];
}

function collectArrayCandidates(data: unknown, depth: number): Array<Array<unknown>> {
  if (depth > 3) return [];
  if (Array.isArray(data)) {
    const hasObjects = data.some((item) => typeof item === 'object' && item !== null);
    return hasObjects || data.length > 0 ? [data] : [];
  }
  if (typeof data !== 'object' || data === null) return [];

  const found: Array<Array<unknown>> = [];
  for (const value of Object.values(data as Record<string, unknown>)) {
    found.push(...collectArrayCandidates(value, depth + 1));
  }
  return found;
}

const WEEKDAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function renderWeek(week: TimetableWeek): string {
  if (!week || !week.courses || week.courses.length === 0) {
    return `第 ${week?.week ?? '未知'} 周没有课程（可能该周放假，或周次超出学期范围）。`;
  }
  const sorted = [...week.courses].sort(
    (a, b) => a.dayOfWeek - b.dayOfWeek || a.startPeriod - b.startPeriod,
  );
  const lines = sorted.map((course) => {
    const parts = [
      `${WEEKDAY_NAMES[course.dayOfWeek] ?? `周${course.dayOfWeek}`}`,
      course.periods === '' ? '节次未知' : `第 ${course.periods} 节`,
      course.name,
    ];
    if (course.teacher !== '') parts.push(`教师 ${course.teacher}`);
    if (course.classroom !== '') parts.push(`@ ${course.classroom}`);
    if (course.weeks !== '(周)') parts.push(`[${course.weeks}]`);
    return `- ${parts.join(' | ')}`;
  });
  return `第 ${week.week} 周共 ${sorted.length} 门次课程：\n${lines.join('\n')}`;
}

export function createYdjwxtTools(): ToolDefinition[] {
  const timetableTool: ToolDefinition = {
    name: 'query_timetable',
    description:
      '查询本人实时课表（来自移动教务系统，非本地缓存）。可不传参数，默认返回当前周的课程；' +
      '也可指定 week 查某一周（1-20）。',
    inputSchema: {
      type: 'object',
      properties: {
        week: {
          type: 'integer',
          description: '要查询的周次（1-20）。不传则按学期起始日期推算当前周。',
          minimum: 1,
          maximum: 20,
        },
      },
      additionalProperties: false,
    },
    async handler(args, toolContext: ToolContext) {
      const requested = typeof args['week'] === 'number' ? args['week'] : undefined;

      const data = await callRelayApi<any>(toolContext, '/api/academic/timetable?full=true');
      let week: TimetableWeek;
      if (data?.weeks) {
        const targetWeekNum = requested ?? data.currentWeek ?? 1;
        week = data.weeks[targetWeekNum] ?? {
          week: targetWeekNum,
          dates: [],
          courses: [],
        };
      } else if (data?.courses) {
        week = data as TimetableWeek;
      } else {
        week = {
          week: requested ?? 1,
          dates: [],
          courses: [],
        };
      }

      const note = data?.backup?.found ? `云端调课规则已生效（共 ${data.rulesApplied ?? 0} 条）` : null;
      const rendered = renderWeek(week);
      return textResult(note === null ? rendered : `${rendered}\n\n（${note}）`, {
        week: week.week,
        courses: week.courses,
        dates: week.dates,
        appliedRules: data?.rulesApplied ?? 0,
      });
    },
  };

  const scoreTool: ToolDefinition = {
    name: 'query_scores',
    description:
      '查询本人实时成绩（来自移动教务系统）。不传 semester 时返回可选学期列表；' +
      '传入 semester 后返回该学期各科成绩与绩点。',
    inputSchema: {
      type: 'object',
      properties: {
        semester: {
          type: 'string',
          description:
            '学期标识，取值来自不传参数时返回的 semesters 列表（例如 2025-2026-2）。',
        },
      },
      additionalProperties: false,
    },
    async handler(args, toolContext: ToolContext) {
      const semester = typeof args['semester'] === 'string' ? args['semester'].trim() : '';

      if (semester === '') {
        const rawSemesters = await callRelayApi<any>(toolContext, '/api/academic/semesters');
        const semesters = normalizeSemesters(rawSemesters);

        if (semesters.length === 0) {
          return textResult(
            '没能从学期列表响应里认出学期字段。你仍然可以直接用已知的学期标识调用，' +
              '例如 query_scores 传 semester="2025-2026-2"。\n' +
              '原始响应如下：\n' +
              JSON.stringify(rawSemesters, null, 2),
            { rawSemesters },
          );
        }
        return textResult(
          `共 ${semesters.length} 个学期，请挑一个再用 semester 参数重新调用：\n` +
            JSON.stringify(semesters, null, 2),
          { semesters },
        );
      }

      const res = await callRelayApi<any>(
        toolContext,
        `/api/academic/scores?semester=${encodeURIComponent(semester)}`,
      );
      const scores = res?.courses ?? res?.list ?? res?.raw ?? res;
      const empty =
        scores === null ||
        scores === undefined ||
        (Array.isArray(scores) && scores.length === 0) ||
        (typeof scores === 'object' && !Array.isArray(scores) && Object.keys(scores).length === 0);

      if (empty) {
        return textResult(
          `${semester} 学期没有返回成绩数据。可能是该学期无成绩，也可能是学期标识不对。\n` +
            `原始响应：\n${JSON.stringify(res, null, 2)}`,
          { semester, scores: res },
        );
      }
      return textResult(
        `${semester} 学期成绩：\n${JSON.stringify(scores, null, 2)}`,
        { semester, scores },
      );
    },
  };

  return [timetableTool, scoreTool];
}
