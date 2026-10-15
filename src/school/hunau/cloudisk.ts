/**
 * 学习通云盘（pan-yz.cldisk.com）客户端 + 备份读写。
 *
 * 为什么走这条路：`manage_timetable_rules` / `add_homework` / `complete_homework`
 * 在 ChillEast 里原本是设备本地文件，而 App 已有一条把本地数据同步到云盘的通道。
 * 复用这条通道，手机 App 与 MCP 服务看到的就是同一份数据，也不必在服务端再引入
 * 一套存储与同步逻辑。
 *
 * 备份文件名 `chilleast-backup-{a|b}-{yyyyMMdd-HHmmss}.json`，A/B 槽位轮换，
 * 上传后删掉同前缀的其它文件；stamp 设计成字典序即时间序。
 */

import { CookieSession } from '../../auth/http';
import { SessionExpiredError } from '../../auth/session-manager';
import { CHAOXING_UA } from './constants';

const HOST = 'https://pan-yz.cldisk.com';
const SCHOOL_FID = '128516';
const UPLOAD_PAGE_URL =
  `${HOST}/pcuserpan/upload?bigFile=0&yunpanFidEnc=&barrierFree=false&isSuperstarfirefly=`;
const LIST_PAGE_SIZE = 60;
const MAX_LIST_PAGES = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export const BACKUP_FILE_PREFIX = 'chilleast-backup-';

export interface CloudiskSession {
  puid: string;
  rootDirId: string;
  enc: string;
  token: string;
}

export interface CloudiskEntry {
  /** 服务端原始条目（字段原样透传） */
  raw: Record<string, unknown>;
  name: string;
  id: string;
  encryptedId: string;
  puid: string;
}

function jsonOf(body: string, what: string): Record<string, unknown> {
  const trimmed = body.trim();
  if (trimmed.startsWith('<')) {
    const lower = trimmed.toLowerCase();
    if (lower.includes('passport') && (lower.includes('login') || lower.includes('登录'))) {
      throw new SessionExpiredError('超星登录已过期，请重新登录');
    }
    throw new Error(`${what}返回了 HTML 而不是 JSON`);
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('shape');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${what}返回的数据格式异常`);
  }
}

function assertNotAuthFailure(status: number): void {
  if (status === 401 || status === 403) {
    throw new SessionExpiredError('超星登录已过期，请重新登录');
  }
}

/** passport 系登录页 = 超星会话失效。 */
function isPassportLogin(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.hostname.includes('passport')) return true;
    return url.hostname === 'sso.hunau.edu.cn' && url.pathname.includes('login');
  } catch {
    return false;
  }
}

/**
 * 从云盘首页 HTML 里取四个会话常量。
 *
 * 坑（Dart 注释里专门写了）：页面里有 `var p_auth_token = ""`、`cx_p_token = "…"`
 * 这类干扰串，都以 `_token` 结尾。必须用 `\b` 词边界排除
 * （`_` 是单词字符，`h` 与 `_` 之间没有边界），并且取**最后一个**非空命中
 * —— 真正的 `const _token = "32位hex"` 在文末的 script 里。
 */
/** 取出某个名字的所有非空赋值（按出现顺序）。 */
function pickAll(html: string, name: string): string[] {
  const pattern = new RegExp(
    `(?:(?:const|var)\\s+)?\\b${name}\\s*=\\s*"([^"]*)"`,
    'g',
  );
  const values: string[] = [];
  for (const match of html.matchAll(pattern)) {
    const value = match[1];
    if (value !== undefined && value !== '') values.push(value);
  }
  return values;
}

function lastOf(values: readonly string[]): string | null {
  return values.length === 0 ? null : values[values.length - 1];
}

/** 真正的 _token 是 32 位 hex（Dart 注释里写明的）。 */
const REAL_TOKEN_PATTERN = /^[0-9a-f]{32}$/i;

