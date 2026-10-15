import { describe, expect, it } from 'vitest';
import { normalizeSemesters } from '../src/tools/ydjwxt';

/**
 * `semesterList` 的真实返回结构没有实测样本，所以归一逻辑必须够宽。
 * 用户实测时报"没有取到学期列表" —— 说明原实现只认顶层数组这一种形态。
 */
describe('学期列表归一', () => {
  it('顶层就是对象数组（常见形态）', () => {
    const result = normalizeSemesters([
      { semester: '2025-2026-2', semesterName: '2025-2026学年第二学期' },
      { semester: '2025-2026-1', semesterName: '2025-2026学年第一学期' },
    ]);
    expect(result).toEqual([
      { semester: '2025-2026-2', name: '2025-2026学年第二学期' },
      { semester: '2025-2026-1', name: '2025-2026学年第一学期' },
    ]);
  });

  it('顶层是纯字符串数组', () => {
    expect(normalizeSemesters(['2025-2026-2', '2025-2026-1'])).toEqual([
      { semester: '2025-2026-2', name: '2025-2026-2' },
      { semester: '2025-2026-1', name: '2025-2026-1' },
    ]);
  });

  it('数组藏在 data / list / rows / aaData 里', () => {
    const rows = [{ xqid: '2025-2026-2', xqmc: '第二学期' }];
    expect(normalizeSemesters({ data: rows })).toEqual([
      { semester: '2025-2026-2', name: '第二学期' },
    ]);
    expect(normalizeSemesters({ data: { list: rows } })).toEqual([
      { semester: '2025-2026-2', name: '第二学期' },
    ]);
    expect(normalizeSemesters({ data: { rows } })).toEqual([
      { semester: '2025-2026-2', name: '第二学期' },
    ]);
    expect(normalizeSemesters({ aaData: rows })).toEqual([
      { semester: '2025-2026-2', name: '第二学期' },
    ]);
  });

  it('认多种字段叫法', () => {
    expect(normalizeSemesters([{ xnxq: '2025-2026-2', xnxqmc: '第二学期' }])).toEqual([
      { semester: '2025-2026-2', name: '第二学期' },
    ]);
    expect(normalizeSemesters([{ dm: 'A', mc: '甲学期' }])).toEqual([
      { semester: 'A', name: '甲学期' },
    ]);
    // 数字类型的学期标识
    expect(normalizeSemesters([{ id: 42, name: '四十二' }])).toEqual([
      { semester: '42', name: '四十二' },
    ]);
  });

  it('只有名字没有标识时，用名字兜底当标识', () => {
    expect(normalizeSemesters([{ name: '2025-2026-2' }])).toEqual([
      { semester: '2025-2026-2', name: '2025-2026-2' },
    ]);
  });

  it('完全认不出来时返回空数组（由调用方把原始响应交给用户）', () => {
    expect(normalizeSemesters(null)).toEqual([]);
    expect(normalizeSemesters(undefined)).toEqual([]);
    expect(normalizeSemesters('not a list')).toEqual([]);
    expect(normalizeSemesters(42)).toEqual([]);
    expect(normalizeSemesters({ code: '1', Msg: 'ok' })).toEqual([]);
    expect(normalizeSemesters([{}, { a: 1 }])).toEqual([]);
  });

  it('不会因为是空数组就误判成有数据', () => {
    expect(normalizeSemesters([])).toEqual([]);
    expect(normalizeSemesters({ data: [] })).toEqual([]);
  });
});
