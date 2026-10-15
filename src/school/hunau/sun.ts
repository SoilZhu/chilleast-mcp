/**
 * 阳光服务（sun.hunau.edu.cn）客户端：CAS 换会话后走 `.ashx` 数据接口，提交走 form.ashx。
 *
 * - 会话：CAS oauth2 authorize 链**逐跳手动跟随（≤8 跳）**，每跳 Set-Cookie 落罐；
 *   `http://sun.hunau.edu.cn` 必须升级 https —— 浏览器靠 HSTS，fetch 不会。
 * - `.ashx` 响应体是 GBK，**不信任响应头声明的 charset**：老 ASP.NET 站常声明
 *   `charset=utf-8` 却吐 GBK 字节，照声明解会乱码，故自取原始字节、冲突回退 GB18030。
 * - 提交 `POST /AJAX/form.ashx?AFlag=insert` **不跟随重定向**：响应未知时宁可报 unknown
 *   让用户去官网核实，也不能重复投递。
 * - 身份信息从 `GET /form.aspx?type=2` 的 HTML 抓 `h_CardCode`/`UserName` 等字段。
 * - ⚠️ 链路移植自 Dart 源码，**尚未用真实账号验证**。
 */

import { CookieSession, encodeForm } from '../../auth/http';
import { SessionExpiredError } from '../../auth/session-manager';
import { HOSTS, URLS } from './constants';

const SUN_HOST = new URL(HOSTS.sun).hostname;
const SUN_BASE = HOSTS.sun;

/** 授权链最多跳数（Dart `_authorize` 写死 8）。 */
const AUTH_MAX_HOPS = 8;

const DATA_TIMEOUT_MS = 30_000;

export interface SunshineIdentity {
  cardCode: string;
  name: string;
  phone: string;
  email: string;
}

export interface SunshineDepartment {
  code: string;
  name: string;
}

export interface SunshineFormData {
  identity: SunshineIdentity;
  departments: SunshineDepartment[];
}

/** 诉求类别：1-投诉 2-咨询 3-建议 4-表扬（Dart `typeNames`）。 */
export const SUNSHINE_TYPE_NAMES: Readonly<Record<string, string>> = {
  '1': '投诉',
  '2': '咨询',
  '3': '建议',
  '4': '表扬',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 纯逻辑（有单元测试）
// ---------------------------------------------------------------------------

/**
 * 解码 sun.hunau.edu.cn 的响应体。
 *
 * 规则（对应 Dart 的 `_decodeGbk`）：
 *  1. 响应头声明 gb2312 / gbk / gb18030，或**根本没声明** -> 用 `gb18030` 解
 *     （gb18030 是 GBK 的超集，`TextDecoder` 在 workerd 里原生支持，不需要 GBK 表）。
 *  2. 声明了别的字符集：先按声明的解；若解出替换字符 `U+FFFD`（说明声明与字节不符），
 *     回退 `gb18030`。GBK 汉字按 UTF-8 解几乎必然产生 U+FFFD，所以这个判据很可靠。
 */
export function decodeSunshineText(bytes: Uint8Array, contentType: string | null): string {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1]?.toLowerCase();
  const isGb =
    declared === undefined ||
    declared === 'gb2312' ||
    declared === 'gbk' ||
    declared === 'gb18030';

  if (isGb) return new TextDecoder('gb18030').decode(bytes);

  let decoded: string;
  try {
    decoded = new TextDecoder(declared).decode(bytes);
  } catch {
    return new TextDecoder('gb18030').decode(bytes);
  }
  if (decoded.includes('\uFFFD')) {
    return new TextDecoder('gb18030').decode(bytes);
  }
  return decoded;
}

/** `form.aspx` 里承载身份信息的元素 id（Dart `SunshineIdentity.fromHtml`）。 */
const IDENTITY_FIELD_IDS = new Set(['h_CardCode', 'UserName', 'telPhone', 'email']);

/**
 * 从 `form.aspx?type=2` 的 HTML 里抽身份字段（Dart `SunshineIdentity.fromHtml`）。
 * 用 Cloudflare 原生 `HTMLRewriter`，不引 DOM 库。
 * 只有 `h_CardCode` 与 `UserName` 都存在才算拿到身份，否则返回 null
 * —— 拿不到通常意味着会话失效、返回的是登录页。
 */