export function parseSession(html: string): CloudiskSession {
  const enc = lastOf(pickAll(html, 'encstr'));
  const root = lastOf(pickAll(html, 'rootdir'));
  const puid = lastOf(pickAll(html, 'currentPuid'));

  // _token：页面上有多个 `_token = "…"`，必须取正确的那一个，
  // 单纯"取最后一个非空"会拿到一个 12 位的错误值（服务器会回
  // 「错误的_token值」）。而 Dart 注释里明确说真正的那个是 **32 位 hex**，
  // 所以优先挑符合该格式的候选。
  const tokenCandidates = pickAll(html, '_token');
  const token =
    tokenCandidates.find((value) => REAL_TOKEN_PATTERN.test(value)) ??
    lastOf(tokenCandidates);

  if (enc === null || root === null || puid === null || token === null) {
    throw new SessionExpiredError('云盘会话失效，请重新登录');
  }
  if (!REAL_TOKEN_PATTERN.test(token)) {
    // 不阻断（万一服务端改了格式），但留下可诊断的线索
    console.warn(
      JSON.stringify({
        event: 'cloudisk_token_unexpected',
        candidates: tokenCandidates.map((value) => value.length),
        chosenLength: token.length,
      }),
    );
  }
  return { puid, rootDirId: root, enc, token };
}

/** 诊断用：把四个常量的候选长度报出来（不回显值）。 */
export function describeSessionCandidates(html: string): Record<string, number[]> {
  const lengths = (name: string): number[] => pickAll(html, name).map((value) => value.length);
  return {
    encstr: lengths('encstr'),
    rootdir: lengths('rootdir'),
    currentPuid: lengths('currentPuid'),
    _token: lengths('_token'),
  };
}

/**
 * 走一遍云盘 SSO 拿到会话。
 *
 * **必须手动逐跳跟随**（`follow: false`）：Dart 注释解释了原因 ——
 * 自动跟跳时中间 `writecookies` 那一跳的 Set-Cookie 不会过 Cookie 管理器，
 * 直接丢失，后续 listres / 上传必然失败。
 *
 *   pan-yz.cldisk.com/ → pan-yz.chaoxing.com/redirectWithCookies
 *     → pan-yz.cldisk.com/writecookies → /?_puid=… → 200 首页 HTML
 */
export async function ensureCloudiskSession(session: CookieSession): Promise<CloudiskSession> {
  let current = `${HOST}/`;

  for (let hop = 0; hop < 10; hop++) {
    if (isPassportLogin(current)) {
      throw new SessionExpiredError('超星登录已过期，请重新登录');
    }
    const response = await session.request(current, {
      follow: false,
      headers: { 'User-Agent': CHAOXING_UA, Referer: `${HOST}/` },
    });
    assertNotAuthFailure(response.status);

    if (REDIRECT_STATUS.has(response.status)) {
      const location = response.headers.get('location');
      if (location === null || location === '') throw new Error('云盘登录跳转异常');
      current = new URL(location, response.url).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 400) {
      throw new Error(`云盘首页异常 HTTP ${response.status}`);
    }
    if (isPassportLogin(response.url)) {
      throw new SessionExpiredError('超星登录已过期，请重新登录');
    }
    return parseSession(response.body);
  }
  throw new Error('云盘登录跳转次数过多');
}

function toEntry(raw: Record<string, unknown>): CloudiskEntry {
  return {
    raw,
    name: typeof raw['name'] === 'string' ? raw['name'] : '',
    id: raw['id'] === undefined || raw['id'] === null ? '' : String(raw['id']),
    encryptedId:
      raw['encryptedId'] === undefined || raw['encryptedId'] === null
        ? ''
        : String(raw['encryptedId']),
    puid: raw['puid'] === undefined || raw['puid'] === null ? '' : String(raw['puid']),
  };
}

