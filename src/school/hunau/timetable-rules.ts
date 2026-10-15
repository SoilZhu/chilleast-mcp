/**
 * 课表调整规则的纯逻辑（调课 / 停课 / 加课）。
 *
 * 规则语义照搬 ChillEast `lib/features/timetable/services/timetable_rule_service.dart`：
 *   执行顺序强制为 **自定义加课 -> 调课 -> 停课**，
 *   这样即使先加停课再加调课，也能先定位并搬走课程，再执行停课。
 *
 * 这个文件只做计算，不碰存储 —— 规则的持久化交给云盘备份层
 * （`src/school/hunau/backup.ts`），与手机 App 共用同一份数据。
 */

import type { TimetableCourse } from './ydjwxt';

export type RuleType = 'reschedule' | 'suspension' | 'customCourse';

export interface TimetableRule {
  id: string;
  type: RuleType;
  description: string;
  createdAt: string;
  data: Record<string, unknown>;
}

const WEEKDAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export function weekdayName(day: number): string {
  return WEEKDAY_NAMES[day] ?? `周${day}`;
}

// ---- 周次字符串 <-> 周次数组（与客户端 WeekParser 一致） ----

/** "1-10(周)" / "1,3,5(周)" / "1-10,12-14(周)" -> [1,2,…] */
export function parseWeeks(weekString: string): number[] {
  const cleaned = weekString.replace(/\(周\)/g, '').replace(/\s+/g, '').trim();
  if (cleaned === '') return [];

  const weeks = new Set<number>();
  for (const rawPart of cleaned.split(',')) {
    const part = rawPart.trim();
    if (part === '') continue;

    if (part.includes('-')) {
      const bounds = part.split('-');
      if (bounds.length !== 2) continue;
      let start = Number.parseInt(bounds[0], 10);
      let end = Number.parseInt(bounds[1], 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (start > end) [start, end] = [end, start];
      for (let week = start; week <= end; week++) weeks.add(week);
    } else {
      const value = Number.parseInt(part, 10);
      if (Number.isFinite(value)) weeks.add(value);
    }
  }
  return [...weeks].sort((a, b) => a - b);
}

/** [1,2,3,5] -> "1-3,5(周)" */
export function formatWeeks(weeks: readonly number[]): string {
  const sorted = [...new Set(weeks)].filter((w) => Number.isFinite(w)).sort((a, b) => a - b);
  if (sorted.length === 0) return '(周)';

  const parts: string[] = [];
  let rangeStart = sorted[0];
  let previous = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const current = sorted[i];
    if (current !== undefined && current === previous + 1) {
      previous = current;
      continue;
    }
    parts.push(rangeStart === previous ? `${rangeStart}` : `${rangeStart}-${previous}`);
    if (current !== undefined) {
      rangeStart = current;
      previous = current;
    }
  }
  return `${parts.join(',')}(周)`;
}

function courseWeeks(course: TimetableCourse): number[] {
  return parseWeeks(course.weeks);
}

function withWeeks(course: TimetableCourse, weeks: readonly number[]): TimetableCourse {
  return { ...course, weeks: formatWeeks(weeks) };
}

// ---- 三类规则 ----

function applyCustomCourse(courses: TimetableCourse[], rule: TimetableRule): TimetableCourse[] {
  const data = rule.data;
  const name = String(data['courseName'] ?? '').trim();
  if (name === '') return courses;

  const weeks = parseWeeks(String(data['weeks'] ?? '1-16(周)'));
  if (weeks.length === 0) return courses;

  const startPeriod = Number(data['startPeriod'] ?? 0);
  const endPeriod = Number(data['endPeriod'] ?? startPeriod) || startPeriod;

  return [
    ...courses,
    {
      name,
      teacher: String(data['teacher'] ?? ''),
      classroom: String(data['classroom'] ?? ''),
      dayOfWeek: Number(data['dayOfWeek'] ?? 1),
      startPeriod,
      endPeriod,
      periods:
        startPeriod > 0
          ? `${String(startPeriod).padStart(2, '0')}-${String(endPeriod).padStart(2, '0')}`
          : '',
      weeks: formatWeeks(weeks),
    },
  ];
}

