/**
 * 带 Cookie 罐的 HTTP 会话客户端。
 *
 * 为什么手动跟随重定向：学校各系统在每一跳都会 Set-Cookie（CAS ticket 换
 * JSESSIONID 就是靠逐跳落 Cookie）。如果用 fetch 的自动重定向，中间响应的
 * Set-Cookie 拿不到，服务端会把我们当成全新未认证会话，最后又弹回登录页。
 * ChillEast 客户端的 `XgxtLoginService` 也是同样的处理。
 */

import { CookieJar } from './cookies';

export type HostGuard = (url: URL) => boolean;

/**
 * 请求体。除了字符串，还要支持 FormData（multipart 上传）与原始字节，
 * 否则调用方就得自己在 `CookieSession` 之外重写一遍「带 Cookie 发请求 +
 * 把 Set-Cookie 落回罐子」——那正是最容易写错、也最不该有两份的逻辑。
 */
export type SessionBody = string | FormData | Uint8Array;

export interface SessionRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: SessionBody;
  /** 是否跟随 3xx，默认 true */
  follow?: boolean;
  /** Referer 简写（学校系统多处依赖它判定来源页） */
  referer?: string;
  /** 最大跳数，默认 10 */
  maxRedirects?: number;
  /** 每一跳的额外校验，返回 false 直接抛错（防凭据外泄） */
  guard?: HostGuard;
  /**
   * 这些 host 的 `http://` 跳转会被升级成 `https://`（query 原样保留）。
   * 学校几个系统（门户回跳 / bxpt / sun）确实会发 http 的 Location，
   * 浏览器靠 HSTS 兜底，fetch 不会 —— 必须自己升级，而不是直接拒绝。
   * 票据因此永远不会以明文 HTTP 发出。
   */
  upgradeInsecureHosts?: readonly string[];
  timeoutMs?: number;
  /** 只要响应头/状态，不要 body（下载大文件时用） */
  skipBody?: boolean;
}

export interface SessionResponse {
  status: number;
  /** 最终 URL */
  url: string;
  headers: Headers;
  body: string;
  /** 经过的 URL（含首跳），用于诊断 */
  hops: string[];
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 10;

/** 从 content-type 或 HTML meta 里嗅探字符集。 */
function sniffCharset(bytes: Uint8Array, contentType: string | null): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  if (fromHeader) return fromHeader.toLowerCase();

  // 只看开头 2KB，避免整段解码
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const fromMeta =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
    /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head)?.[1];
  return (fromMeta ?? 'utf-8').toLowerCase();
}

