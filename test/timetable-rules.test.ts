import { describe, expect, it } from 'vitest';
import {
  applyTimetableRules,
  buildCustomCourseRule,
  buildRescheduleRule,
  buildSuspensionRule,
  formatWeeks,
  parseWeeks,
  referencedWeeks,
  rulesForWeek,
  type TimetableRule,
} from '../src/school/hunau/timetable-rules';
import type { TimetableCourse } from '../src/school/hunau/ydjwxt';

function course(partial: Partial<TimetableCourse> & { name: string }): TimetableCourse {
  return {
    teacher: '',
    classroom: '',
    dayOfWeek: 1,
    startPeriod: 1,
    endPeriod: 2,
    periods: '01-02',
    weeks: '1-16(周)',
    ...partial,
  };
}

describe('周次解析与格式化', () => {
  it('解析各种写法（对齐 Dart WeekParser）', () => {
    expect(parseWeeks('1-10(周)')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(parseWeeks('1,3,5,7,9(周)')).toEqual([1, 3, 5, 7, 9]);
    expect(parseWeeks('1-10,12-14(周)')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14]);
    expect(parseWeeks('1-8,10,12(周)')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10, 12]);
    // 反向区间要能纠正
    expect(parseWeeks('10-8(周)')).toEqual([8, 9, 10]);
    // 没有 (周) 后缀也认
    expect(parseWeeks('1-3')).toEqual([1, 2, 3]);
    expect(parseWeeks('')).toEqual([]);
    expect(parseWeeks('乱写')).toEqual([]);
  });

  it('格式化把连续周次压成区间', () => {
    expect(formatWeeks([1, 2, 3, 5])).toBe('1-3,5(周)');
    expect(formatWeeks([1, 2, 3])).toBe('1-3(周)');
    expect(formatWeeks([4])).toBe('4(周)');
    expect(formatWeeks([])).toBe('(周)');
    // 去重
    expect(formatWeeks([2, 2, 3])).toBe('2-3(周)');
  });

  it('往返一致', () => {
    for (const weeks of [[1], [1, 2, 3], [1, 3, 5, 7], [1, 2, 3, 10, 11, 12]]) {
      expect(parseWeeks(formatWeeks(weeks))).toEqual(weeks);
    }
  });
});

describe('停课规则', () => {
  it('只摘掉范围内的周次，其余保留', () => {
    const rules = [
      buildSuspensionRule({ startWeek: 2, endWeek: 3, startDayOfWeek: 1, endDayOfWeek: 1 }),
    ];
    const result = applyTimetableRules([course({ name: '高数', dayOfWeek: 1 })], rules);
    // 1-16 周里去掉第 2、3 周
    expect(result[0].weeks).toBe('1,4-16(周)');
  });

  it('全部周次都被停掉时整门课消失', () => {
    const rules = [
      buildSuspensionRule({ startWeek: 1, endWeek: 16, startDayOfWeek: 1, endDayOfWeek: 1 }),
    ];
    expect(applyTimetableRules([course({ name: '高数', dayOfWeek: 1 })], rules)).toEqual([]);
  });

  it('只影响指定星期几', () => {
    const rules = [
      buildSuspensionRule({ startWeek: 1, endWeek: 16, startDayOfWeek: 2, endDayOfWeek: 2 }),
    ];
    const monday = course({ name: '高数', dayOfWeek: 1 });
    const tuesday = course({ name: '高数', dayOfWeek: 2 });
    const result = applyTimetableRules([monday, tuesday], rules);
    expect(result).toHaveLength(1);
    expect(result[0].dayOfWeek).toBe(1);
  });

  it('按课程名过滤：命中子串的课被停掉，其它不受影响', () => {
    const rules = [
      buildSuspensionRule({
        startWeek: 1,
        endWeek: 16,
        startDayOfWeek: 1,
        endDayOfWeek: 7,
        courseName: '高等数学',
      }),
    ];
    const result = applyTimetableRules(
      [course({ name: '高等数学A' }), course({ name: '大学物理' })],
      rules,
    );
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('大学物理');
  });

  it('课程名是**连续子串**匹配（与 Dart 一致）——「高数」匹配不到「高等数学」', () => {
    // 高-等-数-学 里「高」和「数」不相邻，所以 contains('高数') 为 false。
    // 这不是 bug，是 Dart `course.name.contains(courseName)` 的原样行为；
    // 工具层需要把"没有任何课程匹配"如实回报，否则用户会以为规则没生效。
    const rules = [
      buildSuspensionRule({
        startWeek: 1,
        endWeek: 16,
        startDayOfWeek: 1,
        endDayOfWeek: 7,
        courseName: '高数',
      }),
    ];
    const result = applyTimetableRules([course({ name: '高等数学' })], rules);
    expect(result).toHaveLength(1); // 没匹配上
  });

  it('按节次过滤：不重叠的课不受影响', () => {
    const rules = [
      buildSuspensionRule({
        startWeek: 1,
        endWeek: 16,
        startDayOfWeek: 1,
        endDayOfWeek: 7,
        startPeriod: 1,
        endPeriod: 2,
      }),
    ];
    const result = applyTimetableRules(
      [course({ name: '早课', startPeriod: 1, endPeriod: 2 }), course({ name: '晚课', startPeriod: 5, endPeriod: 6 })],
      rules,
    );
    expect(result.map((c) => c.name)).toEqual(['晚课']);
  });
});

