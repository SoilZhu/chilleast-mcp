/**
 * 超星（学习通）作业 / 考试抓取。
 *
 * 两条链路只依赖登录链已产出的 `.chaoxing.com` 会话 Cookie，不需要额外换票：
 *   作业：GET mooc1-api.chaoxing.com/mooc-ans/work/stu-work      （HTML）
 *   考试：GET mooc1-api.chaoxing.com/exam-ans/exam/phone/examcode（HTML）
 *         每场考试再取列表项 data 属性里的详情页
 *
 * 解析一律走 Cloudflare 原生 `HTMLRewriter`：一次流式遍历拿完所有字段，不做多轮
 * 全量正则扫描；中文字段交给纯函数解析（`parse*` 不碰网络），便于单测。
 */

import type { CookieSession } from '../../auth/http';
import { SessionExpiredError } from '../../auth/session-manager';
import { CHAOXING_UA, DESKTOP_UA, HOSTS } from './constants';
import type { HomeworkEntry, HomeworkStatus } from './homework-model';
import { BEIJING_OFFSET_MS, parseBeijingDateTime } from './time';

export const HOMEWORK_URL = `${HOSTS.chaoxingMooc}/mooc-ans/work/stu-work`;
export const EXAM_LIST_URL = `${HOSTS.chaoxingMooc}/exam-ans/exam/phone/examcode?`;
/** 作业详情：安卓专用跳转链接会被换成这个手机网页版链接。 */
const PHONE_WORK_URL = `${HOSTS.chaoxingMooc}/mooc-ans/work/phone/task-work`;

/**
 * 作业页 UA：ChillEast 的作业链路走 `DioClient` 默认请求头（桌面 Edge UA），
 * 考试链路显式传 `AppConstants.campusCardUA`。这里保持一致。
 */
const HOMEWORK_UA = DESKTOP_UA;
const EXAM_UA = CHAOXING_UA;

const ACCEPT_HTML =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';

/** 单次解析允许累积的最大文本长度（防御性上限，正常页面远小于它）。 */
const MAX_SCAN_CHARS = 200_000;

// ---- 通用：请求 + 登录态识别 ----

const LOGIN_HOST_RE = /(^|\.)(passport2?|sso|auth)\.chaoxing\.com$/;

/**
 * 判断响应是不是「会话已失效」的登录页。
 * 超星失效时通常 302 到 passport2 登录页；也见过直接 200 返回登录 HTML 的。
 */
