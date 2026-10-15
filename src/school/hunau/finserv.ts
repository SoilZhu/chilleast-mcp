/**
 * 一卡通财务服务平台（fin-serv.hunau.edu.cn）客户端：授权链、卡片信息、电费与流水。
 *
 * - 动态 AES（密钥取自 62 字符表，即 `handleKey` 的移位/反转）；信封
 *   `{"datajson":"<base64>"}` → `{"success":true,"message":"…","resultData":{…}}`。
 * - ⚠️ **判成功只看 `success`**，不能拿 message 当判据 —— 成功也可能带 `CORE10008` 串。
 * - 卡片信息字段位置不统一：付款码页在 `<p class="bdb">…</p>`，充值页在隐藏 input 与
 *   `<label>卡余额</label><p>…</p>` 里；授权链 5 跳 302、需升级 https。
 * - ⚠️ 电费（`channel/*`、`elepay/createPreThirdTrade`）与流水
 *   （`selftrade/queryCardSelfTradeList`）无抓包、字段全来自 Dart 源码，其余已核对 HAR。
 */

import { aesEcbDecryptUtf8Key, aesEcbEncryptUtf8Key } from '../../util/aes';
import { b64ToBytes, bytesToB64 } from '../../util/bytes';
import type { CookieSession } from '../../auth/http';
import { SessionExpiredError } from '../../auth/session-manager';
import { CHAOXING_UA, FIN_SERV_INSECURE_HOSTS, HOSTS, URLS } from './constants';

// ===========================================================================
// 1. DkywCrypto —— 对齐 lib/core/utils/dkyw_crypto.dart
// ===========================================================================

/** 一次性 AES 密钥字符表，与 Dart `DkywCrypto._chars` 一致（62 个）。 */
export const DK_KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * 拒绝采样上界：`floor(256 / 62) * 62 = 248`。
 * Dart 用的是 `Random()`（非密码学随机）；这里换成 `crypto.getRandomValues`
 * 并做拒绝采样，避免 `% 62` 带来的模偏置。密钥本身会明文拼在密文前面，
 * 所以这不是安全边界，只是不想凭空引入偏置。
 */
const DK_REJECTION_LIMIT = 248;