describe('调课规则', () => {
  it('平移：从源周搬到目标周并改星期', () => {
    const rules = [
      buildRescheduleRule({
        sourceWeek: 3,
        targetWeek: 4,
        sourceDayOfWeek: 1,
        targetDayOfWeek: 5,
        mode: 'move',
      }),
    ];
    const result = applyTimetableRules([course({ name: '高数', dayOfWeek: 1 })], rules);
    expect(result).toHaveLength(1);
    expect(result[0].dayOfWeek).toBe(5);
    expect(parseWeeks(result[0].weeks)).toContain(4);
    expect(parseWeeks(result[0].weeks)).not.toContain(3);
  });

  it('移动时源周被摘掉、目标周被加上', () => {
    const rules = [
      buildRescheduleRule({
        sourceWeek: 3,
        targetWeek: 4,
        sourceDayOfWeek: 1,
        targetDayOfWeek: 1,
        mode: 'move',
      }),
    ];
    const result = applyTimetableRules([course({ name: '高数', weeks: '1-16(周)' })], rules);
    const weeks = parseWeeks(result[0].weeks);
    expect(weeks).not.toContain(3);
    expect(weeks).toContain(4);
    expect(weeks).toContain(2); // 其它周不受影响
  });

  it('复制：源周保留，另加一份到目标周', () => {
    const rules = [
      buildRescheduleRule({
        sourceWeek: 3,
        targetWeek: 4,
        sourceDayOfWeek: 1,
        targetDayOfWeek: 5,
        mode: 'copy',
      }),
    ];
    const result = applyTimetableRules([course({ name: '高数', weeks: '3(周)' })], rules);
    expect(result).toHaveLength(2);
    expect(result.some((c) => c.dayOfWeek === 1)).toBe(true);
    expect(result.some((c) => c.dayOfWeek === 5)).toBe(true);
  });

  it('对调：两边的课互换周次', () => {
    const rules = [
      buildRescheduleRule({
        sourceWeek: 3,
        targetWeek: 4,
        sourceDayOfWeek: 1,
        targetDayOfWeek: 5,
        mode: 'swap',
      }),
    ];
    const a = course({ name: '高数', dayOfWeek: 1, weeks: '3(周)' });
    const b = course({ name: '英语', dayOfWeek: 5, weeks: '4(周)' });
    const result = applyTimetableRules([a, b], rules);

    const maths = result.find((c) => c.name === '高数');
    const english = result.find((c) => c.name === '英语');
    // 高数搬到第 4 周周五；英语搬回第 3 周周一
    expect(maths?.dayOfWeek).toBe(5);
    expect(parseWeeks(maths?.weeks ?? '')).toContain(4);
    expect(english?.dayOfWeek).toBe(1);
    expect(parseWeeks(english?.weeks ?? '')).toContain(3);
  });

  it('只搬匹配课程名的课', () => {
    const rules = [
      buildRescheduleRule({
        sourceWeek: 3,
        targetWeek: 4,
        sourceDayOfWeek: 1,
        targetDayOfWeek: 5,
        mode: 'move',
        courseName: '高数',
      }),
    ];
    const result = applyTimetableRules(
      [course({ name: '高等数学', dayOfWeek: 1 }), course({ name: '大学物理', dayOfWeek: 1 })],
      rules,
    );
    const physics = result.find((c) => c.name === '大学物理');
    expect(physics?.dayOfWeek).toBe(1); // 没被动
  });
});