function applySuspension(courses: TimetableCourse[], rule: TimetableRule): TimetableCourse[] {
  const data = rule.data;
  const startWeek = Number(data['startWeek'] ?? 1);
  const endWeek = Number(data['endWeek'] ?? 25);
  const courseName = String(data['courseName'] ?? '').trim().toLowerCase();

  const hasRangeDays = data['startDayOfWeek'] !== undefined || data['endDayOfWeek'] !== undefined;
  const singleDay = data['dayOfWeek'] === undefined ? null : Number(data['dayOfWeek']);
  const startDay = Number(data['startDayOfWeek'] ?? singleDay ?? 1);
  const endDay = Number(data['endDayOfWeek'] ?? singleDay ?? 7);
  void hasRangeDays;

  const startPeriod = data['startPeriod'] === undefined ? null : Number(data['startPeriod']);
  const endPeriod = data['endPeriod'] === undefined ? null : Number(data['endPeriod']);

  const startKey = startWeek * 7 + startDay;
  const endKey = endWeek * 7 + endDay;

  const result: TimetableCourse[] = [];
  for (const course of courses) {
    if (courseName !== '' && !course.name.toLowerCase().includes(courseName)) {
      result.push(course);
      continue;
    }
    if (startPeriod !== null && endPeriod !== null) {
      const overlaps = !(course.endPeriod < startPeriod || course.startPeriod > endPeriod);
      if (!overlaps) {
        result.push(course);
        continue;
      }
    }

    const original = courseWeeks(course);
    const remaining = original.filter((week) => {
      const key = week * 7 + course.dayOfWeek;
      return key < startKey || key > endKey;
    });

    if (remaining.length === 0) continue; // 整门课都被停掉
    result.push(remaining.length === original.length ? course : withWeeks(course, remaining));
  }
  return result;
}

function applyReschedule(courses: TimetableCourse[], rule: TimetableRule): TimetableCourse[] {
  const data = rule.data;
  const sourceWeek = Number(data['sourceWeek'] ?? 0);
  const targetWeek = Number(data['targetWeek'] ?? 0);
  const sourceDay = Number(data['sourceDayOfWeek'] ?? 0);
  const targetDay = Number(data['targetDayOfWeek'] ?? 0);
  const courseName = String(data['courseName'] ?? '').trim().toLowerCase();
  const mode = String(data['action'] ?? (data['isSwap'] === true ? 'swap' : 'move'));
  const sourceStart = data['sourceStartPeriod'] === undefined ? null : Number(data['sourceStartPeriod']);
  const sourceEnd = data['sourceEndPeriod'] === undefined ? null : Number(data['sourceEndPeriod']);
  const targetStart = data['targetStartPeriod'] === undefined ? null : Number(data['targetStartPeriod']);
  const targetEnd = data['targetEndPeriod'] === undefined ? null : Number(data['targetEndPeriod']);

  const matchesSource = (course: TimetableCourse): boolean => {
    if (course.dayOfWeek !== sourceDay) return false;
    if (!courseWeeks(course).includes(sourceWeek)) return false;
    if (courseName !== '' && !course.name.toLowerCase().includes(courseName)) return false;
    if (sourceStart !== null && sourceEnd !== null) {
      const overlaps = !(course.endPeriod < sourceStart || course.startPeriod > sourceEnd);
      if (!overlaps) return false;
    }
    return true;
  };

  const moved: TimetableCourse[] = [];
  const kept: TimetableCourse[] = [];

  for (const course of courses) {
    if (!matchesSource(course)) {
      kept.push(course);
      continue;
    }

    const relocated: TimetableCourse = {
      ...course,
      dayOfWeek: targetDay > 0 ? targetDay : course.dayOfWeek,
      startPeriod: targetStart ?? course.startPeriod,
      endPeriod: targetEnd ?? targetStart ?? course.endPeriod,
      periods:
        targetStart !== null
          ? `${String(targetStart).padStart(2, '0')}-${String(targetEnd ?? targetStart).padStart(2, '0')}`
          : course.periods,
      weeks: formatWeeks([...courseWeeks(course).filter((w) => w !== sourceWeek), targetWeek]),
    };

    // copy：源周保留一份，另外加一份到目标周
    if (mode === 'copy') kept.push(course);
    moved.push(relocated);
  }

  // swap：目标周/星期上的课程反向搬回源周/源星期
  if (mode === 'swap' && targetDay > 0) {
    const swapped: TimetableCourse[] = [];
    for (const course of kept) {
      const isTargetSide =
        course.dayOfWeek === targetDay &&
        courseWeeks(course).includes(targetWeek) &&
        (courseName === '' || course.name.toLowerCase().includes(courseName));
      if (!isTargetSide) {
        swapped.push(course);
        continue;
      }
      swapped.push({
        ...course,
        dayOfWeek: sourceDay > 0 ? sourceDay : course.dayOfWeek,
        weeks: formatWeeks([...courseWeeks(course).filter((w) => w !== targetWeek), sourceWeek]),
      });
    }
    return [...swapped, ...moved];
  }

  return [...kept, ...moved];
}

/** 规则执行顺序固定：自定义加课 -> 调课 -> 停课。 */
export function applyTimetableRules(
  courses: readonly TimetableCourse[],
  rules: readonly TimetableRule[],
): TimetableCourse[] {
  if (rules.length === 0) return [...courses];

  let working = [...courses];
  for (const type of ['customCourse', 'reschedule', 'suspension'] as const) {
    for (const rule of rules.filter((item) => item.type === type)) {
      if (type === 'customCourse') working = applyCustomCourse(working, rule);
      else if (type === 'reschedule') working = applyReschedule(working, rule);
      else working = applySuspension(working, rule);
    }
  }
  return working;
}