/** 按嗅探到的字符集解码响应体。Workers 的 TextDecoder 支持 gbk/gb18030。 */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const charset = sniffCharset(bytes, contentType);
  const normalized =
    charset === 'gb2312' || charset === 'gbk' || charset === 'gb18030'
      ? 'gb18030'
      : charset === 'utf8'
        ? 'utf-8'
        : charset;
  try {
    return new TextDecoder(normalized).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export class CookieSession {
  constructor(
    public readonly jar: CookieJar = new CookieJar(),
    /** 默认 User-Agent（移动端 UA，学校系统对 PC/移动返回不同页面） */
    public userAgent?: string,
  ) {}

  /**
   * 发一次请求（可选择手动跟随重定向）。
   */
  async request(url: string, options: SessionRequestOptions = {}): Promise<SessionResponse> {
    const follow = options.follow ?? true;
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let method = (options.method ?? 'GET').toUpperCase();
    let body = options.body;
    let currentUrl = url;
    const hops: string[] = [];

    for (let hop = 0; hop <= maxRedirects; hop++) {
      let parsed = new URL(currentUrl);

      // 学校系统会发 http:// 的 Location，浏览器靠 HSTS 兜底。
      // 只对可信 host 把 http 升级成 https（query 原样保留），绝不降级。
      if (
        parsed.protocol === 'http:' &&
        parsed.port === '80' &&
        parsed.username === '' &&
        options.upgradeInsecureHosts?.includes(parsed.hostname) === true
      ) {
        parsed = new URL(parsed.toString().replace(/^http:/, 'https:'));
        currentUrl = parsed.toString();
      }

      if (options.guard && !options.guard(parsed)) {
        throw new HttpError(`请求被安全策略拦截：${parsed.origin}`, undefined, currentUrl);
      }
      hops.push(currentUrl);

      const headers = new Headers(options.headers ?? {});
      if (!headers.has('User-Agent') && this.userAgent) {
        headers.set('User-Agent', this.userAgent);
      }
      if (!headers.has('Accept-Language')) {
        headers.set('Accept-Language', 'zh-CN,zh;q=0.9');
      }
      if (options.referer !== undefined && !headers.has('Referer')) {
        headers.set('Referer', options.referer);
      }
      const cookieHeader = this.jar.getCookieHeader(currentUrl);
      if (cookieHeader !== null) headers.set('Cookie', cookieHeader);

      let response: Response;
      try {
        response = await fetch(currentUrl, {
          method,
          headers,
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new HttpError(`网络请求失败（${parsed.host}）：${reason}`, undefined, currentUrl);
      }

      // 逐跳落 Cookie —— 这是整个登录流程能成立的关键
      this.absorbFrom(response, currentUrl);

      if (!follow || !isRedirect(response.status)) {
        const raw = options.skipBody
          ? new Uint8Array()
          : new Uint8Array(await response.arrayBuffer());
        return {
          status: response.status,
          url: currentUrl,
          headers: response.headers,
          body: options.skipBody ? '' : decodeBody(raw, response.headers.get('content-type')),
          hops,
        };
      }

      const location = response.headers.get('location');
      if (location === null || location === '') {
        return {
          status: response.status,
          url: currentUrl,
          headers: response.headers,
          body: '',
          hops,
        };
      }

      // 307/308 要求原样重发 body；301/302/303 一律降级成 GET
      if (response.status === 307 || response.status === 308) {
        if (method !== 'GET' && method !== 'HEAD') {
          throw new HttpError('重定向要求重复提交请求体，已停止以避免重复认证', response.status, currentUrl);
        }
      } else {
        method = 'GET';
        body = undefined;
      }

      currentUrl = new URL(location, currentUrl).toString();
    }

    throw new HttpError(`重定向次数超过上限（${maxRedirects}）`, undefined, currentUrl);
  }

  /** GET，返回文本。 */
  async get(url: string, options: SessionRequestOptions = {}): Promise<SessionResponse> {
    return this.request(url, { ...options, method: 'GET' });
  }

  /** POST 表单（application/x-www-form-urlencoded）。 */
  async postForm(
    url: string,
    fields: Record<string, string> | Array<[string, string]>,
    options: SessionRequestOptions = {},
  ): Promise<SessionResponse> {
    const entries = Array.isArray(fields) ? fields : Object.entries(fields);
    return this.request(url, {
      ...options,
      method: 'POST',
      body: encodeForm(entries),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(options.headers ?? {}),
      },
    });
  }

  /**
   * POST multipart。**不要自己设 Content-Type** —— fetch 会自动带上
   * 含 boundary 的头，手写会导致服务端解析不出分片。
   */
  async postMultipart(
    url: string,
    form: FormData,
    options: SessionRequestOptions = {},
  ): Promise<SessionResponse> {
    const headers = { ...(options.headers ?? {}) };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-type') delete headers[key];
    }
    return this.request(url, { ...options, method: 'POST', body: form, headers });
  }

  /** POST JSON。 */
  async postJson(
    url: string,
    payload: unknown,
    options: SessionRequestOptions = {},
  ): Promise<SessionResponse> {
    return this.request(url, {
      ...options,
      method: 'POST',
      body: JSON.stringify(payload),
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
    });
  }

  private absorbFrom(response: Response, url: string): void {
    // getSetCookie 能正确处理含逗号的 Expires，避免手工拆错
    const values =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : splitCombinedSetCookie(response.headers.get('set-cookie'));
    if (values.length > 0) this.jar.absorb(url, values);
  }
}

/** 兜底：把合并成一条的 Set-Cookie 拆开（按 `,name=` 边界）。 */
function splitCombinedSetCookie(combined: string | null): string[] {
  if (combined === null || combined === '') return [];
  return combined.split(/,(?=\s*[^;,=\s]+=)/).map((s) => s.trim());
}

/** application/x-www-form-urlencoded 编码（与 Dart `Uri.encodeQueryComponent` 一致）。 */
export function encodeForm(entries: Iterable<[string, string]>): string {
  const parts: string[] = [];
  for (const [key, value] of entries) {
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.join('&');
}