/** 生成 16 位随机 AES 密钥（只含 `[A-Za-z0-9]`）。 */
export function generateDataKey(length = 16): string {
  const out: string[] = [];
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array((length - out.length) * 2));
    for (const byte of bytes) {
      if (byte >= DK_REJECTION_LIMIT) continue;
      out.push(DK_KEY_ALPHABET[byte % DK_KEY_ALPHABET.length]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

/**
 * 对应前端 `my-encryption.js` 的 handleKey 移位 + 字符反转。
 *
 *   加密（0x288de ^ 0x288d4 = 10）：`key[10:] + key[:10]`，再整体反转
 *   解密（0x59183 ^ 0x59185 = 6） ：整体反转后，把开头 6 个字符挪到末尾
 *
 * 两者互逆（10 + 6 = 16）。密钥恒为 16 位，长度不对直接报错，
 * 免得静默算出垃圾密钥后报一个和根因无关的 AES 错误。
 */
export function handleKey(key: string, isEncrypt: boolean): string {
  const chars = [...key];
  if (chars.length !== 16) {
    throw new Error(`DkywCrypto: handleKey 需要 16 位密钥，实际收到 ${chars.length} 位`);
  }
  if (isEncrypt) {
    const rotated = chars.slice(10).join('') + chars.slice(0, 10).join('');
    return [...rotated].reverse().join('');
  }
  const reversed = [...chars].reverse().join('');
  return reversed.slice(6) + reversed.slice(0, 6);
}

/**
 * 请求加密：`handleKey(随机key, true) + base64(AES-ECB-PKCS7(json))`。
 * 对齐 Dart `DkywCrypto.encryptPayload`（对象先 `jsonEncode`；字符串原样）。
 */
export function encryptPayload(data: unknown): string {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  const key = generateDataKey(16);
  return handleKey(key, true) + bytesToB64(aesEcbEncryptUtf8Key(key, json));
}

/**
 * 响应解密：前 16 位是（反转过的）密钥，其余是 base64 密文。
 * 明文能 `JSON.parse` 就返回对象，否则原样返回字符串。
 */
export function decryptPayload(datajson: string): unknown {
  if (datajson.length <= 16) return datajson;
  const realKey = handleKey(datajson.slice(0, 16), false);
  const plaintext = aesEcbDecryptUtf8Key(realKey, b64ToBytes(datajson.slice(16)));
  try {
    return JSON.parse(plaintext) as unknown;
  } catch {
    return plaintext;
  }
}

/** 非数组的对象才当 Map 用（对齐 Dart 的 `is Map`，`is List` 不算）。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asJsonPayload(value: unknown): Record<string, unknown> | unknown[] | null {
  if (Array.isArray(value)) return value;
  return asRecord(value);
}

/** 明文本身是 JSON 字符串时再解一层（对齐 Dart 里那段 `if (decrypted is String)`）。 */
function parseIfJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/**
 * 从服务端原始响应里解出 datajson。Dart 里那一串兼容分支全部保留：
 *   1. `{'datajson': '…'}`（Dio 已解析成 Map）
 *   2. `'{"datajson": "…"}'`（原始 JSON 字符串）
 *   3. `'"{&quot;datajson&quot;:&quot;…&quot;}"'`
 *      —— `createPreThirdTrade` 常见这种 HTML 转义 + 外层引号包裹
 *   4. 其它格式异常但能被正则捞出密文的字符串
 */
export function decryptServerResponse(responseData: unknown): unknown {
  if (responseData === null || responseData === undefined) return null;

  // 1. 已经是对象
  const record = asRecord(responseData);
  if (record !== null) {
    if ('datajson' in record) {
      return parseIfJsonString(decryptPayload(String(record['datajson'])));
    }
    return record;
  }

  // 2. 字符串
  if (typeof responseData === 'string') {
    let raw = responseData.trim();

    // 剥掉外层多余引号（`"…"` 是合法的 JSON 字符串字面量，直接用 JSON.parse 解转义）
    if (raw.length > 2 && raw.startsWith('"') && raw.endsWith('"')) {
      try {
        const unquoted = JSON.parse(raw) as unknown;
        raw = typeof unquoted === 'string' ? unquoted : raw.slice(1, -1);
      } catch {
        raw = raw.slice(1, -1);
      }
    }

    // HTML 转义
    if (raw.includes('&quot;')) raw = raw.replaceAll('&quot;', '"');

    // 标准 JSON
    try {
      const parsed = JSON.parse(raw) as unknown;
      const parsedRecord = asRecord(parsed);
      if (parsedRecord !== null) return decryptServerResponse(parsedRecord);
    } catch {
      // 不是合法 JSON，落到下面的正则兜底
    }

    // 正则直接捞 datajson 密文
    const match = /datajson["']?\s*[:=]\s*["']?([A-Za-z0-9+/=]+)/.exec(raw);
    if (match !== null && match[1] !== '') {
      return parseIfJsonString(decryptPayload(match[1]));
    }
  }

  return responseData;
}

// ===========================================================================
// 2. HTTP —— 授权链与通用请求
// ===========================================================================

/** 授权链最多跳数（HAR 实测 5 跳，留一倍余量）。 */
const AUTH_MAX_HOPS = 10;

const PAGE_HEADERS = {
  'User-Agent': CHAOXING_UA,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Upgrade-Insecure-Requests': '1',
} as const;

/**
 * fin-serv 的 ajax 接口对 UA 与 X-Requested-With 都敏感。
 * `Origin` 是 HAR 里真实浏览器带的（Dio 不带也能过），同源值不会有副作用，
 * 但万一服务端上了同源校验，带上更保险。
 */
const AJAX_HEADERS = {
  'User-Agent': CHAOXING_UA,
  'X-Requested-With': 'XMLHttpRequest',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  Origin: HOSTS.finServ,
} as const;

/** 服务端限流页的固定文案（Dart 里判的就是这两个词）。 */
const RATE_LIMIT_MARKERS = ['资源受限', '页面丢失'] as const;

/**
 * 会话失效的判定。
 *
 * 特意要求「统一身份认证」和 password 输入框同时出现，因为校园站点的页脚
 * 常年挂着「统一身份认证」链接，单看这一个词会误判。
 */
function looksLikeLoginPage(body: string): boolean {
  if (body.includes('cas/login')) return true;
  return (
    body.includes('统一身份认证') &&
    (body.includes('type="password"') || body.includes('name="password"'))
  );
}

/**
 * HTML 页面健康检查。
 *
 * 「资源受限 / 页面丢失」按 Dart 自己的注释是**服务端限流**，不是 Cookie 问题，
 * 所以抛普通 Error —— 让外层再登录一次纯属浪费（重登并不能解除限流）。
 * 会话失效才抛 `SessionExpiredError` 交给 `runWithSession` 重登重试。
 */
function assertUsablePage(body: string, finalUrl: string, what: string): void {
  if (finalUrl.includes('errorPage') || RATE_LIMIT_MARKERS.some((marker) => body.includes(marker))) {
    throw new Error(`${what}失败：一卡通平台提示「资源受限，页面丢失」，请稍后重试`);
  }
  if (looksLikeLoginPage(body)) {
    throw new SessionExpiredError(`${what}失败：一卡通平台要求重新登录`);
  }
}

/** 拿到了 JSON，但里面可能是业务错误 / 会话失效提示。 */
function assertBusinessPayload(
  payload: Record<string, unknown> | unknown[],
  what: string,
): Record<string, unknown> {
  const record = asRecord(payload);
  if (record === null) {
    throw new SessionExpiredError(`${what}失败：一卡通平台返回了非预期的 JSON 结构`);
  }
  const message = firstString(record, ['message', 'msg']);
  if (message.includes('openid无效') || message.includes('未登录') || message.includes('会话过期')) {
    throw new SessionExpiredError(`${what}失败：${message}`);
  }
  if (RATE_LIMIT_MARKERS.some((marker) => message.includes(marker))) {
    throw new Error(`${what}失败：${message}（请稍后重试）`);
  }
  return record;
}

/** 取第一个非空字段（Dart 的 `a ?? b ?? c`，但顺手跳过空串）。 */
function firstString(
  source: Record<string, unknown>,
  keys: readonly string[],
  fallback = '',
): string {
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null || value === '') continue;
    return String(value);
  }
  return fallback;
}

function toRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record !== null) out.push(record);
  }
  return out;
}

/**
 * 从业务响应里挖列表。Dart 每个 service 都写了一串形状兼容，这里统一成：
 *   整体是数组 -> `resultData` 里的具名数组 -> `resultData` 本身是数组
 *   -> `resultData` 里第一个数组字段（流水查询 Dart 就是这么兜的）-> `data`
 */