/** 规则里引用到的周次（课表查询时要把这些周也拉下来才能正确应用）。 */
export function referencedWeeks(rules: readonly TimetableRule[]): number[] {
  const weeks = new Set<number>();
  for (const rule of rules) {
    for (const key of ['sourceWeek', 'targetWeek']) {
      const value = rule.data[key];
      if (typeof value === 'number' && Number.isFinite(value)) weeks.add(value);
    }
  }
  return [...weeks];
}

/** 只保留与某个周次相关的规则（用于查询单周时减少计算量）。 */
export function rulesForWeek(rules: readonly TimetableRule[], week: number): TimetableRule[] {
  return rules.filter((rule) => {
    switch (rule.type) {
      case 'customCourse':
        return parseWeeks(String(rule.data['weeks'] ?? '')).includes(week);
      case 'suspension': {
        const start = Number(rule.data['startWeek'] ?? 1);
        const end = Number(rule.data['endWeek'] ?? 25);
        return week >= start && week <= end;
      }
      case 'reschedule': {
        const source = Number(rule.data['sourceWeek'] ?? 0);
        const target = Number(rule.data['targetWeek'] ?? 0);
        return week === source || week === target;
      }
    }
  });
}

// ---- 规则构造（供工具层用） ----

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

export function buildSuspensionRule(input: {
  startWeek: number;
  endWeek: number;
  startDayOfWeek: number;
  endDayOfWeek: number;
  courseName?: string;
  startPeriod?: number;
  endPeriod?: number;
}): TimetableRule {
  const name = (input.courseName ?? '').trim();
  return {
    id: makeId('rule_suspension'),
    type: 'suspension',
    description:
      `停课：第${input.startWeek}-${input.endWeek}周 ` +
      `${weekdayName(input.startDayOfWeek)}-${weekdayName(input.endDayOfWeek)}` +
      (name === '' ? '' : `《${name}》`),
    createdAt: new Date().toISOString(),
    data: {
      startWeek: input.startWeek,
      endWeek: input.endWeek,
      startDayOfWeek: input.startDayOfWeek,
      endDayOfWeek: input.endDayOfWeek,
      ...(name === '' ? {} : { courseName: name }),
      ...(input.startPeriod === undefined ? {} : { startPeriod: input.startPeriod }),
      ...(input.endPeriod === undefined ? {} : { endPeriod: input.endPeriod }),
    },
  };
}

export function buildCustomCourseRule(input: {
  courseName: string;
  dayOfWeek: number;
  startPeriod: number;
  endPeriod: number;
  weeks: string;
  teacher?: string;
  classroom?: string;
}): TimetableRule {
  return {
    id: makeId('rule_custom'),
    type: 'customCourse',
    description:
      `加课：《${input.courseName}》${weekdayName(input.dayOfWeek)} ` +
      `第${input.startPeriod}-${input.endPeriod}节`,
    createdAt: new Date().toISOString(),
    data: {
      courseName: input.courseName,
      teacher: input.teacher ?? '',
      classroom: input.classroom ?? '',
      weeks: input.weeks,
      dayOfWeek: input.dayOfWeek,
      startPeriod: input.startPeriod,
      endPeriod: input.endPeriod,
    },
  };
}

export function buildRescheduleRule(input: {
  sourceWeek: number;
  targetWeek: number;
  sourceDayOfWeek: number;
  targetDayOfWeek: number;
  mode: string;
  courseName?: string;
  sourceStartPeriod?: number;
  sourceEndPeriod?: number;
  targetStartPeriod?: number;
  targetEndPeriod?: number;
}): TimetableRule {
  const name = (input.courseName ?? '').trim();
  const modeLabel = input.mode === 'copy' ? '（复制）' : input.mode === 'swap' ? '（对调）' : '（平移）';
  return {
    id: makeId('rule_reschedule'),
    type: 'reschedule',
    description:
      `${name === '' ? '' : `《${name}》`}第${input.sourceWeek}周${weekdayName(input.sourceDayOfWeek)}` +
      ` → 第${input.targetWeek}周${weekdayName(input.targetDayOfWeek)}${modeLabel}`,
    createdAt: new Date().toISOString(),
    data: {
      sourceWeek: input.sourceWeek,
      targetWeek: input.targetWeek,
      sourceDayOfWeek: input.sourceDayOfWeek,
      targetDayOfWeek: input.targetDayOfWeek,
      action: input.mode,
      ...(name === '' ? {} : { courseName: name }),
      ...(input.sourceStartPeriod === undefined ? {} : { sourceStartPeriod: input.sourceStartPeriod }),
      ...(input.sourceEndPeriod === undefined ? {} : { sourceEndPeriod: input.sourceEndPeriod }),
      ...(input.targetStartPeriod === undefined ? {} : { targetStartPeriod: input.targetStartPeriod }),
      ...(input.targetEndPeriod === undefined ? {} : { targetEndPeriod: input.targetEndPeriod }),
    },
  };
}
