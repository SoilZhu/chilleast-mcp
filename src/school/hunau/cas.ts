/**
 * CAS 服务票据交换 —— 用一个 SSO 会话（TGC）换取各子系统的本地会话。
 *
 * 复用 ChillEast `XgxtLoginService` / `RepairService._exchangeCasTicket` 的做法：
 * 逐跳手动跟随重定向。**必须逐跳**，因为每跳的 Set-Cookie（JSESSIONID）
 * 都要落到罐子里，否则服务端会把我们当成全新未认证会话，最后又弹回登录页。
 */

import { CookieSession, HttpError } from '../../auth/http';
import { SessionExpiredError } from '../../auth/session-manager';
import { URLS } from './constants';

export interface CasExchangeOptions {
  /** 子系统 CAS 入口，如 https://xgxt.hunau.edu.cn/cas */
  serviceUrl: string;
  /** 期望最终落在这个 host（否则视为票据无效被踢回 SSO） */
  expectedHost: string;
  /**
   * 这些 host 的 http:// 跳转升级为 https://。
   * 学校部分系统（bxpt / sun）确实会发 http 的 Location。
   */
  upgradeInsecureHosts?: readonly string[];
  /** 用于二次校验会话是否真的建立了 */
  sessionCookieName?: string;
  referer?: string;
  maxHops?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface CasExchangeResult {
  /** 最终落点 */
  finalUrl: string;
  finalStatus: number;
  body: string;
}

/**
 * 从 SSO 取一张 service ticket。
 * TGC 有效时 SSO 直接 302 带 ticket；返回 200 说明 TGC 已失效。
 */
async function fetchServiceTicket(session: CookieSession, serviceUrl: string): Promise<string> {
  const response = await session.get(
    `${URLS.ssoLogin}?service=${encodeURIComponent(serviceUrl)}`,
    {
      follow: false,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    },
  );

  // SSO 直接回登录页 = TGC 已失效
  if (response.status === 200) {
    throw new SessionExpiredError('统一认证已过期，请重新登录');
  }
  if (!REDIRECT_STATUSES.has(response.status)) {
    throw new HttpError(
      `无法获取 Service Ticket（HTTP ${response.status}）`,
      response.status,
      response.url,
    );
  }

  const location = response.headers.get('location');
  if (location === null || location === '') {
    throw new SessionExpiredError('无法获取 Service Ticket，可能登录已过期');
  }
  const ticket = new URL(location, URLS.ssoLogin).searchParams.get('ticket');
  if (ticket === null || ticket === '') {
    throw new SessionExpiredError('无法获取 Service Ticket，可能登录已过期');
  }
  return ticket;
}

/**
 * 完成一次 CAS 换票，把子系统的会话 Cookie 落进罐子。
 * 返回最终落点，调用方可据此判断是否真的进到了子系统。
 */
export async function exchangeCasTicket(
  session: CookieSession,
  options: CasExchangeOptions,
): Promise<CasExchangeResult> {
  const {
    serviceUrl,
    expectedHost,
    upgradeInsecureHosts = [],
    sessionCookieName,
    referer,
    maxHops = 10,
  } = options;

  // 换票前先看会话是否已经建立，省一次往返
  if (sessionCookieName !== undefined && session.jar.has(expectedHost, sessionCookieName)) {
    const probe = await session.get(serviceUrl.replace(/\/cas$/, '/wap/main/welcome'), {
      follow: false,
      ...(referer === undefined ? {} : { headers: { Referer: referer } }),
    });
    if (probe.status < 400 && !looksLikeLoginPage(probe)) {
      return { finalUrl: probe.url, finalStatus: probe.status, body: probe.body };
    }
  }

  const ticket = await fetchServiceTicket(session, serviceUrl);

  let currentUrl = `${serviceUrl}?ticket=${encodeURIComponent(ticket)}`;
  let last = { url: currentUrl, status: 0, body: '' };
  // 记录跳转链：换票失败时这是唯一能看出"卡在哪一跳"的信息
  const hops: string[] = [];

  for (let hop = 0; hop < maxHops; hop++) {
    const response = await session.get(currentUrl, {
      follow: false,
      upgradeInsecureHosts,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...(referer === undefined ? {} : { Referer: referer }),
      },
    });
    last = { url: response.url, status: response.status, body: response.body };
    hops.push(`${response.status} ${safePath(response.url)}`);

    if (!REDIRECT_STATUSES.has(response.status)) break;
    const location = response.headers.get('location');
    if (location === null || location === '') break;
    currentUrl = new URL(location, response.url).toString();
  }

  const trace = `跳转链：[${hops.join(' → ')}]，落点 ${safePath(last.url)}`;

  const finalHost = new URL(last.url).hostname;
  if (finalHost !== expectedHost) {
    // 票据无效时子系统 CAS 会把我们踢回 SSO，绝不能算成功
    throw new SessionExpiredError(
      `会话交换失败：最终落点不在 ${expectedHost}（落在 ${finalHost}）。${trace}`,
    );
  }
  if (looksLikeLoginPage(last)) {
    throw new SessionExpiredError(`会话交换失败：仍停留在登录页。${trace}`);
  }
  if (
    sessionCookieName !== undefined &&
    !session.jar.has(expectedHost, sessionCookieName)
  ) {
    const names = session.jar.describe().map((c) => `${c.name}@${c.domain}`).join(', ');
    throw new SessionExpiredError(
      `会话交换失败：缺少 ${sessionCookieName}。${trace}。` +
        `当前罐子里有：${names === '' ? '(空)' : names}`,
    );
  }

  return { finalUrl: last.url, finalStatus: last.status, body: last.body };
}

/** 只保留域名+路径（丢掉 query，那里可能有票据）。 */
function safePath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/** 粗略识别「被踢回登录页」。 */
export function looksLikeLoginPage(response: { url: string; body: string }): boolean {
  const head = response.body.slice(0, 2048);
  if (head.includes('CIMS.init')) return true;
  if (head.includes('cas/login') && head.includes('<html')) return true;
  try {
    const url = new URL(response.url);
    return url.pathname === '/login' || url.pathname.includes('/cas/login');
  } catch {
    return false;
  }
}