export async function parseSunshineIdentity(html: string): Promise<SunshineIdentity | null> {
  // HTMLRewriter 对**空响应体**的 transform 不会 resolve（workerd 实测会一直挂住），
  // 所以空页面直接短路 —— 这种情况本来就等同于「没拿到身份」。
  if (html.trim() === '') return null;

  const values: Record<string, string> = {};

  const rewriter = new HTMLRewriter().on('input, textarea', {
    element(element) {
      const id = element.getAttribute('id');
      if (id === null || !IDENTITY_FIELD_IDS.has(id)) return;
      const value = element.getAttribute('value');
      if (value === null) return;
      values[id] = value.trim();
    },
  });

  await rewriter.transform(new Response(html)).text();

  const cardCode = values['h_CardCode'] ?? '';
  const name = values['UserName'] ?? '';
  if (cardCode === '' || name === '') return null;
  return {
    cardCode,
    name,
    phone: values['telPhone'] ?? '',
    email: values['email'] ?? '',
  };
}

/** 类别归一：数字或汉字都能认，认不出按「咨询」（Dart 的 if/else 链）。 */
export function normalizeSunshineType(input: string): '1' | '2' | '3' | '4' {
  const text = input.trim();
  if (text === '1' || text.includes('投诉')) return '1';
  if (text === '3' || text.includes('建议')) return '3';
  if (text === '4' || text.includes('表扬')) return '4';
  return '2';
}

/** 受理单位匹配：先精确（名称或 code），再互相包含（Dart 的两轮循环）。 */
export function findSunshineDepartment(
  departments: readonly SunshineDepartment[],
  input: string,
): SunshineDepartment | null {
  const text = input.trim();
  if (text === '') return null;
  const exact = departments.find(
    (department) => department.name === text || department.code === text,
  );
  if (exact !== undefined) return exact;
  const fuzzy = departments.find(
    (department) => department.name.includes(text) || text.includes(department.name),
  );
  return fuzzy ?? null;
}

/** 期望解决时间默认值：今天 +7 天，`YYYY-MM-DD`（Dart 用设备本地日期）。 */
export function defaultSunshineFinishTime(now: Date = new Date()): string {
  const china = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000 + 8 * 60 * 60 * 1000);
  const month = (china.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = china.getUTCDate().toString().padStart(2, '0');
  return `${china.getUTCFullYear()}-${month}-${day}`;
}

/** 提交返回值：1/2 = 成功（2 表示待审核），errer = 服务端报错，其余按未知处理。 */
export type SunshineSubmitResult = '1' | '2' | 'errer' | 'unknown';

export function parseSunshineSubmitResult(body: string): SunshineSubmitResult {
  const text = body.trim();
  if (text === '1' || text === '2' || text === 'errer') return text;
  return 'unknown';
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface SunshineResponse {
  status: number;
  /** 已经按 GBK 优先解码好的文本 */
  text: string;
}

/**
 * 访问 sun.hunau.edu.cn 的数据接口：手动带 Cookie、不跟随重定向、按 GBK 优先解码。
 * 与 `CookieSession.request` 的差别只有两点：显式字符集策略，以及不跟跳
 * —— 这三处调用（form.aspx / form.ashx）在 Dart 侧也都不需要跟随重定向。
 */
async function requestSunshine(
  session: CookieSession,
  url: string,
  options: { method: 'GET' | 'POST'; form?: Array<[string, string]> },
): Promise<SunshineResponse> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.hostname !== SUN_HOST) {
    throw new Error(`阳光服务请求被安全策略拦截：${target.origin}`);
  }

  const headers = new Headers({
    Accept:
      options.method === 'POST'
        ? 'application/json, text/javascript, */*; q=0.01'
        : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: `${SUN_BASE}/form.aspx?type=2`,
  });
  if (options.form !== undefined) {
    headers.set('Content-Type', 'application/x-www-form-urlencoded');
  }
  const cookie = session.jar.getCookieHeader(url);
  if (cookie !== null) headers.set('Cookie', cookie);

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method,
      headers,
      body: options.form === undefined ? undefined : encodeForm(options.form),
      redirect: 'manual',
      signal: AbortSignal.timeout(DATA_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`网络请求失败（${SUN_HOST}）：${reason}`);
  }

  // 会话 Cookie 仍由 CookieSession 的罐子持有，逐响应收进来
  session.jar.absorb(url, response.headers.getSetCookie());

  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    text: decodeSunshineText(bytes, response.headers.get('content-type')),
  };
}

/** 只允许在 hunau.edu.cn 之内跳转（后缀匹配要防 `evilhunau.edu.cn`）。 */
function isHunauHost(hostname: string): boolean {
  return hostname === 'hunau.edu.cn' || hostname.endsWith('.hunau.edu.cn');
}

/**
 * OAuth2 授权：从 SSO 一路跟到 sun，把 sun 的会话 Cookie 落进罐子。
 * 必须逐跳（`follow: false`），否则中间几跳的 Set-Cookie 会丢。
 */
