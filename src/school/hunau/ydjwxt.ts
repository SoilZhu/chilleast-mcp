/**
 * 移动教务（ydjwxt / njwhd）—— **纯 HTTP 登录**，不再需要 WebView。
 *
 * 密码：`pwd = base64(AES-ECB-PKCS7(key="qzkj1kjghd=876&*", plaintext=JSON.stringify(密码)))`，
 * 接口：`POST /njwhd/login?userNo=..&pwd=..&encode=1`。
 *
 * ⚠️ 整条链还原自前端生产代码，**尚未用真实账号跑通验证**；加密已用 Node
 *    aes-128-ecb 交叉验证过，接口契约若与线上不符，第一个该看的就是这里。
 */

import { aesEcbEncryptUtf8Key } from '../../util/aes';
import { bytesToB64 } from '../../util/bytes';
import { CookieSession } from '../../auth/http';
import { SessionExpiredError } from '../../auth/session-manager';
import { CHAOXING_UA, HOSTS, URLS } from './constants';

const BASE = `${HOSTS.ydjwxt}/njwhd`;

/** 前端 LL.encrypt 里写死的 AES-128 密钥。 */
export const YDJWXT_AES_KEY = 'qzkj1kjghd=876&*';

/**
 * 复刻 `window.btoa(LL.encrypt(password))`。
 * 注意是**两层 base64**：内层是 AES 密文的 Base64，外层再把这个字符串编码一次。
 */
export function encodeYdjwxtPassword(password: string): string {
  const ciphertext = aesEcbEncryptUtf8Key(YDJWXT_AES_KEY, JSON.stringify(password));
  return btoa(bytesToB64(ciphertext));
}

const API_HEADERS = {
  'User-Agent': CHAOXING_UA,
  Referer: `${HOSTS.ydjwxt}/hnnydx/`,
  Origin: HOSTS.ydjwxt,
  Accept: 'application/json, text/plain, */*',
};

interface YdjwxtEnvelope {
  code: string | number;
  data?: unknown;
  Msg?: string;
}

function parseEnvelope(body: string, status: number): YdjwxtEnvelope {
  const trimmed = body.trim();
  if (trimmed.startsWith('<')) {
    throw new SessionExpiredError('移动教务返回了 HTML（会话或接口已变更）');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`移动教务返回了无法解析的内容（HTTP ${status}）`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('移动教务返回结构异常');
  }
  return parsed as YdjwxtEnvelope;
}

function codeOf(envelope: YdjwxtEnvelope): string {
  return String(envelope.code ?? '');
}

/** 判断是否是「token 失效」，需要重新登录。 */
function isAuthFailure(envelope: YdjwxtEnvelope): boolean {
  const code = codeOf(envelope);
  return code === '401' || code === '-1' || code === '0';
}

/**
 * 一次登录产生的完整上下文。
 *
 * **必须把 session 一起带着走**：登录那一跳会下发会话 Cookie，
 * 后续接口虽然靠 `token` 头鉴权，但服务端往往同时认这个 Cookie。
 * 之前每次调用都新建 CookieSession，等于把登录拿到的 Cookie 丢了。
 */
export interface YdjwxtSession {
  session: CookieSession;
  token: string;
  userType: string | null;
}

// ---- 入口：超星 OAuth 链（照抄 ChillEast 的做法）-------------------------
//
// ChillEast 的 `ydjwxt_auth_service.dart` 把 `ydjwxtOAuthUrl` 丢给
// HeadlessInAppWebView，再用 JS 从 localStorage 读 token。但那条链本身
// **全是 302**，不需要 JS —— 和校园卡是完全一样的模式，而校园卡那边
// ChillEast 自己已经从 WebView 迁到了纯 HTTP
// （`campus_card_service.authenticate()` 的注释：「整条链是纯 302 跳转，
//  不需要执行 JS」）。
//
// 所以这里照抄 `campus_card_service.authenticate()` 的手动跟随循环：
// 逐跳 GET、followRedirects=false、串起 Referer、从最终 URL 或响应体里
// 提取凭据。区别只是校园卡提 openid，这里提 token / askToken。

