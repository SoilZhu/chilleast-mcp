/**
 * 北京时间（UTC+8）工具。
 *
 * 学校所有系统（超星 / 教务 / 门户）返回的都是「北京时间的墙上时间字符串」，
 * 而 Worker 跑在 UTC —— 这里统一做「墙上时间 <-> 时间戳」换算，
 * 避免每个工具各写一遍、也避免把 `2026-05-10 17:00` 当成 UTC 解析（差 8 小时）。
 *
 * 纯函数，无 IO，可单测。
 */

/** 北京时间相对 UTC 的固定偏移（中国不实行夏令时）。 */
export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface BeijingFields {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** 把时间戳拆成北京时间的年月日时分秒。 */
export function beijingFields(epochMs: number): BeijingFields {
  const shifted = new Date(epochMs + BEIJING_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 格式化成北京时间字符串：`2026-05-10 17:00`（默认）或 `2026-05-10 17:00:00`。
 * 与 ChillEast 客户端 `DateFormat('yyyy-MM-dd HH:mm')` 的输出一致。
 */
export function formatBeijing(epochMs: number, withSeconds = false): string {
  const f = beijingFields(epochMs);
  const base = `${f.year}-${pad2(f.month)}-${pad2(f.day)} ${pad2(f.hour)}:${pad2(f.minute)}`;
  return withSeconds ? `${base}:${pad2(f.second)}` : base;
}

/** 时间戳 -> ISO8601（UTC，带 Z），用于结构化输出，避免时区歧义。 */
export function toIsoUtc(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** `2026-05-10 17:00` / `2026-05-10T17:00:00.000`（可带秒与毫秒）。 */
const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

/** 带显式时区（`Z` 或 `+08:00`）的 ISO8601。 */
const ZONED_RE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/**
 * 解析学校页面上的时间字符串。
 *
 * - `2026-05-10 17:00[:00]` —— 无时区信息，按**北京时间**理解（与 Dart 的
 *   `DateFormat.parse` 在设备本地时区解析的行为等价）。
 * - 带 `Z` / `+08:00` 的 ISO8601 —— 按显式时区解析。
 *
 * 解析失败或日期越界（如 2026-13-45）返回 null。
 */
export function parseBeijingDateTime(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  const matched = WALL_CLOCK_RE.exec(trimmed);
  if (matched !== null) {
    const year = Number(matched[1]);
    const month = Number(matched[2]);
    const day = Number(matched[3]);
    const hour = Number(matched[4]);
    const minute = Number(matched[5]);
    const second = matched[6] === undefined ? 0 : Number(matched[6]);
    // Date.UTC 会把 13 月 / 45 日静默进位，这里先做范围校验再回读校验
    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > 31 ||
      hour > 23 ||
      minute > 59 ||
      second > 59
    ) {
      return null;
    }
    const epochMs =
      Date.UTC(year, month - 1, day, hour, minute, second) - BEIJING_OFFSET_MS;
    const back = beijingFields(epochMs);
    if (
      back.year !== year ||
      back.month !== month ||
      back.day !== day ||
      back.hour !== hour ||
      back.minute !== minute
    ) {
      return null;
    }
    return epochMs;
  }

  if (ZONED_RE.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }

  // 其它形如 2026-05-10T17 的写法：按北京时间补上偏移再交给 Date.parse
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    const parsed = Date.parse(`${trimmed}+08:00`);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}
