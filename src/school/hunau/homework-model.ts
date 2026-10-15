/**
 * 作业领域模型 + 过滤/排序/输出（纯逻辑，可单测）。
 *
 * 对齐 ChillEast：
 *  - `lib/features/homework/models/homework_model.dart`（HomeworkStatus）
 *  - `lib/core/mcp/tools/homework_tools.dart` 的筛选与排序语义
 *
 * 注：ChillEast 的 `query_homework` 会把手工作业（设备本地文件）与网络作业合并；
 * 本服务端按用户决定**只做网络部分**，因此这里只有一种来源。
 */

import { formatBeijing, toIsoUtc } from './time';

/** 作业状态：与 Dart `HomeworkStatus` 一一对应。 */
export type HomeworkStatus = 'pending' | 'completed' | 'archived';

/** 状态中文名，与 Dart 输出一致。 */
export const HOMEWORK_STATUS_NAMES: Record<HomeworkStatus, string> = {
  pending: '待完成',
  completed: '已完成',
  archived: '已存档/已截止',
};

/** 一条作业（目前只有超星网络作业）。 */
export interface HomeworkEntry {
  /** dataUrl 优先，缺失时退化为 `课程|标题`（与 Dart 一致） */
  id: string;
  title: string;
  /** 形如 `《高等数学》`，可能为空 */
  courseName: string;
  status: HomeworkStatus;
  /** 截止时间（epoch 毫秒）；无法解析时为 null */
  endTimeMs: number | null;
  /** 页面原始倒计时文本，例如 `剩余194小时34分钟` */
  rawTimeStr: string;
  /** 手机网页版详情链接（已做 URL 转换） */
  dataUrl: string;
}

/** `status` 参数：`all` 表示不按状态过滤。 */
export type HomeworkStatusFilter = 'all' | HomeworkStatus;

export interface HomeworkFilter {
  status: HomeworkStatusFilter;
  courseName: string;
  keyword: string;
}

const STATUS_FILTERS: readonly HomeworkStatusFilter[] = ['all', 'pending', 'completed', 'archived'];

function isStatusFilter(value: string): value is HomeworkStatusFilter {
  return (STATUS_FILTERS as readonly string[]).includes(value);
}

/**
 * 解析工具入参里的筛选条件。
 *
 * 与 Dart 的差异只在**非法值**上：Dart 用 `arguments['status'] as String? ?? 'pending'`，
 * 传了非法字符串时（例如 `"foo"`）会走「不按状态过滤」分支；这里保持一致 ——
 * 缺省/空串 => pending，其它无法识别的值 => all（不过滤），而不是报错。
 */
export function parseHomeworkFilter(args: Record<string, unknown>): HomeworkFilter {
  const rawStatus = typeof args['status'] === 'string' ? args['status'].trim() : '';
  const status: HomeworkStatusFilter =
    rawStatus === '' ? 'pending' : isStatusFilter(rawStatus) ? rawStatus : 'all';

  const rawCourse = typeof args['courseName'] === 'string' ? args['courseName'].trim() : '';
  const rawKeyword = typeof args['keyword'] === 'string' ? args['keyword'].trim() : '';

  return { status, courseName: rawCourse, keyword: rawKeyword };
}

/**
 * 过滤作业。
 *
 * 语义与 ChillEast 客户端 `homework_tools.dart` 一致：
 *  - status 精确匹配（all 不过滤）
 *  - courseName 大小写不敏感的子串匹配
 *  - keyword 命中「标题 / 课程名」任一即可
 *    （Dart 还比了备注 remarks；网络作业没有备注字段，语义上等价）
 */
export function filterHomework(
  entries: readonly HomeworkEntry[],
  filter: HomeworkFilter,
): HomeworkEntry[] {
  const course = filter.courseName.toLowerCase();
  const keyword = filter.keyword.toLowerCase();

  return entries.filter((entry) => {
    if (filter.status !== 'all' && entry.status !== filter.status) return false;
    if (course !== '' && !entry.courseName.toLowerCase().includes(course)) return false;
    if (keyword !== '') {
      const matchTitle = entry.title.toLowerCase().includes(keyword);
      const matchCourse = entry.courseName.toLowerCase().includes(keyword);
      if (!matchTitle && !matchCourse) return false;
    }
    return true;
  });
}

/** 按截止时间升序，没有截止时间的排最后（与 Dart 一致）。 */
export function sortHomework(entries: readonly HomeworkEntry[]): HomeworkEntry[] {
  return [...entries].sort((a, b) => {
    if (a.endTimeMs === null && b.endTimeMs === null) return 0;
    if (a.endTimeMs === null) return 1;
    if (b.endTimeMs === null) return -1;
    return a.endTimeMs - b.endTimeMs;
  });
}

/**
 * 输出成 MCP 结构化结果。
 *
 * 字段名对齐 Dart 的 `query_homework` 输出（`status` 中文名 + `statusCode` 枚举），
 * 额外补 `endTimeLocal`（北京时间，便于直接回复用户）与 `source`。
 */
export function homeworkToJson(entry: HomeworkEntry): Record<string, unknown> {
  return {
    id: entry.id,
    title: entry.title,
    // Dart: hw.courseName.isNotEmpty ? hw.courseName : '自定义作业'
    courseName: entry.courseName !== '' ? entry.courseName : '自定义作业',
    status: HOMEWORK_STATUS_NAMES[entry.status],
    statusCode: entry.status,
    endTime: entry.endTimeMs === null ? null : toIsoUtc(entry.endTimeMs),
    endTimeLocal: entry.endTimeMs === null ? null : formatBeijing(entry.endTimeMs, true),
    rawTimeStr: entry.rawTimeStr,
    isManual: false,
    source: 'chaoxing',
    remarks: '',
    dataUrl: entry.dataUrl,
  };
}
