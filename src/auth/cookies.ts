/**
 * 一个最小但语义正确的 Cookie 罐。
 *
 * 关键点（与 ChillEast 客户端 `HttpLoginService._request` 的做法一致）：
 *  1. Cookie 只按「收到它的那个响应源」保存。Dio 的 CookieManager 会把重定向
 *     Cookie 也复制到 Location 的源上，破坏 host-only 隔离 —— 这里不这么做。
 *  2. 没有 Domain 属性的 Cookie 是 host-only，只能回发给完全相同的 host；
 *     不能因为「同后缀」就发出去。
 *  3. 过期、Secure、Path 都参与匹配。
 */

export interface StoredCookie {
  name: string;
  value: string;
  /** 去掉前导点的小写域名；host-only 时等于 host */
  domain: string;
  path: string;
  /** 是否有 Domain 属性（决定 host-only 还是 domain 匹配） */
  hostOnly: boolean;
  /** epoch 秒；undefined 表示会话 Cookie */
  expires?: number;
  secure: boolean;
  httpOnly: boolean;
}

/** 解析单条 Set-Cookie。 */
export function parseSetCookie(header: string, requestUrl: string): StoredCookie | null {
  const url = new URL(requestUrl);
  const parts = header.split(';');
  const first = parts.shift();
  if (!first) return null;

  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (name === '') return null;

  let domain: string | null = null;
  let path: string | null = null;
  let expires: number | undefined;
  let secure = false;
  let httpOnly = false;

  for (const rawAttribute of parts) {
    const attribute = rawAttribute.trim();
    if (attribute === '') continue;
    const index = attribute.indexOf('=');
    const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
    const attrValue = index < 0 ? '' : attribute.slice(index + 1).trim();

    switch (key) {
      case 'domain':
        if (attrValue !== '') domain = attrValue.replace(/^\./, '').toLowerCase();
        break;
      case 'path':
        if (attrValue.startsWith('/')) path = attrValue;
        break;
      case 'max-age': {
        const seconds = Number.parseInt(attrValue, 10);
        if (Number.isFinite(seconds)) {
          expires = seconds <= 0 ? 0 : Math.floor(Date.now() / 1000) + seconds;
        }
        break;
      }
      case 'expires': {
        // Max-Age 优先于 Expires
        if (expires === undefined) {
          const parsed = Date.parse(attrValue);
          if (!Number.isNaN(parsed)) expires = Math.floor(parsed / 1000);
        }
        break;
      }
      case 'secure':
        secure = true;
        break;
      case 'httponly':
        httpOnly = true;
        break;
      default:
        break;
    }
  }

  const host = url.hostname.toLowerCase();

  // Domain 必须是当前 host 的后缀，否则拒收（防跨站写 Cookie）
  if (domain !== null && !(host === domain || host.endsWith(`.${domain}`))) {
    throw new Error(`Cookie domain ${domain} does not match request host ${host}`);
  }

  const hostOnly = domain === null;
  const effectiveDomain = domain ?? host;

  let effectivePath = path;
  if (effectivePath === null) {
    const lastSlash = url.pathname.lastIndexOf('/');
    effectivePath = lastSlash <= 0 ? '/' : url.pathname.slice(0, lastSlash);
  }

  return {
    name,
    value,
    domain: effectiveDomain,
    path: effectivePath,
    hostOnly,
    ...(expires === undefined ? {} : { expires }),
    secure,
    httpOnly,
  };
}

/** RFC 6265 的 path-match。 */
function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === requestPath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith('/')) return true;
  return requestPath[cookiePath.length] === '/';
}

/** RFC 6265 的 domain-match。 */
function domainMatches(cookie: StoredCookie, host: string): boolean {
  if (cookie.hostOnly) return host === cookie.domain;
  return host === cookie.domain || host.endsWith(`.${cookie.domain}`);
}

export class CookieJar {
  private cookies: StoredCookie[] = [];

  constructor(initial: StoredCookie[] = []) {
    this.cookies = [...initial];
  }

  /**
   * 从一次响应中吸收 Cookie。
   * @param setCookieValues `Headers.getSetCookie()` 的结果（已按条拆分）。
   */
  absorb(requestUrl: string, setCookieValues: readonly string[]): void {
    for (const header of setCookieValues) {
      let cookie: StoredCookie | null = null;
      try {
        cookie = parseSetCookie(header, requestUrl);
      } catch {
        // 域名不匹配的 Cookie 直接丢弃，不污染罐子
        continue;
      }
      if (cookie === null) continue;
      this.put(cookie);
    }
  }

  /** 写入并按 (name, domain, path) 覆盖旧值；已过期则删除。 */
  put(cookie: StoredCookie): void {
    const now = Math.floor(Date.now() / 1000);
    const index = this.cookies.findIndex(
      (c) => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path,
    );
    if (cookie.expires !== undefined && cookie.expires <= now) {
      if (index >= 0) this.cookies.splice(index, 1);
      return;
    }
    if (index >= 0) this.cookies[index] = cookie;
    else this.cookies.push(cookie);
  }

  /** 生成回发给某个 URL 的 Cookie 头；没有可用 Cookie 时返回 null。 */
  getCookieHeader(url: string): string | null {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname === '' ? '/' : parsed.pathname;
    const isSecure = parsed.protocol === 'https:';
    const now = Math.floor(Date.now() / 1000);

    const matched = this.cookies.filter((c) => {
      if (c.expires !== undefined && c.expires <= now) return false;
      if (c.secure && !isSecure) return false;
      if (!domainMatches(c, host)) return false;
      return pathMatches(c.path, path);
    });

    if (matched.length === 0) return null;

    // 路径更长的优先，和浏览器行为一致
    matched.sort((a, b) => b.path.length - a.path.length);
    return matched.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /** 取某个 host 下指定名字的 Cookie 值。 */
  get(host: string, name: string): string | undefined {
    const lower = host.toLowerCase();
    return this.cookies.find((c) => c.name === name && domainMatches(c, lower))?.value;
  }

  /** 是否存在指定名字的 Cookie。 */
  has(host: string, name: string): boolean {
    return this.get(host, name) !== undefined;
  }

  /** 清空。 */
  clear(): void {
    this.cookies = [];
  }

  /** 剔除已过期项。 */
  prune(): void {
    const now = Math.floor(Date.now() / 1000);
    this.cookies = this.cookies.filter((c) => c.expires === undefined || c.expires > now);
  }

  /** 仅保留满足条件的 Cookie（用于只持久化会话所需的域）。 */
  filter(predicate: (cookie: StoredCookie) => boolean): CookieJar {
    return new CookieJar(this.cookies.filter(predicate));
  }

  get size(): number {
    return this.cookies.length;
  }

  /** 调试/诊断用：只给名字和域，绝不带值。 */
  describe(): Array<{ name: string; domain: string; path: string }> {
    return this.cookies.map((c) => ({ name: c.name, domain: c.domain, path: c.path }));
  }

  toJSON(): StoredCookie[] {
    return this.cookies.map((c) => ({ ...c }));
  }

  static fromJSON(data: readonly StoredCookie[]): CookieJar {
    const jar = new CookieJar(data.map((c) => ({ ...c })));
    jar.prune();
    return jar;
  }
}
