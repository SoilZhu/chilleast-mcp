/**
 * 移动教务工具：课表查询、成绩查询。
 *
 * 这两个工具是 ChillEast 里唯二依赖 HeadlessInAppWebView 的功能。
 * 这里改走纯 HTTP 登录（见 `school/hunau/ydjwxt.ts` 的说明），
 * 因此不再需要浏览器，也不再依赖设备上的本地缓存 —— 每次都拉实时数据。
 */

import { textResult } from '../mcp/protocol';
import type { ToolContext, ToolDefinition } from '../mcp/registry';
import { runWithSession } from '../auth/session-manager';
import { loadTimetableRules } from './local-data';
import { applyTimetableRules, parseWeeks, referencedWeeks } from '../school/hunau/timetable-rules';
import {
  fetchScores,
  fetchSemesters,
  fetchTimetableWeek,
  loginYdjwxt,
  type TimetableWeek,
} from '../school/hunau/ydjwxt';

/**
 * 学期字段的候选键名。`semesterList` 的真实返回结构没有实测样本，
 * 所以这里按"教务系统常见的几种叫法"全试一遍，而不是只认一个。
 */
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
 *
 * 真实结构未知，所以做三层兜底：
 *   1. 顶层就是数组（元素可能是对象，也可能直接是字符串）
 *   2. 顶层是对象，但某个字段里藏着数组（list/rows/data/items/...）
 *   3. 都套不上就返回空，由调用方把原始响应吐给用户
 */
export function normalizeSemesters(data: unknown): Array<{ semester: string; name: string }> {
  const candidates = collectArrayCandidates(data, 0);
  for (const rows of candidates) {
    const normalized = rows
      .map((row) => {
        if (typeof row === 'string' && row !== '') {
          // 形如 ["2025-2026-2", ...] 这种纯字符串数组
          return { semester: row, name: row };
        }
        if (typeof row !== 'object' || row === null) return null;
        const record = row as Record<string, unknown>;
        const semester = pickString(record, SEMESTER_ID_KEYS);
        const name = pickString(record, SEMESTER_NAME_KEYS);
        // 至少要能被当成学期标识才收
        if (semester === '' && name === '') return null;
        return { semester: semester === '' ? name : semester, name: name === '' ? semester : name };
      })
      .filter((item): item is { semester: string; name: string } => item !== null);

    if (normalized.length > 0) return normalized;
  }
  return [];
}

/** 递归找出候选数组（广度优先，深度有限，避免在大对象里乱翻）。 */
function collectArrayCandidates(data: unknown, depth: number): Array<Array<unknown>> {
  if (depth > 3) return [];
  if (Array.isArray(data)) {
    // 元素是对象的数组优先当作数据行
    const hasObjects = data.some((item) => typeof item === 'object' && item !== null);
    return hasObjects || data.length > 0 ? [data] : [];
  }
  if (typeof data !== 'object' || data === null) return [];

  const preferred = ['list', 'rows', 'data', 'items', 'aaData', 'result', 'xqList', 'semesters'];
  const record = data as Record<string, unknown>;
  const found: Array<Array<unknown>> = [];
  for (const key of preferred) {
    if (key in record) found.push(...collectArrayCandidates(record[key], depth + 1));
  }
  for (const [key, value] of Object.entries(record)) {
    if (preferred.includes(key)) continue;
    if (Array.isArray(value)) found.push(...collectArrayCandidates(value, depth + 1));
  }
  return found;
}