/** 列目录。 */
export async function listRes(
  session: CookieSession,
  auth: CloudiskSession,
  parentId: string,
  page = 1,
): Promise<{ totalCount: number; entries: CloudiskEntry[] }> {
  const query = new URLSearchParams({
    puid: auth.puid,
    shareid: '0',
    parentId,
    page: String(page),
    size: String(LIST_PAGE_SIZE),
    enc: auth.enc,
    filterType: '',
    orderField: 'default',
    orderType: 'desc',
  });
  const response = await session.request(`${HOST}/opt/listres?${query}`, {
    follow: true,
    headers: {
      'User-Agent': CHAOXING_UA,
      Referer: `${HOST}/?_puid=${auth.puid}`,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  assertNotAuthFailure(response.status);
  const body = jsonOf(response.body, '云盘目录');
  const list = body['list'];
  if (!Array.isArray(list)) throw new Error('目录列表格式异常');
  const total = body['totalCount'];
  return {
    totalCount: typeof total === 'number' ? total : list.length,
    entries: list
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map(toEntry),
  };
}

/** 翻页找出所有备份文件条目。 */
export async function listBackupEntries(
  session: CookieSession,
  auth: CloudiskSession,
  folderId: string,
): Promise<CloudiskEntry[]> {
  const all: CloudiskEntry[] = [];
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const result = await listRes(session, auth, folderId, page);
    all.push(...result.entries);
    if (result.entries.length >= result.totalCount || result.entries.length < LIST_PAGE_SIZE) {
      break;
    }
  }
  return all;
}

/** 上传字节，返回服务端回执（含 resid / encryptedId / size）。 */
export async function uploadFile(
  session: CookieSession,
  auth: CloudiskSession,
  folderId: string,
  filename: string,
  bytes: Uint8Array,
): Promise<{ resid: string; encryptedId: string }> {
  const genQuery = new URLSearchParams({
    puid: auth.puid,
    folderUpload: 'false',
    fldid: folderId,
    _token: auth.token,
    fid: SCHOOL_FID,
  });
  const genResponse = await session.request(
    `${HOST}/pcuserpanUpload/generateUploadUrl?${genQuery}`,
    {
      follow: true,
      headers: {
        'User-Agent': CHAOXING_UA,
        Referer: UPLOAD_PAGE_URL,
        'X-Requested-With': 'XMLHttpRequest',
      },
    },
  );
  assertNotAuthFailure(genResponse.status);
  const gen = jsonOf(genResponse.body, '获取上传地址');
  // 契约是从 Dart 还原的，字段名不保证只有一种写法；多试几个常见位置再报错
  const nested = typeof gen['data'] === 'object' && gen['data'] !== null
    ? (gen['data'] as Record<string, unknown>)
    : {};
  const uploadUrl =
    (typeof gen['uploadUrl'] === 'string' && gen['uploadUrl']) ||
    (typeof gen['url'] === 'string' && gen['url']) ||
    (typeof nested['uploadUrl'] === 'string' && nested['uploadUrl']) ||
    (typeof nested['url'] === 'string' && nested['url']) ||
    '';
  if (uploadUrl === '') {
    // 把服务器实际回了什么带出来 —— 否则只能靠猜（这正是第一次踩的坑）
    const summary = JSON.stringify(gen).slice(0, 400);
    const tokenState =
      auth.token === '' ? '空' : `长度 ${auth.token.length}`;
    throw new Error(
      `获取上传地址失败。服务器返回：${summary}` +
        `（puid=${auth.puid}，_token ${tokenState}，fldid=${folderId}）`,
    );
  }
  const target = uploadUrl.startsWith('http') ? uploadUrl : `${HOST}${uploadUrl}`;

  const form = new FormData();
  form.append('file', new File([bytes], filename));
  const uploadResponse = await session.postMultipart(target, form, {
    follow: true,
    headers: {
      'User-Agent': CHAOXING_UA,
      Origin: HOST,
      Referer: UPLOAD_PAGE_URL,
    },
  });
  assertNotAuthFailure(uploadResponse.status);

  const body = jsonOf(uploadResponse.body, '上传');
  const data = body['data'];
  if (body['result'] !== true || typeof data !== 'object' || data === null) {
    const message = typeof body['msg'] === 'string' ? body['msg'] : '未知原因';
    throw new Error(`上传失败：${message}`);
  }
  const record = data as Record<string, unknown>;
  const resid = record['resid'];
  if (resid === undefined || resid === null || String(resid) === '') {
    throw new Error('上传回执缺少 resid');
  }
  // 校验大小，避免"传上去了但内容不对"
  const size = Number.parseInt(String(record['size'] ?? ''), 10);
  if (Number.isFinite(size) && size !== bytes.length) {
    throw new Error(`上传校验失败（回执 ${size} 字节，实际 ${bytes.length} 字节）`);
  }
  return {
    resid: String(resid),
    encryptedId: record['encryptedId'] === undefined ? '' : String(record['encryptedId']),
  };
}

/**
 * 下载字节。
 *
 * 正常路径是 302 到签名地址（通常在 d0.cldisk.com）。但也可能直接 200 返回内容 ——
 * 之前只认 302，等于把能用的响应丢掉了。两种都处理。
 */
export async function downloadFile(
  session: CookieSession,
  auth: CloudiskSession,
  entry: { resid: string; encryptedId: string; puid?: string; folderId: string },
): Promise<Uint8Array> {
  const query = new URLSearchParams({
    fleid: entry.resid,
    puid: entry.puid !== undefined && entry.puid !== '' ? entry.puid : auth.puid,
    currentFolderId: entry.folderId,
    p_auth_token: '',
    encryptedId: entry.encryptedId,
    auditRecordIdEnc: '',
  });
  const url = `${HOST}/download/downloadFileV2?${query}`;
  const response = await session.request(url, {
    follow: false,
    skipBody: true, // 二进制内容不能让 CookieSession 去按 charset 解码
    headers: {
      'User-Agent': CHAOXING_UA,
      Referer: `${HOST}/?_puid=${auth.puid}`,
    },
  });
  assertNotAuthFailure(response.status);

  const location = response.headers.get('location');

  // 情况 A：302 到签名地址，签名地址自带鉴权
  if (response.status === 302 && location !== null && location !== '') {
    const signedUrl = new URL(location, `${HOST}/`).toString();
    return await fetchBytes(signedUrl, auth);
  }

  // 情况 B：直接 200 返回内容
  if (response.status === 200) {
    return await fetchBytes(url, auth);
  }

  // 其它状态：把真相带出来，别再只回一句"失败"
  const snippet = await fetch(url, {
    headers: { 'User-Agent': CHAOXING_UA, Referer: `${HOST}/?_puid=${auth.puid}` },
  })
    .then((r) => r.text())
    .then((text) => text.trim().replace(/\s+/g, ' ').slice(0, 300))
    .catch(() => '(读取失败)');

  throw new Error(
    `获取下载地址失败：HTTP ${response.status}，` +
      `Location ${location === null ? '缺失' : '存在'}，响应片段「${snippet}」` +
      `（resid=${entry.resid}，encryptedId 长度 ${entry.encryptedId.length}，` +
      `puid=${entry.puid !== undefined && entry.puid !== '' ? entry.puid : auth.puid}）`,
  );
}

/** 直接 fetch 字节（不经 CookieSession，避免二进制被当文本解码）。 */
async function fetchBytes(url: string, auth: CloudiskSession): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { 'User-Agent': CHAOXING_UA, Referer: `${HOST}/?_puid=${auth.puid}` },
  });
  if (response.status === 401 || response.status === 403) {
    throw new SessionExpiredError('云盘下载鉴权失败，请重新登录');
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`下载失败 HTTP ${response.status}：${text.slice(0, 200)}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** 删除文件。 */
export async function deleteFile(
  session: CookieSession,
  auth: CloudiskSession,
  entry: { resid: string; encryptedId: string; puid?: string },
): Promise<void> {
  const body = new URLSearchParams({
    resids: entry.resid,
    resourcetype: '0',
    puids: entry.puid !== undefined && entry.puid !== '' ? entry.puid : auth.puid,
    encryptedids: entry.encryptedId,
  });
  const response = await session.request(`${HOST}/opt/delres`, {
    method: 'POST',
    body: body.toString(),
    follow: true,
    headers: {
      'User-Agent': CHAOXING_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: HOST,
      Referer: `${HOST}/?_puid=${auth.puid}`,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  assertNotAuthFailure(response.status);
  const parsed = jsonOf(response.body, '删除');
  if (parsed['success'] !== true) {
    const message = typeof parsed['msg'] === 'string' ? parsed['msg'] : '未知原因';
    throw new Error(`删除失败：${message}`);
  }
}

// ---- 备份文件的命名与挑选（对齐 cloud_backup_manager.dart）-----------------

export interface BackupFileInfo {
  slot: 'a' | 'b';
  stamp: string;
}

/** `chilleast-backup-a-20261014-093000.json` -> {slot:'a', stamp:'20261014-093000'} */
export function parseBackupFileName(name: string): BackupFileInfo | null {
  const match = /^chilleast-backup-([ab])-(\d{8}-\d{6})\.json$/.exec(name);
  if (match === null) return null;
  return { slot: match[1] as 'a' | 'b', stamp: match[2] };
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 文件名里的 stamp 设计成字典序即时间序，**必须用北京时间（UTC+8），不能用 UTC。**
 * ChillEast 用的是 `DateTime.now()`，在手机上就是设备本地时间（国内即 UTC+8），而 Worker
 * 跑在 UTC 上：如果这里用 getUTCHours()，生成的 stamp 会比 App 的**早 8 小时**，于是
 * 「按文件名字典序取最新」会把我的文件判成更旧 —— 而这正是 A/B 轮换的核心假设 —— App
 * 清理旧备份时还会把我的当过期文件删掉，我的写入就丢了。实测踩到过：同一时刻 App 写的是
 * 124600（12:46），我写的是 044754（04:47），字面上却差 8 小时。这里显式换算到 UTC+8，
 * 而不是依赖运行环境的本地时区 —— Worker 可能跑在任何时区，显式换算才是确定的。
 */
export function buildBackupFileName(slot: 'a' | 'b', time: Date): string {
  const beijing = new Date(time.getTime() + 8 * 60 * 60 * 1000);
  const stamp =
    `${beijing.getUTCFullYear()}${two(beijing.getUTCMonth() + 1)}${two(beijing.getUTCDate())}` +
    `-${two(beijing.getUTCHours())}${two(beijing.getUTCMinutes())}${two(beijing.getUTCSeconds())}`;
  return `${BACKUP_FILE_PREFIX}${slot}-${stamp}.json`;
}

/**
 * 轮换目标槽位：无记录或为 b 时用 a，为 a 时用 b（照抄 Dart）。
 *
 * ⚠️ Worker 的写入**不用**这个函数 —— 见 `backup.ts` 的 `writeBackup`：
 * App 按整个文件名取最新，`-a-` 永远输给 `-b-`，所以 Worker 固定写 b 槽
 * 才能保证自己的写入被 App 选中。这里保留是为了忠实反映 Dart 的行为。
 */
export function pickTargetSlot(activeSlot: string | null): 'a' | 'b' {
  return activeSlot === 'a' ? 'b' : 'a';
}

/**
 * 从目录条目里挑最新的备份。
 *
 * ⚠️ **按 stamp 比较，不能按整个文件名比较。**
 * 文件名是 `chilleast-backup-{slot}-{stamp}.json` —— 整个字符串比较会**先比槽位字母**，
 * 于是 `-a-` 永远排在 `-b-` 前面，跟时间无关。
 * 例：`-a-20261014-124754` < `-b-20261014-120000`，可前者其实更新。
 *
 * Dart 的 `pickLatestBackupEntry` 就是比整个字符串的；在 A/B 正常轮换、
 * 目录里只剩一份时看不出问题，但并发/清理失败留下两份时会选错。
 */
export function pickLatestBackupEntry(entries: readonly CloudiskEntry[]): CloudiskEntry | null {
  let best: CloudiskEntry | null = null;
  let bestStamp = '';
  for (const entry of entries) {
    const parsed = parseBackupFileName(entry.name);
    if (parsed === null) continue;
    if (entry.id === '' || entry.encryptedId === '') continue;
    // 同 stamp 时用槽位字母兜底，保证结果确定
    if (best === null || parsed.stamp > bestStamp) {
      best = entry;
      bestStamp = parsed.stamp;
    }
  }
  return best;
}

/** 需要清理的旧备份（同前缀且不是刚上传的那个）。 */
export function pickStaleEntries(
  entries: readonly CloudiskEntry[],
  keepResid: string,
): CloudiskEntry[] {
  return entries.filter(
    (entry) =>
      parseBackupFileName(entry.name) !== null &&
      entry.id !== '' &&
      entry.id !== keepResid &&
      entry.encryptedId !== '',
  );
}