function extractList(
  payload: Record<string, unknown> | unknown[],
  keys: readonly string[],
): Record<string, unknown>[] {
  if (Array.isArray(payload)) return toRecords(payload);

  const resultData = payload['resultData'];
  const resultRecord = asRecord(resultData);
  if (resultRecord !== null) {
    for (const key of keys) {
      const list = toRecords(resultRecord[key]);
      if (list.length > 0) return list;
    }
    for (const value of Object.values(resultRecord)) {
      const list = toRecords(value);
      if (list.length > 0) return list;
    }
  }

  const nested = toRecords(resultData);
  if (nested.length > 0) return nested;
  return toRecords(payload['data']);
}

/** 一次已授权的 fin-serv 会话。 */
export interface FinServSession {
  session: CookieSession;
  /**
   * 96 位大写 hex。fin-serv 把它当成「已授权的用户句柄」放在 query 里，
   * 不是 Cookie —— Cookie 只用来维持会话。
   */
  openid: string;
  /** 已预热过的子系统入口，避免一次工具调用里重复打同一个页面。 */
  warmed?: Set<string>;
}

export interface FinServConnectOptions {
  /** 结构性日志，别把 openid / Cookie 打进去。 */
  log?: (message: string) => void;
}

/**
 * 走完整条授权链拿 openid。
 *
 * 逐跳手动跟随（`follow: false`）而不是一把 `follow: true`，原因有三：
 *   1. 要在每一跳之间把 Referer 设成上一跳的 URL（Dart 就是这么做的）；
 *   2. 一撞上 `errorPage` 就立刻停，不去解析那个页面；
 *   3. 跳数和最终 URL 需要进日志，出问题时才定位得到是哪一跳开始偏的。
 */
export async function connectFinServ(
  session: CookieSession,
  options: FinServConnectOptions = {},
): Promise<FinServSession> {
  const log = options.log ?? ((): void => undefined);

  let url: string = URLS.campusCardAuthorize;
  let referer: string | undefined;
  let finalUrl = url;
  let finalBody = '';
  let landed = false;

  for (let hop = 0; hop < AUTH_MAX_HOPS; hop++) {
    const response = await session.get(url, {
      follow: false,
      headers: {
        ...PAGE_HEADERS,
        ...(referer === undefined ? {} : { Referer: referer }),
      },
      upgradeInsecureHosts: FIN_SERV_INSECURE_HOSTS,
    });

    finalUrl = response.url;
    finalBody = response.body;

    const location = response.headers.get('location') ?? '';
    if (response.status >= 300 && response.status < 400 && location !== '') {
      const next = new URL(location, response.url).toString();
      if (next.includes('errorPage')) {
        throw new Error('一卡通授权失败：平台跳到了 errorPage（资源受限，页面丢失），请稍后重试');
      }
      referer = response.url;
      url = next;
      continue;
    }

    log(`fin-serv 授权链第 ${hop + 1} 跳落地：HTTP ${response.status}`);
    landed = true;
    break;
  }

  if (!landed) {
    throw new Error(`一卡通授权失败：跳转超过 ${AUTH_MAX_HOPS} 跳仍未落地`);
  }

  const openid = extractOpenId(finalUrl, finalBody);
  if (openid === '') {
    // 先让限流 / 登录页把自己的错误抛出来，剩下的才归因到超星登录态
    assertUsablePage(finalBody, finalUrl, '一卡通授权');
    throw new SessionExpiredError('一卡通授权未拿到 openid（超星登录态可能已失效）');
  }

  log(`fin-serv 已授权（openid ${openid.length} 位）`);
  return { session, openid };
}

/**
 * 三级提取，与 Dart `CampusCardService.authenticate` 完全一致。
 * 后两级只在前一级落空时才跑，避免对整页做多次扫描。
 */