describe('加课规则', () => {
  it('追加一门自定义课程', () => {
    const rules = [
      buildCustomCourseRule({
        courseName: '临时代课',
        dayOfWeek: 6,
        startPeriod: 3,
        endPeriod: 4,
        weeks: '5-8(周)',
        teacher: '张老师',
        classroom: '十教101',
      }),
    ];
    const result = applyTimetableRules([course({ name: '高数' })], rules);
    expect(result).toHaveLength(2);
    const added = result.find((c) => c.name === '临时代课');
    expect(added?.dayOfWeek).toBe(6);
    expect(added?.periods).toBe('03-04');
    expect(added?.weeks).toBe('5-8(周)');
    expect(added?.teacher).toBe('张老师');
  });

  it('没有课程名时忽略该规则', () => {
    const rules = [
      buildCustomCourseRule({
        courseName: '   ',
        dayOfWeek: 1,
        startPeriod: 1,
        endPeriod: 2,
        weeks: '1(周)',
      }),
    ];
    expect(applyTimetableRules([course({ name: '高数' })], rules)).toHaveLength(1);
  });
});

describe('执行顺序（强制 加课 -> 调课 -> 停课）', () => {
  it('先加课后调课：新加的课也能被调走', () => {
    const custom = buildCustomCourseRule({
      courseName: '临时代课',
      dayOfWeek: 1,
      startPeriod: 1,
      endPeriod: 2,
      weeks: '3(周)',
    });
    const move = buildRescheduleRule({
      sourceWeek: 3,
      targetWeek: 4,
      sourceDayOfWeek: 1,
      targetDayOfWeek: 5,
      mode: 'move',
      courseName: '临时代课',
    });
    // 故意把停课/调课放在前面，验证顺序是被强制而非按数组顺序
    const result = applyTimetableRules([], [move, custom]);
    expect(result).toHaveLength(1);
    expect(result[0].dayOfWeek).toBe(5);
  });
});

describe('规则辅助', () => {
  it('referencedWeeks 取出调课涉及的周次', () => {
    const rules: TimetableRule[] = [
      buildRescheduleRule({
        sourceWeek: 3,
        targetWeek: 7,
        sourceDayOfWeek: 1,
        targetDayOfWeek: 1,
        mode: 'move',
      }),
      buildSuspensionRule({ startWeek: 2, endWeek: 2, startDayOfWeek: 1, endDayOfWeek: 1 }),
    ];
    expect(referencedWeeks(rules).sort((a, b) => a - b)).toEqual([3, 7]);
  });

  it('rulesForWeek 只留与本周相关的规则', () => {
    const rules: TimetableRule[] = [
      buildSuspensionRule({ startWeek: 5, endWeek: 6, startDayOfWeek: 1, endDayOfWeek: 7 }),
      buildCustomCourseRule({
        courseName: 'x',
        dayOfWeek: 1,
        startPeriod: 1,
        endPeriod: 2,
        weeks: '9(周)',
      }),
      buildRescheduleRule({
        sourceWeek: 3,
        targetWeek: 4,
        sourceDayOfWeek: 1,
        targetDayOfWeek: 1,
        mode: 'move',
      }),
    ];
    expect(rulesForWeek(rules, 5)).toHaveLength(1);
    expect(rulesForWeek(rules, 9)).toHaveLength(1);
    expect(rulesForWeek(rules, 4)).toHaveLength(1);
    expect(rulesForWeek(rules, 12)).toHaveLength(0);
  });

  it('空规则时原样返回（且不共享引用）', () => {
    const input = [course({ name: '高数' })];
    const result = applyTimetableRules(input, []);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });
});