const OAUTH_MAX_STEPS = 12;

/** 与 campus_card_service 使用的 Accept 一致。 */
const HTML_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,' +
  'image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';

/**
 * 只保留 host+path（+hash 的路径部分），用于日志与报错。
 * query 一律丢掉 —— 那里可能有票据或 token。
 * 保留 hash 的路径是因为这是个 hash 路由的 SPA，`#/login` 和 `#/homeIndex`
 * 是完全不同的状态，诊断时必须看得见。
 */
function safePath(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const hash = parsed.hash.replace(/\?.*$/, '');
    return `${parsed.host}${parsed.pathname}${hash}`;
  } catch {
    return rawUrl;
  }
}

/**
 * 把 URL 的 query 与 **hash 里的 query** 合并。
 *
 * 关键：这是个 hash 路由的 Vue 应用，`this.$route.query` 读的是 `#` 之后那一段。
 * 实测跳转链会落在 `https://ydjwxt.hunau.edu.cn/hnnydx/`，
 * token 极可能在 `#/login?token=...` 这种形式里 —— 只读 searchParams 会漏掉。
 */
function allParams(rawUrl: string): URLSearchParams {
  const merged = new URLSearchParams();
  try {
    const parsed = new URL(rawUrl, HOSTS.ydjwxt);
    for (const [key, value] of new URLSearchParams(parsed.search)) merged.set(key, value);

    const hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
    const queryIndex = hash.indexOf('?');
    if (queryIndex >= 0) {
      for (const [key, value] of new URLSearchParams(hash.slice(queryIndex + 1))) {
        merged.set(key, value);
      }
    }
  } catch {
    // 解析不了就当没有参数
  }
  return merged;
}

/** 从 URL 里找 token / askToken。 */
export function extractToken(rawUrl: string): { token?: string; askToken?: string } {
  if (rawUrl === '') return {};
  const params = allParams(rawUrl);
  const result: { token?: string; askToken?: string } = {};
  const token = params.get('token');
  const askToken = params.get('askToken');
  if (token !== null && token !== '') result.token = token;
  if (askToken !== null && askToken !== '') result.askToken = askToken;
  return result;
}

/**
 * 从响应体里找 token。
 * 覆盖 SPA 的 `localStorage.setItem('token', '...')` 与 JSON 里的 "token":"..."。
 */