function extractOpenId(finalUrl: string, body: string): string {
  try {
    const fromQuery = new URL(finalUrl).searchParams.get('openid');
    if (fromQuery !== null && fromQuery !== '') return fromQuery;
  } catch {
    // finalUrl 理论上一定合法；万一不合法就退到正则
  }
  const fromBody = /openHomePage\?openid=([A-Za-z0-9]+)/.exec(body);
  if (fromBody !== null && fromBody[1] !== '') return fromBody[1];
  const loose = /openid["'=:\s]+([A-Fa-f0-9]{32,})/.exec(`${body} ${finalUrl}`);
  if (loose !== null && loose[1] !== '') return loose[1];
  return '';
}

export function openHomePageUrl(openid: string): string {
  return `${HOSTS.finServ}/homeCX/openHomePage?${new URLSearchParams({ openid, usertype: '2' })}`;
}

export function openVirtualcardUrl(openid: string): string {
  return `${HOSTS.finServ}/virtualcard/openVirtualcard?${new URLSearchParams({
    openid,
    displayflag: '1',
    id: '27',
  })}`;
}

export function openCardPayUrl(openid: string): string {
  return `${HOSTS.finServ}/cardpay/openCardPay?${new URLSearchParams({
    openid,
    displayflag: '1',
    id: '28',
  })}`;
}

/** ⚠️ 未经实测：电费子系统入口。 */
export function openElePayUrl(openid: string): string {
  return `${HOSTS.finServ}/elepay/openElePay?${new URLSearchParams({
    openid,
    displayflag: '1',
    id: '30',
  })}`;
}

/** ⚠️ 未经实测：流水查询子系统入口。 */
export function openQueryCardSelfTradeUrl(openid: string): string {
  const query = new URLSearchParams({ openid, displayflag: '1', id: '4' });
  return `${HOSTS.finServ}/selftrade/openQueryCardSelfTrade?${query}`;
}

/** GET 一个 fin-serv 页面并做健康检查。 */
async function fetchPage(
  ctx: FinServSession,
  url: string,
  what: string,
  referer?: string,
): Promise<string> {
  const response = await ctx.session.get(url, {
    headers: {
      ...PAGE_HEADERS,
      ...(referer === undefined ? {} : { Referer: referer }),
    },
    upgradeInsecureHosts: FIN_SERV_INSECURE_HOSTS,
  });
  if (response.status !== 200) {
    throw new Error(`${what}失败（HTTP ${response.status}）`);
  }
  assertUsablePage(response.body, response.url, what);
  return response.body;
}

/**
 * 进某个子系统前先 GET 一次它的入口页，把 fin-serv 侧的 session 设起来。
 * Dart 在 `fetchPaymentCode` 里专门注释过：不预热大概率直接 errorPage。
 * 同一次工具调用里重复调用是空操作。
 */
async function warmUp(ctx: FinServSession, key: string, url: string, what: string): Promise<void> {
  if (ctx.warmed !== undefined && ctx.warmed.has(key)) return;
  await fetchPage(ctx, url, what);
  (ctx.warmed ??= new Set<string>()).add(key);
}

/**
 * POST 一个 datajson 加密接口。
 *
 * ⚠️ 与 Dart 的一个有意分歧：Dart 在 message 命中「页面丢失 / 资源受限」时也会
 * 清会话重登一次；那按它自己的注释是服务端限流，重登不解决问题，这里只抛普通
 * Error。「openid无效 / 未登录 / 会话过期」仍然抛 `SessionExpiredError`。
 */
async function postDatajson(
  ctx: FinServSession,
  endpoint: string,
  payload: Record<string, unknown>,
  what: string,
  referer?: string,
): Promise<Record<string, unknown> | unknown[]> {
  const query = new URLSearchParams({ openid: ctx.openid, connect_redirect: '1' });
  const response = await ctx.session.postJson(
    `${HOSTS.finServ}${endpoint}?${query.toString()}`,
    { datajson: encryptPayload(payload) },
    {
      headers: {
        ...AJAX_HEADERS,
        ...(referer === undefined ? {} : { Referer: referer }),
      },
      upgradeInsecureHosts: FIN_SERV_INSECURE_HOSTS,
    },
  );
  if (response.status !== 200) {
    throw new Error(`${what}失败（HTTP ${response.status}）`);
  }

  const decrypted = decryptServerResponse(response.body);
  const parsed = asJsonPayload(decrypted);
  if (parsed === null) {
    const text = typeof decrypted === 'string' ? decrypted : response.body;
    assertUsablePage(text, response.url, what);
    throw new SessionExpiredError(`${what}失败：一卡通平台返回了非 JSON 内容（会话可能已失效）`);
  }
  return parsed;
}

// ===========================================================================
// 3. 卡片信息（余额）—— 对齐 CampusCardService.fetchPaymentCode / fetchRechargeInfo
// ===========================================================================

export interface FinServCardInfo {
  name: string;
  idserial: string;
  balance: string;
  openid: string;
}

interface HtmlProbe {
  /** `<p class="bdb">` 的文本。 */
  bdb: string[];
  /** `<div class="condition">` 的文本。 */
  conditions: string[];
  inputs: Array<{ id: string; name: string; value: string }>;
}

/**
 * 同一选择器的元素可能嵌套，所以每个选择器各拿一个栈：
 * 文本永远追加到「当前最内层」的缓冲上。
 */
function collectText(sink: string[]): HTMLRewriterElementContentHandlers {
  const stack: string[] = [];
  return {
    element(element: Element) {
      stack.push('');
      element.onEndTag(() => {
        sink.push((stack.pop() ?? '').trim());
      });
    },
    text(chunk: Text) {
      if (stack.length > 0) stack[stack.length - 1] += chunk.text;
    },
  };
}

/** 一趟 HTMLRewriter 同时把三类信息捞出来（不整页跑正则）。 */
async function probeCardHtml(html: string): Promise<HtmlProbe> {
  const probe: HtmlProbe = { bdb: [], conditions: [], inputs: [] };
  await new HTMLRewriter()
    .on('p.bdb', collectText(probe.bdb))
    .on('div.condition', collectText(probe.conditions))
    .on('input', {
      element(element: Element) {
        probe.inputs.push({
          id: element.getAttribute('id') ?? '',
          name: element.getAttribute('name') ?? '',
          value: element.getAttribute('value') ?? '',
        });
      },
    })
    .transform(new Response(html))
    .text();
  return probe;
}

export interface CardProbeResult {
  name: string;
  idserial: string;
  balance: string;
}

/**
 * 从付款码页 / 充值页里解析姓名、学号、余额。导出是为了能用 HAR 原文做回归测试。
 */
export function parseCardProbe(probe: HtmlProbe): CardProbeResult | null {
  let name = '';
  let idserial = '';
  for (const input of probe.inputs) {
    if (name === '' && input.id === 'username') name = input.value;
    if (idserial === '' && input.id === 'idserial') idserial = input.value;
  }

  let balance = '';
  // 付款码页：`<p class="bdb">张三：202300010001 余额：0.10元</p>`
  // 对齐 Dart `_parseAndCacheInfo` 的正则，但作用域只有这一小段文本。
  for (const text of probe.bdb) {
    const match = /([^：:\s]+)[：:]\s*([0-9]+)[\s\S]*?余额[：:]\s*([0-9]+(?:\.[0-9]+)?)/.exec(text);
    if (match === null) continue;
    if (name === '') name = match[1].trim();
    if (idserial === '') idserial = match[2].trim();
    balance = match[3];
    break;
  }

  // 充值页：`<div class="condition">…<label>卡余额</label><p>0.10元</p>…</div>`
  // 注意**不能**整页找 `数字元`：同一页还有「充值金额不可大于 1000.00 元」。
  if (balance === '') {
    for (const text of probe.conditions) {
      const match = /卡余额[^0-9]*([0-9]+(?:\.[0-9]+)?)/.exec(text);
      if (match !== null) {
        balance = match[1];
        break;
      }
    }
  }

  if (balance === '' || idserial === '') return null;
  return { name, idserial, balance };
}

/** 供测试使用的 HTML 解析入口。 */
export async function parseCardHtml(html: string): Promise<CardProbeResult | null> {
  return parseCardProbe(await probeCardHtml(html));
}

/**
 * 拉校园卡姓名 / 学号 / 余额。
 *
 * 先付款码页（信息集中在一行，最可靠），不行再退到充值页。
 * Dart 还会再退到首页 + 付款码页各扫一遍；这里两页足够，
 * 少两次网络往返，且都是 HAR 里核对过的真实结构。
 */
export async function fetchCardInfo(ctx: FinServSession): Promise<FinServCardInfo> {
  const home = openHomePageUrl(ctx.openid);

  const virtualHtml = await fetchPage(ctx, openVirtualcardUrl(ctx.openid), '获取校园卡信息', home);
  const fromVirtual = parseCardProbe(await probeCardHtml(virtualHtml));
  if (fromVirtual !== null) return { ...fromVirtual, openid: ctx.openid };

  const payHtml = await fetchPage(ctx, openCardPayUrl(ctx.openid), '获取校园卡信息', home);
  const fromPay = parseCardProbe(await probeCardHtml(payHtml));
  if (fromPay !== null) return { ...fromPay, openid: ctx.openid };

  throw new Error('获取校园卡信息失败：付款码页与充值页都没能解析出学号与余额');
}

// ===========================================================================
// 4. 电费 —— 对齐 ElectricityService
// ===========================================================================

/** 电费业务线的厂商代码，Dart 写死在 `ElectricityService._factoryCode`。 */
export const ELE_FACTORY_CODE = 'E013';

export interface ElectricityArea {
  id: string;
  name: string;
}

export interface ElectricityBuilding {
  id: string;
  name: string;
}

export interface ElectricityRoom {
  id: string;
  name: string;
  mertype: string;
}

export interface ElectricityBalance {
  balance: string;
  detail: string;
  accname: string;
  elestatus: number | null;
}

export interface ElectricityTarget {
  areaName: string;
  buildingName: string;
  roomId: string;
  roomName: string;
  mertype: string;
}

/** ⚠️ 未经实测：`channel/getXiaoQuList` 的字段名来自 Dart `ElectricityArea.fromJson`。 */
export async function fetchElectricAreas(ctx: FinServSession): Promise<ElectricityArea[]> {
  await warmUp(ctx, 'elepay', openElePayUrl(ctx.openid), '进入电费充值页');
  const payload = await postDatajson(
    ctx,
    '/channel/getXiaoQuList',
    { factorycode: ELE_FACTORY_CODE },
    '获取校区列表',
  );
  const areas: ElectricityArea[] = [];
  for (const item of extractList(payload, ['schoolList', 'schoollist'])) {
    const name = firstString(item, ['xiaoqu', 'schoolname', 'schoolid']);
    if (name !== '') areas.push({ id: name, name });
  }
  return areas;
}

/** ⚠️ 未经实测。注意 `schoolid` 传的是**校区名称**，不是 id（Dart 亦然）。 */
export async function fetchElectricBuildings(
  ctx: FinServSession,
  areaName: string,
): Promise<ElectricityBuilding[]> {
  await warmUp(ctx, 'elepay', openElePayUrl(ctx.openid), '进入电费充值页');
  const payload = await postDatajson(
    ctx,
    '/channel/queryBuildingList',
    { factorycode: ELE_FACTORY_CODE, schoolid: areaName },
    '获取楼栋列表',
  );
  const buildings: ElectricityBuilding[] = [];
  for (const item of extractList(payload, ['buildingList', 'buildinglist'])) {
    const name = firstString(item, ['buildingname', 'buildname', 'buildingid', 'buildid']);
    if (name === '') continue;
    buildings.push({ id: firstString(item, ['buildingid', 'buildid'], name), name });
  }
  return buildings;
}

/** ⚠️ 未经实测。`mertype`（yk 预付费 / rt 实时表）只在房间这一层给。 */
export async function fetchElectricRooms(
  ctx: FinServSession,
  areaName: string,
  buildingName: string,
): Promise<ElectricityRoom[]> {
  await warmUp(ctx, 'elepay', openElePayUrl(ctx.openid), '进入电费充值页');
  const payload = await postDatajson(
    ctx,
    '/channel/queryRoomList',
    { factorycode: ELE_FACTORY_CODE, schoolid: areaName, buildingid: buildingName },
    '获取房间列表',
  );
  const rooms: ElectricityRoom[] = [];
  for (const item of extractList(payload, ['roomList', 'roomlist'])) {
    const name = firstString(item, ['roomname', 'roomid']);
    if (name === '') continue;
    rooms.push({
      id: firstString(item, ['roomid'], name),
      name,
      mertype: firstString(item, ['mertype'], 'yk'),
    });
  }
  return rooms;
}

/** ⚠️ 未经实测：`channel/queryEleAccDetail`。 */
export async function fetchElectricBalance(
  ctx: FinServSession,
  target: Pick<ElectricityTarget, 'areaName' | 'buildingName' | 'roomId' | 'mertype'>,
): Promise<ElectricityBalance> {
  await warmUp(ctx, 'elepay', openElePayUrl(ctx.openid), '进入电费充值页');
  const payload = await postDatajson(
    ctx,
    '/channel/queryEleAccDetail',
    {
      schoolid: target.areaName,
      buildingid: target.buildingName,
      roomid: target.roomId,
      mertype: target.mertype,
      factorycode: ELE_FACTORY_CODE,
    },
    '查询电费余额',
  );
  const record = assertBusinessPayload(payload, '查询电费余额');
  if (record['success'] === false) {
    throw new Error(firstString(record, ['message', 'msg'], '查询电费余额失败'));
  }

  const result = asRecord(record['resultData']) ?? record;
  const accname = firstString(result, ['accname', 'roomname', 'roomdesc']);
  const rawStatus = result['elestatus'];
  const elestatus =
    typeof rawStatus === 'number'
      ? rawStatus
      : typeof rawStatus === 'string' && /^-?\d+$/.test(rawStatus)
        ? Number.parseInt(rawStatus, 10)
        : null;

  return {
    balance: firstString(
      result,
      [
        'eledetail',
        'balance',
        'elebalance',
        'syje',
        'ye',
        'remainElec',
        'remainelec',
        'restmoney',
        'elec_balance',
      ],
      '0.00',
    ),
    detail: firstString(result, ['eleaccdetail', 'detail'], accname),
    accname,
    elestatus,
  };
}

export interface ElectricityPreOrder {
  success: boolean;
  message: string;
  /** 服务端回执里能拿到的原始 resultData，便于上层展示订单号之类。 */
  resultData: Record<string, unknown>;
}

/**
 * ⚠️ 未经实测：`elepay/createPreThirdTrade`。**这一步会在学校一卡通平台创建真实的
 * 电费预支付订单（payWay=2 走校园卡扣款）**，不是只读接口。
 *
 * 与 Dart 的一处**有意分歧**：Dart 判成功的表达式里有
 * `data.containsKey('resultData') && data['resultData'] != null`，
 * 而失败响应一般也带 `resultData: {}`，于是 `{"success":false,"message":"余额不足"}`
 * 会被判成充值成功。充值是有副作用的动作，误报成功比误报失败危险得多，
 * 所以这里只在**有明确成功信号**（success/code）或 resultData 非空时才认为成功，
 * 其余一律抛出，让调用方去核对订单。
 */
export async function createElectricityPreOrder(
  ctx: FinServSession,
  target: Pick<ElectricityTarget, 'areaName' | 'buildingName' | 'roomId' | 'mertype'>,
  idserial: string,
  amount: number,
): Promise<ElectricityPreOrder> {
  await warmUp(ctx, 'elepay', openElePayUrl(ctx.openid), '进入电费充值页');

  // 1. 记录「最后一次选择」。Dart 里这一步失败不阻断主流程。
  try {
    await postDatajson(
      ctx,
      '/myaccount/userlastbind',
      {
        payinfo: { elepayWay: '2' },
        eleinfo: {
          schoolid: target.areaName,
          buildingid: target.buildingName,
          roomid: target.roomId,
          factorycode: ELE_FACTORY_CODE,
        },
        idserial,
      },
      '记住本次充值宿舍',
    );
  } catch (error) {
    // 会话失效必须上抛去重登；其余失败只是「没记住上次选择」，不影响下单
    if (error instanceof SessionExpiredError) throw error;
  }

  // 2. 创建预支付订单（真实副作用）
  const payload = await postDatajson(
    ctx,
    '/elepay/createPreThirdTrade',
    {
      payamt: String(Math.round(amount)),
      openid: ctx.openid,
      idserial,
      factorycode: ELE_FACTORY_CODE,
      buildingid: target.buildingName,
      roomid: target.roomId,
      schoolid: target.areaName,
      payWay: '2',
      mertype: target.mertype,
    },
    '创建电费预支付订单',
  );

  const record = assertBusinessPayload(payload, '创建电费预支付订单');
  const resultData = asRecord(record['resultData']) ?? {};
  const message = firstString(record, ['message', 'msg']);
  const successFlag = record['success'];
  const code = record['code'];

  if (successFlag === false || successFlag === 'false') {
    throw new Error(message !== '' ? message : '创建电费预支付订单失败（服务端未说明原因）');
  }

  const explicitSuccess =
    successFlag === true || successFlag === 'true' || code === 0 || code === '0';
  const probableSuccess = Object.keys(resultData).length > 0;

  if (!explicitSuccess && !probableSuccess) {
    throw new Error(
      message !== ''
        ? `创建电费预支付订单未确认成功：${message}`
        : '创建电费预支付订单未确认成功：服务端既没有返回成功标记，也没有返回订单信息，请到一卡通平台核对后再重试',
    );
  }

  return { success: true, message, resultData };
}

// ===========================================================================
// 5. 流水 —— 对齐 TransactionService
// ===========================================================================

export interface CardTransaction {
  merchantName: string;
  amount: string;
  time: string;
  tradeType: string;
}

/** 与 `openQueryCardSelfTrade` 页面 `<select id="choose">` 一致。 */
export const TRADE_TYPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: '-1', label: '全部' },
  { value: '1', label: '消费' },
  { value: '2', label: '充值' },
  { value: '3', label: '补助' },
  { value: '4', label: '转账' },
];