/** 原始响应的摘要，用于"解析不出来"时把真相交给用户。 */
function summarizeRaw(data: unknown, max = 1500): string {
  let text: string;
  try {
    text = JSON.stringify(data, null, 2) ?? String(data);
  } catch {
    text = String(data);
  }
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断）`;
}

/** 从第 1 周的日期表反推当前是第几周。 */
function deriveCurrentWeek(week: TimetableWeek, today = new Date()): number {
  const monday = week.dates.find((entry) => entry.weekday === '1') ?? week.dates[0];
  if (monday === undefined || monday.date === '') return 1;

  const firstMonday = new Date(`${monday.date}T00:00:00Z`);
  if (Number.isNaN(firstMonday.getTime())) return 1;

  const startOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const days = Math.floor((startOfToday - firstMonday.getTime()) / 86_400_000);
  return Math.min(Math.max(Math.floor(days / 7) + 1, 1), 20);
}

const WEEKDAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function renderWeek(week: TimetableWeek): string {
  if (week.courses.length === 0) {
    return `第 ${week.week} 周没有课程（可能该周放假，或周次超出学期范围）。`;
  }
  // 按天、再按节次排序，方便阅读
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

      // 教务系统的登录要先用统一认证的 TGC 换票，所以必须跑在会话里
      return await runWithSession(
        toolContext.env,
        toolContext.credentials,
        async (context) => {
          const auth = await loginYdjwxt(
            context.session,
            toolContext.credentials.oaId,
            toolContext.credentials.oaKey,
          );

          let week: TimetableWeek;
          if (requested !== undefined) {
            week = await fetchTimetableWeek(auth, requested);
          } else {
            // 先拉第 1 周拿到学期日期表，据此推算当前周，再拉那一周
            const first = await fetchTimetableWeek(auth, 1);
            const current = deriveCurrentWeek(first);
            week = current === 1 ? first : await fetchTimetableWeek(auth, current);
          }

          // 应用用户设置的课表调整（调课/停课/加课）。
          // 规则存在云端备份里，与手机 App 共用同一份。
          const { rules, note } = await loadTimetableRules(toolContext.env, toolContext.credentials);
          if (rules.length > 0) {
            // 调课会把课程从源周搬到目标周，所以源周的数据也得拉下来
            const extraWeeks = referencedWeeks(rules).filter(
              (candidate) => candidate !== week.week && candidate >= 1 && candidate <= 20,
            );
            const extra = await Promise.all(
              extraWeeks.map((candidate) => fetchTimetableWeek(auth, candidate)),
            );

            // 合并去重后统一应用规则，最后只留落在查询周里的课
            const merged = [...extra.flatMap((item) => item.courses), ...week.courses];
            const unique = new Map<string, (typeof merged)[number]>();
            for (const course of merged) {
              unique.set(
                `${course.name}|${course.teacher}|${course.classroom}|${course.dayOfWeek}|${course.startPeriod}|${course.weeks}`,
                course,
              );
            }
            const applied = applyTimetableRules([...unique.values()], rules);
            week = {
              ...week,
              courses: applied.filter((course) => parseWeeks(course.weeks).includes(week.week)),
            };
          }

          const rendered = renderWeek(week);
          return textResult(note === null ? rendered : `${rendered}\n\n（${note}）`, {
            week: week.week,
            courses: week.courses,
            dates: week.dates,
            appliedRules: rules.length,
          });
        },
      );
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

      return await runWithSession(
        toolContext.env,
        toolContext.credentials,
        async (context) => {
          const auth = await loginYdjwxt(
            context.session,
            toolContext.credentials.oaId,
            toolContext.credentials.oaKey,
          );
          const rawSemesters = await fetchSemesters(auth);
          const semesters = normalizeSemesters(rawSemesters);

          if (semester === '') {
            if (semesters.length === 0) {
              // 解析不出来时把原始响应交出去 —— 让用户能直接看到真相，
              // 而不是收到一句"没有取到学期列表"然后两边都靠猜。
              return textResult(
                '没能从学期列表响应里认出学期字段。你仍然可以直接用已知的学期标识调用，' +
                  '例如 query_scores 传 semester="2025-2026-2"。\n' +
                  '原始响应如下（把它发我即可适配）：\n' +
                  summarizeRaw(rawSemesters),
                { rawSemesters },
              );
            }
            return textResult(
              `共 ${semesters.length} 个学期，请挑一个再用 semester 参数重新调用：\n` +
                JSON.stringify(semesters, null, 2),
              { semesters },
            );
          }

          const scores = await fetchScores(auth, semester);
          const empty =
            scores === null ||
            scores === undefined ||
            (Array.isArray(scores) && scores.length === 0) ||
            (typeof scores === 'object' && !Array.isArray(scores) && Object.keys(scores).length === 0);

          if (empty) {
            // 成绩为空也可能是学期标识不对，把原始响应带上便于判断
            return textResult(
              `${semester} 学期没有返回成绩数据。可能是该学期无成绩，也可能是学期标识不对。\n` +
                `原始响应：\n${summarizeRaw(scores)}`,
              { semester, scores },
            );
          }
          return textResult(
            `${semester} 学期成绩：\n${JSON.stringify(scores, null, 2)}`,
            { semester, scores },
          );
        },
      );
    },
  };

  return [timetableTool, scoreTool];
}