async function authorizeSunshine(session: CookieSession): Promise<void> {
  let current = URLS.sunOAuth;

  for (let hop = 0; hop < AUTH_MAX_HOPS; hop++) {
    const response = await session.get(current, {
      follow: false,
      upgradeInsecureHosts: [SUN_HOST],
      guard: (url) => url.protocol === 'https:' && isHunauHost(url.hostname),
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    const location = response.headers.get('location');
    if (location === null || location === '') break;

    const next = new URL(location, response.url);
    // 与报修同理：http://sun.hunau.edu.cn/... 靠 HSTS 升级，fetch 不会
    if (next.protocol === 'http:' && isHunauHost(next.hostname)) {
      next.protocol = 'https:';
    }
    if (next.toString() === current) break;
    current = next.toString();
  }
}

async function fetchSunshineIdentity(session: CookieSession): Promise<SunshineIdentity | null> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await requestSunshine(session, `${SUN_BASE}/form.aspx?type=2`, {
        method: 'GET',
      });
      if (response.status !== 200) return null;
      return await parseSunshineIdentity(response.text);
    } catch (error) {
      lastError = error;
      // Dart 对这个老 ASP.NET 站在超时/连接错误时会重试一次（400ms 后）
      if (attempt === 0) await delay(400);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('阳光服务表单响应失败，请稍后重试');
}

function parseAshxObject(response: SunshineResponse): Record<string, unknown> {
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
    // ASP.NET 会话失效时会把 .ashx 重定向到登录页
    throw new SessionExpiredError('阳光服务会话已失效');
  }
  if (response.status !== 200) {
    throw new Error('阳光服务暂时不可用，请稍后重试');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text.trim());
  } catch {
    // HTML 登录页、服务器错误页不能当作空列表
    throw new Error('未能读取阳光服务数据，请检查登录状态后重试');
  }
  if (!isRecord(parsed)) throw new Error('阳光服务返回的数据格式异常');
  return parsed;
}

function parseAshxRows(response: SunshineResponse): Array<Record<string, unknown>> {
  const rows = parseAshxObject(response)['rows'];
  if (!Array.isArray(rows) || rows.some((row) => !isRecord(row))) {
    throw new Error('阳光服务返回的数据格式异常');
  }
  return rows.filter(isRecord);
}

/**
 * 拉取填报页所需的全部环境：身份信息 + 可受理单位列表（Dart `fetchForm`）。
 *
 * Dart 的顺序是：读身份 -> 失败则走一次 OAuth 授权 -> 再读 -> 仍失败则用
 * `silentLogin()` 重登后再来一遍。在服务端最后那一步交给 `runWithSession`：
 * 我们抛 `SessionExpiredError`，外层会清掉缓存会话、重新登录、再调用本函数。
 */
export async function fetchSunshineForm(session: CookieSession): Promise<SunshineFormData> {
  let identity = await fetchSunshineIdentity(session);
  if (identity === null) {
    // 优先复用现有 TGC，避免每次进入填报页都重新认证
    await authorizeSunshine(session);
    identity = await fetchSunshineIdentity(session);
  }
  if (identity === null) {
    throw new SessionExpiredError('阳光服务登录已失效，请重试');
  }

  // Dart 这里把 AFlag 放在 **body** 里（不是 query），照抄
  const response = await requestSunshine(session, `${SUN_BASE}/AJAX/form.ashx`, {
    method: 'POST',
    form: [['AFlag', 'LoadCompany']],
  });
  const departments = parseAshxRows(response)
    .map((row) => ({
      code: str(row['Company_code']),
      name: str(row['Company_name']),
    }))
    .filter((department) => department.code !== '' && department.name !== '');

  if (departments.length === 0) throw new Error('暂无可用受理单位，请稍后重试');
  return { identity, departments };
}

export interface SunshineLetterInput {
  identity: SunshineIdentity;
  department: SunshineDepartment;
  /** 1-投诉 2-咨询 3-建议 4-表扬 */
  type: string;
  title: string;
  content: string;
  phone: string;
  email: string;
  /** `YYYY-MM-DD` */
  finishTime: string;
}

/**
 * 提交诉求（Dart `submit`）。
 * **不做自动重试**：响应未知时让用户到官网核实，避免重复投递。
 */
export async function submitSunshineLetter(
  session: CookieSession,
  input: SunshineLetterInput,
): Promise<SunshineSubmitResult> {
  const response = await requestSunshine(session, `${SUN_BASE}/AJAX/form.ashx?AFlag=insert`, {
    method: 'POST',
    form: [
      ['type1', input.type],
      ['depid', input.department.code],
      ['depname', input.department.name],
      ['title', input.title.trim()],
      ['content', input.content.trim()],
      ['username', input.identity.name],
      ['telphone', input.phone.trim()],
      ['email', input.email.trim()],
      ['finishtime', input.finishTime],
      ['captchas', ''],
      ['CardCode', input.identity.cardCode],
    ],
  });
  if (response.status !== 200) return 'unknown';
  return parseSunshineSubmitResult(response.text);
}