/** ⚠️ 未经实测：`selftrade/queryCardSelfTradeList`。 */
export async function fetchCardTransactions(
  ctx: FinServSession,
  query: { beginDate: string; endDate: string; tradeType: string },
): Promise<CardTransaction[]> {
  const page = openQueryCardSelfTradeUrl(ctx.openid);
  await warmUp(ctx, 'selftrade', page, '进入流水查询页');

  // 字段顺序与页面 querytrace.js 的 queryTrade() 保持一致
  const payload = await postDatajson(
    ctx,
    '/selftrade/queryCardSelfTradeList',
    {
      beginDate: query.beginDate,
      endDate: query.endDate,
      tradeType: query.tradeType,
      openid: ctx.openid,
    },
    '查询校园卡流水',
    page,
  );

  const record = assertBusinessPayload(payload, '查询校园卡流水');
  if (record['success'] !== true) {
    const message = firstString(record, ['message', 'msg']);
    throw new Error(message !== '' ? `查询校园卡流水失败：${message}` : '查询校园卡流水失败');
  }

  return extractList(payload, ['tradeList', 'tradelist', 'list', 'selfTradeList', 'rows']).map(
    (item): CardTransaction => ({
      merchantName: firstString(item, ['mername', 'mercname']),
      amount: firstString(item, ['txamt']),
      time: firstString(item, ['txdate', 'paytime']),
      tradeType: firstString(item, ['tradeType', 'tradetype', 'type', 'txtype']),
    }),
  );
}