export function extractTokenFromBody(body: string): { token?: string; askToken?: string } {
  if (body === '') return {};
  // 优先 askToken（更具体，不会与普通 token 混淆）
  const ask = /["']?askToken["']?\s*[:=,]\s*["']([A-Za-z0-9._-]{16,})["']/i.exec(body);
  if (ask !== null) return { askToken: ask[1] };
  // 逗号也要认：SPA 用的是 sessionStorage.setItem("Token", "...")
  const token = /["']?token["']?\s*[:=,]\s*["']([A-Za-z0-9._-]{16,})["']/i.exec(body);
  if (token !== null) return { token: token[1] };
  return {};
}

interface OauthWalk {
  hops: string[];
  token?: string;
  askToken?: string;
  /**
   * 被弹到超星 passport 登录页了。
   * 实测：没有有效的 `.chaoxing.com` Cookie 时，
   * auth.chaoxing.com 会 302 到 passport2.chaoxing.com/login -> /mlogin（200 登录页）。
   * 这说明登录链产出的超星身份没生效，而不是 token 提取的问题。
   */
  bouncedToPassport?: boolean;
}

/**
 * 走一遍超星 OAuth 链，尽量把 token 捞出来。
 * 与 campus_card_service 一样：手动跟随、逐跳带 Referer、最多 12 跳。
 */
async function walkYdjwxtOAuth(session: CookieSession): Promise<OauthWalk> {
  let url: string | null = URLS.ydjwxtOAuthUrl;
  let referer: string | undefined;
  const hops: string[] = [];

  for (let step = 0; step < OAUTH_MAX_STEPS && url !== null; step++) {
    const response = await session.request(url, {
      method: 'GET',
      follow: false,
      headers: {
        'User-Agent': CHAOXING_UA,
        Accept: HTML_ACCEPT,
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Upgrade-Insecure-Requests': '1',
        ...(referer === undefined ? {} : { Referer: referer }),
      },
    });
    hops.push(`${response.status} ${safePath(response.url)}`);

    // 1) 当前 URL 上就有
    const fromUrl = extractToken(response.url);
    if (fromUrl.token !== undefined || fromUrl.askToken !== undefined) {
      return { hops, ...fromUrl };
    }
    // 2) 响应体里有（SPA 把 token 写进 localStorage 的那种页面）
    const fromBody = extractTokenFromBody(response.body);
    if (fromBody.token !== undefined || fromBody.askToken !== undefined) {
      return { hops, ...fromBody };
    }

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location !== null && location !== '') {
      const next = new URL(location, response.url).toString();
      // 3) 下一跳的 Location 上就有
      const fromNext = extractToken(next);
      if (fromNext.token !== undefined || fromNext.askToken !== undefined) {
        hops.push(safePath(next));
        return { hops, ...fromNext };
      }
      referer = response.url;
      url = next;
      continue;
    }

    // 停在超星 passport 登录页 = 超星身份没生效
    if (/passport2?\.chaoxing\.com$/.test(new URL(response.url).hostname)) {
      return { hops, bouncedToPassport: true };
    }
    break;
  }

  return { hops };
}

/** askToken -> 真 token（对应 SPA 的 aksCasLogin -> DL({token: askToken})）。 */
async function exchangeAskToken(session: CookieSession, askToken: string): Promise<string | null> {
  for (const path of ['/authUser', '/login']) {
    const query = new URLSearchParams({ token: askToken });
    const response = await session.request(`${BASE}${path}?${query}`, {
      method: 'POST',
      headers: { ...API_HEADERS, 'Content-Type': 'application/json' },
      body: '{}',
    });
    let envelope: YdjwxtEnvelope;
    try {
      envelope = parseEnvelope(response.body, response.status);
    } catch {
      continue; // 这个端点不接受这个参数，试下一个
    }
    const data = envelope.data;
    if (typeof data === 'object' && data !== null) {
      const token = (data as Record<string, unknown>)['token'];
      if (typeof token === 'string' && token !== '') return token;
    }
  }
  return null;
}

/**
 * 用学号 + 密码直接换 JWT（SPA 的 userLoginApi -> POST /login）。
 * 作为换票路径的兜底。
 */
async function loginByPassword(
  username: string,
  password: string,
): Promise<YdjwxtSession | null> {
  const session = new CookieSession(undefined, CHAOXING_UA);
  const query = new URLSearchParams({
    userNo: username,
    pwd: encodeYdjwxtPassword(password),
    encode: '1',
    captchaData: '',
    codeVal: '',
  });

  const response = await session.request(`${BASE}/login?${query}`, {
    method: 'POST',
    headers: { ...API_HEADERS, 'Content-Type': 'application/json' },
    // 密码经加密后仍在 query 里，只允许发往教务处域名
    guard: (url) => url.protocol === 'https:' && url.hostname === new URL(HOSTS.ydjwxt).hostname,
  });

  const envelope = parseEnvelope(response.body, response.status);
  const data = envelope.data;
  if (codeOf(envelope) !== '1' || typeof data !== 'object' || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const token = record['token'];
  if (typeof token !== 'string' || token === '') return null;
  const userType = record['userType'];
  return {
    session,
    token,
    userType: userType === undefined ? null : String(userType),
  };
}

/**
 * 登录教务系统。**优先走 SSO 换票**（ChillEast 实际用的路径），
 * 换票拿不到 token 时再退回用户名密码直登。
 *
 * @param ssoSession 已经在统一认证里登录过的会话（罐子里有 TGC）
 */
export async function loginYdjwxt(
  ssoSession: CookieSession,
  username: string,
  password: string,
): Promise<YdjwxtSession> {
  // ---- 主路径：超星 OAuth 链（照抄 ChillEast 的入口）--------------------
  let oauthTrace = '';
  try {
    const walk = await walkYdjwxtOAuth(ssoSession);
    oauthTrace = walk.hops.length === 0 ? '(没有产生任何跳转)' : walk.hops.join(' -> ');

    if (walk.token !== undefined) {
      return { session: ssoSession, token: walk.token, userType: null };
    }
    if (walk.askToken !== undefined) {
      const token = await exchangeAskToken(ssoSession, walk.askToken);
      if (token !== null) {
        return { session: ssoSession, token, userType: null };
      }
      oauthTrace += '（拿到 askToken 但换真 token 失败）';
    } else if (walk.bouncedToPassport === true) {
      oauthTrace +=
        '（被弹到超星 passport 登录页 —— 说明登录链产出的 .chaoxing.com Cookie 没生效，' +
        '不是 token 提取的问题）';
    } else {
      oauthTrace += '（整条链没有出现 token / askToken）';
    }
  } catch (error) {
    oauthTrace = error instanceof Error ? error.message : String(error);
  }

  // ---- 兜底：用户名密码直登（SPA 的 userLoginApi）-----------------------
  try {
    const direct = await loginByPassword(username, password);
    if (direct !== null) return direct;
  } catch (error) {
    oauthTrace += `；直登也抛错：${error instanceof Error ? error.message : String(error)}`;
  }

  throw new Error(
    `移动教务登录失败。超星 OAuth 跳转链：${oauthTrace}。` +
      '用户名密码直登也未返回 token。',
  );
}

/** 带 token 调一次 JSON 接口；token 失效时抛 SessionExpiredError。 */
async function callApi(
  auth: YdjwxtSession,
  path: string,
  options: { query?: Record<string, string>; body?: string } = {},
): Promise<unknown> {
  // 复用登录时那个会话 —— 它的 Cookie 罐里有登录下发的会话 Cookie
  const search = new URLSearchParams(options.query ?? {});
  const url = `${BASE}${path}${search.size > 0 ? `?${search}` : ''}`;

  const response = await auth.session.request(url, {
    method: 'POST',
    body: options.body ?? '',
    headers: {
      ...API_HEADERS,
      'Content-Type': 'application/json',
      token: auth.token,
    },
    guard: (parsed) =>
      parsed.protocol === 'https:' && parsed.hostname === new URL(HOSTS.ydjwxt).hostname,
  });

  const envelope = parseEnvelope(response.body, response.status);
  if (isAuthFailure(envelope)) {
    throw new SessionExpiredError('移动教务 token 已失效');
  }
  if (codeOf(envelope) !== '1') {
    // 把状态码与响应片段带上：契约是从前端代码还原的，失败时需要这些才能校准
    const detail = `HTTP ${response.status}，响应片段：${snippet(response.body)}`;
    throw new Error(
      envelope.Msg !== undefined && envelope.Msg !== ''
        ? `移动教务接口错误：${envelope.Msg}（${detail}）`
        : `移动教务接口返回 code=${codeOf(envelope)}（${detail}）`,
    );
  }
  return envelope.data;
}

/** 截断响应片段用于报错，避免刷屏（响应里不会有我们的密码）。 */
function snippet(body: string, max = 200): string {
  const trimmed = body.trim().replace(/\s+/g, ' ');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/** 学期列表。 */
export async function fetchSemesters(auth: YdjwxtSession): Promise<unknown> {
  return await callApi(auth, '/semesterList');
}

/** 某学期成绩。 */
export async function fetchScores(auth: YdjwxtSession, semester: string): Promise<unknown> {
  return await callApi(auth, '/student/termGPA', {
    query: { semester, type: '1' },
    // 部分部署要求有 body 才认 POST，空对象比空字符串更稳妥
    body: '{}',
  });
}

export interface TimetableCourse {
  name: string;
  teacher: string;
  classroom: string;
  dayOfWeek: number;
  startPeriod: number;
  endPeriod: number;
  periods: string;
  weeks: string;
}

export interface TimetableWeek {
  week: number;
  /** 该周的日期（含星期几），来自接口的 date 数组 */
  dates: Array<{ weekday: string; date: string }>;
  courses: TimetableCourse[];
}

/**
 * 解析一节次编码。
 * 线上样例："10304" -> 第 03-04 节；"609101112" -> 第 09-12 节。
 * 逻辑与 Dart 侧 `YdjwxtJsonParser` 一致，并保留 weekNoteDetail / coursesNote 兜底。
 */
function parsePeriods(item: Record<string, unknown>): { start: number; end: number } {
  let start = 0;
  let end = 0;

  const classTime = String(item['classTime'] ?? '');
  if (classTime.length >= 3) {
    start = Number.parseInt(classTime.slice(1, 3), 10) || 0;
    end = Number.parseInt(classTime.slice(-2), 10) || start;
  }

  if (start === 0 || end === 0) {
    const parts = String(item['weekNoteDetail'] ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    if (parts.length > 0) {
      const first = parts[0];
      const last = parts[parts.length - 1];
      start = Number.parseInt(first.length > 2 ? first.slice(-2) : first, 10) || 0;
      end = Number.parseInt(last.length > 2 ? last.slice(-2) : last, 10) || start;
    }
  }

  const coursesNote = Number.parseInt(String(item['coursesNote'] ?? ''), 10) || 0;
  if (start > 0 && coursesNote > 0 && end < start + coursesNote - 1) {
    end = start + coursesNote - 1;
  }
  return { start, end };
}

/** 拉某一周的课表并整理成结构化数据。 */
export async function fetchTimetableWeek(auth: YdjwxtSession, week: number): Promise<TimetableWeek> {
  const data = await callApi(auth, '/student/curriculum', {
    query: { week: String(week), kbjcmsid: '' },
    body: '{}',
  });

  const empty: TimetableWeek = { week, dates: [], courses: [] };
  if (!Array.isArray(data) || data.length === 0) return empty;

  const first = data[0];
  if (typeof first !== 'object' || first === null) return empty;
  const record = first as Record<string, unknown>;

  const dates: Array<{ weekday: string; date: string }> = [];
  if (Array.isArray(record['date'])) {
    for (const entry of record['date'] as Array<Record<string, unknown>>) {
      if (typeof entry !== 'object' || entry === null) continue;
      dates.push({
        weekday: String(entry['xqid'] ?? ''),
        date: String(entry['mxrq'] ?? ''),
      });
    }
  }

  const courses: TimetableCourse[] = [];
  if (Array.isArray(record['courses'])) {
    for (const raw of record['courses'] as Array<Record<string, unknown>>) {
      if (typeof raw !== 'object' || raw === null) continue;
      const name = String(raw['courseName'] ?? '');
      if (name === '') continue;
      const { start, end } = parsePeriods(raw);
      const rawDay = Number.parseInt(String(raw['weekDay'] ?? ''), 10) || 0;
      const weeksRaw = String(raw['classWeek'] ?? '');
      courses.push({
        name,
        teacher: String(raw['teacherName'] ?? ''),
        classroom: String(raw['classroomName'] ?? ''),
        // 教务系统用 0 表示周日
        dayOfWeek: rawDay === 0 ? 7 : rawDay,
        startPeriod: start,
        endPeriod: end,
        periods: start > 0 && end > 0 ? `${String(start).padStart(2, '0')}-${String(end).padStart(2, '0')}` : '',
        weeks: weeksRaw.includes('(周)') ? weeksRaw : `${weeksRaw}(周)`,
      });
    }
  }

  return { week, dates, courses };
}