export function looksLikeLoginPage(body: string, finalUrl: string): boolean {
  let host = '';
  try {
    host = new URL(finalUrl).hostname.toLowerCase();
  } catch {
    host = '';
  }
  if (LOGIN_HOST_RE.test(host)) return true;
  if (/\/(login|passport)(\/|$|\?)/i.test(finalUrl)) return true;

  // 超星有的接口在会话失效时返回的是**合法 JSON**（HTTP 200），不是登录页 HTML：
  //   {"msg":"您当前未登录","success":false}
  // 不认这一种的话，界面会显示成"空列表"，而会话再也恢复不了。
  if (/^\s*\{/.test(body)) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (parsed !== null && parsed['success'] === false) {
        const message = typeof parsed['msg'] === 'string' ? parsed['msg'] : '';
        if (/未登录|请登录|会话|过期/.test(message)) return true;
      }
    } catch {
      // 不是 JSON，继续按 HTML 判断
    }
  }

  const head = body.slice(0, 4096);
  if (head.includes('CIMS.init')) return true;
  if (/<title>\s*(用户登录|登录|统一身份认证)\s*<\/title>/i.test(head)) return true;
  if (/\bname=["']?(pwd|password)["']?/i.test(head) && /chaoxing/i.test(head)) return true;
  return false;
}

/** GET 一个 HTML 页面；登录页 / 3xx 抛 SessionExpiredError，其它非 200 抛 Error。 */
async function getHtml(
  session: CookieSession,
  url: string,
  userAgent: string,
  referer?: string,
): Promise<string> {
  const response = await session.get(url, {
    headers: {
      'User-Agent': userAgent,
      Accept: ACCEPT_HTML,
      ...(referer === undefined ? {} : { Referer: referer }),
    },
  });
  // CookieSession 默认逐跳跟随 3xx；还能看到 3xx 说明这一跳没有 Location
  // （典型就是被弹回登录），按会话失效处理，让外层重登一次再试。
  if (response.status >= 300 && response.status < 400) {
    throw new SessionExpiredError(`超星接口返回重定向（HTTP ${response.status}）`);
  }
  if (response.status !== 200) {
    throw new Error(`超星接口返回异常状态（HTTP ${response.status}）`);
  }
  if (looksLikeLoginPage(response.body, response.url)) {
    throw new SessionExpiredError('超星会话已失效（接口返回了登录页）');
  }
  return response.body;
}

// ---- 作业：HTML -> 条目 ----

/** 列表项选择器，与 ChillEast 客户端一致：`li[onclick^="goTask"]`。 */
const HOMEWORK_ITEM = 'li[onclick^="goTask"]';

/** 一条列表项在流式解析过程中的中间态。 */
export interface RawHomeworkItem {
  /** li 的 data 属性（安卓跳转链接） */
  data: string;
  /** `.spanImg img` 的 src（只取第一个，同 Dart 的 querySelector） */
  imgSrc: string | null;
  /** `div[role="option"] p` 的文本（只取第一个 p） */
  title: string;
  /** 是否出现 `div[role="option"]`；没有的话 Dart 会跳过这一项 */
  hasOptionDiv: boolean;
  /** 是否已经取过第一个 p */
  pSeen: boolean;
  /** `div[role="option"]` 内所有 span（文档顺序；嵌套时外层先出现） */
  spans: RawSpan[];
}

export interface RawSpan {
  text: string;
  className: string;
  hasClassAttr: boolean;
}

function hasClassToken(className: string, token: string): boolean {
  return className.split(/\s+/).includes(token);
}

/**
 * 解析作业列表 HTML（一次 HTMLRewriter 遍历）。
 *
 * 对齐 Dart 的结构假设：
 *   li[onclick^=goTask] > .spanImg > img
 *                       > div[role=option] > p / span[.status] / span...
 */
export async function parseHomeworkHtml(html: string): Promise<RawHomeworkItem[]> {
  const items: RawHomeworkItem[] = [];
  let current: RawHomeworkItem | null = null;

  // 嵌套 span 时，文本要同时算进外层（Dart 的 Element.text 行为）；
  // HTMLRewriter 对同一 selector 的每个文本节点只回调一次，因此往所有打开的
  // 栈帧里各加一次，得到的正是「含嵌套文本」的结果。
  const spanStack: RawSpan[] = [];
  let pBuffer: string | null = null;

  await new HTMLRewriter()
    .on(HOMEWORK_ITEM, {
      element(element) {
        current = {
          data: element.getAttribute('data') ?? '',
          imgSrc: null,
          title: '',
          hasOptionDiv: false,
          pSeen: false,
          spans: [],
        };
        items.push(current);
      },
    })
    .on(`${HOMEWORK_ITEM} .spanImg img`, {
      element(element) {
        if (current !== null && current.imgSrc === null) {
          current.imgSrc = element.getAttribute('src') ?? '';
        }
      },
    })
    .on(`${HOMEWORK_ITEM} div[role="option"]`, {
      element() {
        if (current !== null) current.hasOptionDiv = true;
      },
    })
    .on(`${HOMEWORK_ITEM} div[role="option"] p`, {
      element(element) {
        const item = current;
        if (item === null || item.pSeen) return;
        item.pSeen = true;
        pBuffer = '';
        element.onEndTag(() => {
          item.title = (pBuffer ?? '').trim();
          pBuffer = null;
        });
      },
      text(chunk) {
        if (pBuffer !== null) pBuffer += chunk.text;
      },
    })
    .on(`${HOMEWORK_ITEM} div[role="option"] span`, {
      element(element) {
        const frame: RawSpan = {
          text: '',
          className: element.getAttribute('class') ?? '',
          hasClassAttr: element.hasAttribute('class'),
        };
        spanStack.push(frame);
        if (current !== null) current.spans.push(frame);
        element.onEndTag(() => {
          const index = spanStack.indexOf(frame);
          if (index >= 0) spanStack.splice(index, 1);
        });
      },
      text(chunk) {
        for (const frame of spanStack) frame.text += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();

  return items;
}

/**
 * 状态判定，与 ChillEast 客户端 `homework_service.dart` 的核心逻辑一致：
 *  1. 状态不是「未提交」 -> 已完成
 *  2. 「未提交」+ 非灰图标 + 有时间 -> 待完成
 *  3. 「未提交」+ (灰图标 或 无时间) -> 已存档
 *
 * 唯一的有意放宽：把「未交」也视为「未提交」。超星部分页面用「未交」表示同一件事，
 * 而 Dart 只字面比较「未提交」——若真返回「未交」，Dart 会误判成已完成。
 */
const NOT_SUBMITTED_TEXTS: readonly string[] = ['未提交', '未交'];

export function classifyHomeworkStatus(
  statusText: string,
  isGrayIcon: boolean,
  remainTimeStr: string,
): HomeworkStatus {
  const text = statusText.trim();
  if (!NOT_SUBMITTED_TEXTS.includes(text)) return 'completed';
  if (!isGrayIcon && remainTimeStr.trim() !== '') return 'pending';
  return 'archived';
}

const DAY_RE = /(\d+)天/;
const HOUR_RE = /(\d+)小时/;
const MINUTE_RE = /(\d+)分钟/;

/**
 * 「剩余194小时34分钟」-> 截止时间戳。
 *
 * 与 Dart `_parseRemainTime` 完全一致（含那个 `+1` 分钟）：
 * 天/时/分三段相加，总分钟为 0 或解析不出时返回 null。
 */
export function parseRemainTime(raw: string, nowMs: number): number | null {
  const clean = raw.replace('剩余', ''); // Dart 的 replaceFirst('剩余', '')
  let totalMinutes = 0;

  const day = DAY_RE.exec(clean);
  if (day !== null) totalMinutes += Number(day[1]) * 24 * 60;
  const hour = HOUR_RE.exec(clean);
  if (hour !== null) totalMinutes += Number(hour[1]) * 60;
  const minute = MINUTE_RE.exec(clean);
  if (minute !== null) totalMinutes += Number(minute[1]);

  if (totalMinutes === 0) return null;
  return nowMs + (totalMinutes + 1) * 60_000;
}

/**
 * 安卓跳转链接 -> 手机网页版链接（与 ChillEast 客户端 `_transformDataUrl` 一致）：
 *   .../android/mtaskmsgspecial?taskrefId=..&courseId=..&clazzId=..
 *   -> .../work/phone/task-work?taskrefId=..&courseId=..&classId=..&ut=s
 * 参数不全或不是合法 URL 时原样返回。
 */
export function transformHomeworkDataUrl(url: string): string {
  if (url === '') return '';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const taskrefId = parsed.searchParams.get('taskrefId');
  const courseId = parsed.searchParams.get('courseId');
  const classId = parsed.searchParams.get('clazzId');
  if (taskrefId === null || courseId === null || classId === null) return url;

  const query = new URLSearchParams({ taskrefId, courseId, classId, ut: 's' });
  return `${PHONE_WORK_URL}?${query.toString()}`;
}

/** 把解析出来的中间态变成作业条目（纯函数，`nowMs` 由调用方给定）。 */
export function buildHomeworkEntries(
  items: readonly RawHomeworkItem[],
  nowMs: number,
): HomeworkEntry[] {
  const entries: HomeworkEntry[] = [];

  for (const item of items) {
    // Dart: contentDiv == null -> continue
    if (!item.hasOptionDiv) continue;

    const statusSpan = item.spans.find((span) => hasClassToken(span.className, 'status'));
    const firstPlainSpan = item.spans.find((span) => !span.hasClassAttr);
    const statusText = (statusSpan?.text ?? firstPlainSpan?.text ?? '').trim();

    // Dart 遍历全部 span，课程名与剩余时间都是「后者覆盖前者」
    let courseName = '';
    let remainTimeStr = '';
    for (const span of item.spans) {
      const text = span.text.trim();
      if (text.startsWith('《') && text.endsWith('》')) {
        courseName = text;
      } else if (text.includes('剩余') || text.includes('小时') || text.includes('分钟')) {
        remainTimeStr = text;
      }
    }

    const isGrayIcon = (item.imgSrc ?? '').includes('task-work-gray.png');
    const status = classifyHomeworkStatus(statusText, isGrayIcon, remainTimeStr);
    const endTimeMs = remainTimeStr === '' ? null : parseRemainTime(remainTimeStr, nowMs);

    entries.push({
      // Dart: id = dataUrl.isNotEmpty ? dataUrl : '$courseName|$title'（用转换前的原始链接）
      id: item.data !== '' ? item.data : `${courseName}|${item.title}`,
      title: item.title,
      courseName,
      status,
      endTimeMs,
      rawTimeStr: remainTimeStr,
      dataUrl: transformHomeworkDataUrl(item.data),
    });
  }

  return entries;
}

/** 拉取并解析超星作业列表。`nowMs` 显式传入，保证同一批次的倒计时用同一基准。 */
export async function fetchRemoteHomework(
  session: CookieSession,
  nowMs: number = Date.now(),
): Promise<HomeworkEntry[]> {
  const html = await getHtml(session, HOMEWORK_URL, HOMEWORK_UA);
  const items = await parseHomeworkHtml(html);
  return buildHomeworkEntries(items, nowMs);
}

// ---- 考试：列表 ----

/**
 * 列表项选择器，与 ChillEast 客户端一致：`ul.ks_list li, .ks_list li, li[data*="task-exam"]`。
 * HTMLRewriter 的逗号选择器对同一元素只回调一次（等于 querySelectorAll 的去重语义）。
 */
const EXAM_ITEM_SELECTOR = 'ul.ks_list li, .ks_list li, li[data*="task-exam"]';

const EXAM_ITEM_DT = EXAM_ITEM_SELECTOR.split(', ')
  .map((selector) => `${selector} dt`)
  .join(', ');
const EXAM_ITEM_STATE = EXAM_ITEM_SELECTOR.split(', ')
  .map((selector) => `${selector} .ks_state`)
  .join(', ');

export interface ExamListItem {
  id: string;
  title: string;
  /** 详情页地址（已补全 host） */
  dataUrl: string;
  /** 列表上的状态文案，如「未交」「已完成」 */
  status: string;
}

interface RawExamItem {
  data: string;
  titleAttr: string;
  dtText: string;
  dtSeen: boolean;
  stateText: string;
  stateSeen: boolean;
}

/** 把列表项 data 属性补成绝对地址（与 ChillEast 客户端的三段判断一致）。 */
export function resolveExamDataUrl(raw: string): string {
  if (raw.startsWith('http')) return raw;
  if (raw.startsWith('/')) return `${HOSTS.chaoxingMooc}${raw}`;
  return `${HOSTS.chaoxingMooc}/${raw}`;
}

/** 从详情链接里取考试 ID：taskrefId -> examId -> 整条链接。 */
export function examIdFromUrl(dataUrl: string): string {
  try {
    const parsed = new URL(dataUrl);
    const taskrefId = parsed.searchParams.get('taskrefId');
    if (taskrefId !== null && taskrefId !== '') return taskrefId;
    const examId = parsed.searchParams.get('examId');
    if (examId !== null && examId !== '') return examId;
  } catch {
    // 非法 URL：按 Dart 的 catch 分支退化为空
  }
  return '';
}

/** 解析考试列表 HTML（一次 HTMLRewriter 遍历）。 */
export async function parseExamListHtml(html: string): Promise<ExamListItem[]> {
  const rawItems: RawExamItem[] = [];
  let current: RawExamItem | null = null;
  let dtBuffer: string | null = null;
  let stateBuffer: string | null = null;

  await new HTMLRewriter()
    .on(EXAM_ITEM_SELECTOR, {
      element(element) {
        current = {
          data: element.getAttribute('data') ?? '',
          titleAttr: element.getAttribute('title') ?? '',
          dtText: '',
          dtSeen: false,
          stateText: '',
          stateSeen: false,
        };
        rawItems.push(current);
      },
    })
    .on(EXAM_ITEM_DT, {
      element(element) {
        const item = current;
        if (item === null || item.dtSeen) return;
        item.dtSeen = true;
        dtBuffer = '';
        element.onEndTag(() => {
          item.dtText = (dtBuffer ?? '').trim();
          dtBuffer = null;
        });
      },
      text(chunk) {
        if (dtBuffer !== null) dtBuffer += chunk.text;
      },
    })
    .on(EXAM_ITEM_STATE, {
      element(element) {
        const item = current;
        if (item === null || item.stateSeen) return;
        item.stateSeen = true;
        stateBuffer = '';
        element.onEndTag(() => {
          item.stateText = (stateBuffer ?? '').trim();
          stateBuffer = null;
        });
      },
      text(chunk) {
        if (stateBuffer !== null) stateBuffer += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();

  const items: ExamListItem[] = [];
  for (const raw of rawItems) {
    const data = raw.data.trim();
    if (data === '') continue; // Dart: rawData.isEmpty -> continue

    const dataUrl = resolveExamDataUrl(data);
    // Dart: title 属性优先，其次 dt 文本
    const title = raw.titleAttr.trim() !== '' ? raw.titleAttr.trim() : raw.dtText;

    items.push({
      id: examIdFromUrl(dataUrl) || dataUrl,
      title,
      dataUrl,
      status: raw.stateText.trim(),
    });
  }
  return items;
}

// ---- 考试：详情 ----

export interface ExamDetail {
  /** 容器里第一个出现的时间（日程显示用） */
  displayTimeMs: number;
  allTimesMs: number[];
  rawTimeStrs: string[];
  studentName: string;
  studentId: string;
}

export interface ExamDetailText {
  /** 详情容器（`.result_gray_div`，Dart 里 watermark 的父容器）的文本 */
  text: string;
  /** 是否找到容器 */
  containerFound: boolean;
  /** 是否找到 watermark 容器 */
  hasWatermark: boolean;
}

const WATERMARK_SELECTOR = '#watermark-wrapper, .watermark-wrapper';
const DETAIL_CONTAINER_SELECTOR = '.result_gray_div';

/**
 * 抓详情页的文本。
 *
 * Dart 先找 `#watermark-wrapper` 再取它的父节点，父节点通常是 `.result_gray_div`；
 * HTMLRewriter 拿不到父节点，所以直接取 `.result_gray_div`（等价路径），
 * 只有整页都没有该容器时才退化成抓 body 文本（此时 Dart 用的是 watermark 的父节点）。
 */
export async function collectExamDetailText(html: string): Promise<ExamDetailText> {
  let containerText = '';
  let containerFound = false;
  let hasWatermark = false;

  await new HTMLRewriter()
    .on(DETAIL_CONTAINER_SELECTOR, {
      element() {
        containerFound = true;
      },
      text(chunk) {
        if (containerText.length < MAX_SCAN_CHARS) containerText += chunk.text;
      },
    })
    .on(WATERMARK_SELECTOR, {
      element() {
        hasWatermark = true;
      },
    })
    .transform(new Response(html))
    .text();

  if (!containerFound) {
    // 兜底路径：整页文本（有长度上限，避免异常页面把 CPU 吃光）
    let wholeText = '';
    await new HTMLRewriter()
      .on('body', {
        text(chunk) {
          if (wholeText.length < MAX_SCAN_CHARS) wholeText += chunk.text;
        },
      })
      .transform(new Response(html))
      .text();
    return { text: wholeText, containerFound: false, hasWatermark };
  }

  return { text: containerText, containerFound: true, hasWatermark };
}

/** Dart 的日期时间正则：`\b\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\b`。 */
function examTimeRegex(): RegExp {
  return /\b\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\b/g;
}

const STUDENT_NAME_RE = /姓名[：:]\s*([^\s<]+)/;
const STUDENT_ID_RE = /学号[：:]\s*([^\s<]+)/;

/**
 * 从详情页文本里抽考试时间与身份信息（纯函数）。
 *
 * 规则同 Dart：容器内所有能解析的时间都收集，展示时间取**第一个**出现的时间；
 * 一个时间都解析不出来时返回 null（该场考试会被丢弃）。
 */
export function extractExamDetail(text: string): ExamDetail | null {
  const rawTimeStrs: string[] = [];
  const allTimesMs: number[] = [];

  for (const match of text.matchAll(examTimeRegex())) {
    const raw = match[0];
    const parsed = parseBeijingDateTime(raw);
    if (parsed !== null) {
      rawTimeStrs.push(raw);
      allTimesMs.push(parsed);
    }
  }

  if (allTimesMs.length === 0) return null;

  const nameMatch = STUDENT_NAME_RE.exec(text);
  const idMatch = STUDENT_ID_RE.exec(text);

  return {
    displayTimeMs: allTimesMs[0] ?? 0,
    allTimesMs,
    rawTimeStrs,
    studentName: nameMatch?.[1]?.trim() ?? '',
    studentId: idMatch?.[1]?.trim() ?? '',
  };
}

/** 拉取并解析一场考试的详情页。 */
export async function fetchExamDetail(
  session: CookieSession,
  dataUrl: string,
): Promise<ExamDetail | null> {
  const html = await getHtml(session, dataUrl, EXAM_UA, EXAM_LIST_URL);
  const collected = await collectExamDetailText(html);
  return extractExamDetail(collected.text);
}

// ---- 考试：日程（列表 + 逐条详情） ----

export interface ExamSchedule {
  id: string;
  title: string;
  /** 详情页里没有课程名字段（ChillEast 客户端也恒为空） */
  courseName: string;
  timeMs: number;
  allTimesMs: number[];
  rawTimeStrs: string[];
  detailUrl: string;
  status: string;
  studentName: string;
  studentId: string;
}

export interface ExamFetchResult {
  exams: ExamSchedule[];
  /** 列表里有、但详情页没解析出时间的考试（不静默丢弃） */
  unresolved: ExamListItem[];
}

/** 与 Dart 相同的并发批大小。 */
const DETAIL_BATCH_SIZE = 5;

/**
 * 拉取考试日程：列表 + 逐条详情，按时间升序返回。
 * 单条详情失败只记录到 unresolved，不影响其它考试；会话失效则整体上抛重登。
 */
export async function fetchExamSchedules(session: CookieSession): Promise<ExamFetchResult> {
  const listHtml = await getHtml(session, EXAM_LIST_URL, EXAM_UA);
  const items = await parseExamListHtml(listHtml);

  const exams: ExamSchedule[] = [];
  const unresolved: ExamListItem[] = [];

  for (let index = 0; index < items.length; index += DETAIL_BATCH_SIZE) {
    const batch = items.slice(index, index + DETAIL_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (item) => {
        try {
          return { item, detail: await fetchExamDetail(session, item.dataUrl) };
        } catch (error) {
          // 会话失效必须上抛（外层会重登重试），其余错误只丢这一条
          if (error instanceof SessionExpiredError) throw error;
          return { item, detail: null };
        }
      }),
    );

    for (const { item, detail } of results) {
      if (detail === null) {
        unresolved.push(item);
        continue;
      }
      exams.push({
        id: item.id,
        title: item.title,
        courseName: '',
        timeMs: detail.displayTimeMs,
        allTimesMs: detail.allTimesMs,
        rawTimeStrs: detail.rawTimeStrs,
        detailUrl: item.dataUrl,
        status: item.status,
        studentName: detail.studentName,
        studentId: detail.studentId,
      });
    }
  }

  exams.sort((a, b) => a.timeMs - b.timeMs);
  return { exams, unresolved };
}

// ---- 学期判定 ----

/**
 * 是否属于「参考时间所在的高校学期」（移植 `SemesterUtils.isCurrentSemester`
 * 中不依赖课表的分支）：
 *   秋季学期：当年 8/1 ~ 次年 2/15
 *   春季学期：当年 2/16 ~ 当年 7/31
 *
 * 注意：ChillEast 客户端若拿到了课表第一周周一，会用「开学周一 -14 天 ~ +26 周」判定；
 * 服务端没有课表缓存，因此只用学期日期区间。
 */
export function isCurrentSemester(epochMs: number, referenceMs: number = Date.now()): boolean {
  const ref = new Date(referenceMs + BEIJING_OFFSET_MS); // 北京时间的月/日
  const year = ref.getUTCFullYear();
  const month = ref.getUTCMonth() + 1;
  const day = ref.getUTCDate();

  // 用 UTC 构造「北京时间的墙上时间」对应的边界
  const boundary = (
    y: number,
    m: number,
    d: number,
    hour = 0,
    minute = 0,
    second = 0,
  ): number => Date.UTC(y, m - 1, d, hour, minute, second) - BEIJING_OFFSET_MS;

  if (month >= 8 || month === 1 || (month === 2 && day <= 15)) {
    const startYear = month <= 2 ? year - 1 : year;
    const start = boundary(startYear, 8, 1);
    const end = boundary(startYear + 1, 2, 15, 23, 59, 59);
    return epochMs >= start && epochMs <= end;
  }

  const start = boundary(year, 2, 16);
  const end = boundary(year, 7, 31, 23, 59, 59);
  return epochMs >= start && epochMs <= end;
}