// ===========================================================================
// 6. 流水查询参数校验（纯逻辑，便于单测）
// ===========================================================================

const DAY_MS = 86_400_000;

/** 学校在东八区；Workers 跑在 UTC，直接用本地时间会把「今天」算错一天。 */
const CHINA_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

interface SimpleDate {
  year: number;
  month: number;
  day: number;
}

function toStamp(date: SimpleDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

function fromStamp(stamp: number): SimpleDate {
  const date = new Date(stamp);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** 解析 `yyyy-MM-dd`，并拒绝 `2026-02-31` 这类会静默进位的日期。 */
export function parseSchoolDate(text: string): SimpleDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (match === null) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

export function formatSchoolDate(date: SimpleDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

/** 东八区的「今天」。`now` 可注入，便于测试。 */
export function schoolToday(now: number = Date.now()): SimpleDate {
  return fromStamp(Math.floor((now + CHINA_UTC_OFFSET_MS) / DAY_MS) * DAY_MS);
}

function shiftDays(date: SimpleDate, days: number): SimpleDate {
  return fromStamp(toStamp(date) + days * DAY_MS);
}

export interface TransactionRange {
  beginDate: string;
  endDate: string;
  tradeType: string;
  tradeLabel: string;
}

export type TransactionRangeResult =
  | { ok: true; range: TransactionRange }
  | { ok: false; message: string };

/**
 * 校验并归一化流水查询参数。服务端限制与页面 JS 一致：
 * 起止间隔 ≤ 31 天、截止 ≤ 当天；都不传则查近 7 天（含今天）。
 * 日期一律按东八区解释。
 */
export function resolveTransactionRange(input: {
  beginDate?: string;
  endDate?: string;
  tradeType?: string;
  now?: number;
}): TransactionRangeResult {
  const today = schoolToday(input.now ?? Date.now());
  const beginText = (input.beginDate ?? '').trim();
  const endText = (input.endDate ?? '').trim();

  const begin = beginText === '' ? shiftDays(today, -6) : parseSchoolDate(beginText);
  if (begin === null) {
    return { ok: false, message: '起始日期格式错误，请使用 yyyy-MM-dd（例如 2026-09-15）' };
  }
  const end = endText === '' ? today : parseSchoolDate(endText);
  if (end === null) {
    return { ok: false, message: '截止日期格式错误，请使用 yyyy-MM-dd（例如 2026-09-22）' };
  }
  if (toStamp(begin) > toStamp(end)) {
    return { ok: false, message: '截止日期不能早于起始日期' };
  }
  if (toStamp(end) > toStamp(today)) {
    return { ok: false, message: '截止日期不能超过今天' };
  }
  if ((toStamp(end) - toStamp(begin)) / DAY_MS > 31) {
    return { ok: false, message: '日期区间最长为 31 天，请缩小范围后重试' };
  }

  const type = resolveTradeType(input.tradeType ?? '');
  return {
    ok: true,
    range: {
      beginDate: formatSchoolDate(begin),
      endDate: formatSchoolDate(end),
      tradeType: type.value,
      tradeLabel: type.label,
    },
  };
}

/** 接受取值（-1/1/2/3/4）或中文名（全部/消费/充值/补助/转账），与 Dart 一致。 */
export function resolveTradeType(input: string): { value: string; label: string } {
  const trimmed = input.trim();
  for (const type of TRADE_TYPES) {
    if (type.value === trimmed || type.label === trimmed) return type;
  }
  return { value: '-1', label: '全部' };
}

// ===========================================================================
// 7. 目标宿舍解析（不含 SharedPreferences —— 服务端没有「上次绑定」）
// ===========================================================================

const HASH_ROOM_ID = /^[A-Fa-f0-9]{32}$/;

/**
 * 对齐 Dart `ElectricityTool._resolveRoom`（去掉 SharedPreferences 的部分）：
 * 把「302」这种人类输入解析成服务端要的房间 ID，并顺带取回 mertype。
 * 房间列表拿不到不致命 —— 调用方直接给的哈希 ID 也是合法输入。
 */
export async function resolveElectricityTarget(
  ctx: FinServSession,
  input: {
    areaName: string;
    buildingName: string;
    roomId: string;
    roomName: string;
    mertype: string;
  },
): Promise<ElectricityTarget> {
  let roomId = input.roomId;
  let roomName = input.roomName;
  let mertype = input.mertype === '' ? 'yk' : input.mertype;

  try {
    const rooms = await fetchElectricRooms(ctx, input.areaName, input.buildingName);
    let matched = rooms.find((room) => room.id === input.roomId);
    if (matched === undefined) {
      matched = rooms.find((room) => room.name === input.roomId || room.name.includes(input.roomId));
    }
    if (matched === undefined && input.roomName !== '') {
      matched = rooms.find(
        (room) => room.name === input.roomName || room.name.includes(input.roomName),
      );
    }
    if (matched !== undefined) {
      roomId = matched.id;
      roomName = matched.name;
      if (matched.mertype !== '') mertype = matched.mertype;
    }
  } catch (error) {
    // 会话失效得抛出去重登；其它情况沿用调用方给的 ID（对齐 Dart 的 try/catch 忽略）
    if (error instanceof SessionExpiredError) throw error;
  }

  if (roomName === '' || HASH_ROOM_ID.test(roomName)) {
    roomName = input.roomName !== '' ? input.roomName : input.roomId;
  }

  return {
    areaName: input.areaName,
    buildingName: input.buildingName,
    roomId,
    roomName,
    mertype,
  };
}

/** 服务端有些房间只有 32 位哈希 ID，没有可读房号。 */
export function isHashedRoomName(value: string): boolean {
  return HASH_ROOM_ID.test(value);
}

/** 面向用户的房间名：哈希 ID 没有可读性，退化成房号或「所选宿舍」。 */
export function displayRoomName(target: Pick<ElectricityTarget, 'roomId' | 'roomName'>): string {
  if (target.roomName !== '' && !HASH_ROOM_ID.test(target.roomName)) return target.roomName;
  if (target.roomId !== '' && !HASH_ROOM_ID.test(target.roomId)) return target.roomId;
  return '所选宿舍';
}

/**
 * 从账户名里抠出纯房号。Dart 的例子：
 * `XS-JA-1-629(学生公寓空调.金岸1栋.629)` -> `629`
 */
export function roomNameFromAccount(accname: string): string {
  const dotted = /\.([^.)]+)\)/.exec(accname);
  if (dotted !== null && dotted[1] !== undefined && dotted[1].trim() !== '') {
    return dotted[1].trim();
  }
  const dashed = /-([0-9A-Za-z]+)\(/.exec(accname);
  if (dashed !== null && dashed[1] !== undefined && dashed[1].trim() !== '') {
    return dashed[1].trim();
  }
  return '';
}

// ===========================================================================
// 8. 真实抓包测试向量（供 test/finserv.test.ts 回归）
// ===========================================================================

/**
 * 来自 `chilleast/debug/付款码/付款码.har` 的真实密文。
 * 能在不联网的前提下证明 handleKey + AES-ECB + JSON 解析与线上逐字节一致。
 */
export const HAR_VECTORS = {
  /** POST /myaccount/querywechatUserLastInfo 的请求体。 */
  requestCipher:
    'kOgVytnTu9Jt08xHx7X8+7h5M9Kmf1vIFQ1FKLZssMOiC7Y0pBospkjUaDPC/+xUOVDYRSA7dD40pbyQm/xK32XDbqib0zO8Gyeuqn/MrmFy3DjKDLepwYbqfmUnpfw+ygFeq9BbhKBOHKVUJsZbB7hllV6sPJhD6q0u3hxypBlJyQ+bmdZldWdJHGYfICSBlPQ41XEzp1PGnlh4',
  requestPlain: {
    idserial: '202300010001',
    openid:
      'FEA275B6280F7863C75FE57AFE4004386CD8065A797E3D462F924286B82B0C02245E9D0B4DF389D37A94891E99FC0000',
  },
  /** 同一次调用的响应密文。 */
  responseCipher:
    'Buf4HimmN8Y5M9Pm+yyXDzVVZvumiCpeS0ZigMNp8Y8lC54C6t0XdViQDMM6gJh07iRHnf57qEpQ419MUtETij15mX4iIWwwWY/aAA==',
  responsePlain: { message: 'CORE10008', resultData: {}, success: true },
} as const;
