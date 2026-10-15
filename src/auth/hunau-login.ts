/**
 * 湖南农业大学统一身份认证（CIMS/CAS）服务端登录。
 *
 * 流程与 ChillEast `HttpLoginService` 一致，只是把 Dio 换成 fetch：
 *   CAS 登录页 -> CIMS iframe -> getqrcode -> othertype -> checkAuthcode
 *   -> 提交签名到 CAS -> 跟随回跳授权融合门户 -> 校验身份
 *
 * 产物是一个 CookieJar：里面同时包含 sso.hunau.edu.cn（TGC）与
 * passport2-api.chaoxing.com / portal.hunau.edu.cn 的会话 Cookie。
 * 后续各子系统靠 CAS ticket 换票（见 sessions.ts）即可复用，无需再次输密码。
 */

import { CimsLoginError, assertTrustedSso, parseCimsBootstrap } from './cims';
import { CookieJar } from './cookies';
import { CookieSession, HttpError } from './http';
import { encryptCimsPassword } from './rsa';
import { MOBILE_UA, URLS } from '../school/hunau/constants';

export interface LoginIdentity {
  /** 学工号 */
  username: string;
  /** 姓名 */
  realName: string;
  /** SSO 侧用户 id（fetchCurrentUserInfo 返回） */
  userId?: string;
}

export interface LoginResult {
  jar: CookieJar;
  identity: LoginIdentity;
  /** 实际发出的请求数，用于诊断 */
  requestCount: number;
  elapsedMs: number;
}

export class LoginError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'LoginError';
  }
}

/** 认证接口 status -> 用户可读消息（服务器原始 body 绝不回显，可能含凭据）。 */
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  '90091': '需要图形验证码，请在官方页面完成验证后重试',
  '9401': '需要初始化或重置密码，请在官方页面完成',
  '9009': '认证会话已过期或需要其他认证方式，请重新登录',
  '9001': '签名无效，请重新登录',
  '9011': '账号、密码或验证码验证失败',
  '9052': '账号或密码错误',
  '9005': '服务端限制了请求频率，请稍后再试',
};

/** 认证接口统一校验：status 必须为 1000。 */
function successfulApi(response: { body: string }): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new LoginError('认证接口返回结构异常', 'auth_bad_json');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LoginError('认证接口返回结构异常', 'auth_bad_shape');
  }
  const body = parsed as Record<string, unknown>;
  const code = String(body['status'] ?? '');
  if (code !== '1000') {
    const message = AUTH_ERROR_MESSAGES[code] ?? '认证接口拒绝本次请求';
    throw new LoginError(message, AUTH_ERROR_MESSAGES[code] ? code : 'auth_rejected');
  }
  return body;
}

/** 允许在融合门户授权阶段跟随的跳转目标。 */
function portalRedirectGuard(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  const host = url.hostname;
  return (
    host === 'sso.hunau.edu.cn' ||
    host === 'portal.hunau.edu.cn' ||
    host === 'passport2.chaoxing.com' ||
    host === 'passport2-api.chaoxing.com'
  );
}

/** 仅允许 SSO 源的严格守卫（提交密码阶段）。 */
function ssoOnlyGuard(url: URL): boolean {
  try {
    assertTrustedSso(url);
    return true;
  } catch {
    return false;
  }
}

interface PortalIdentityGuess {
  username: string;
  realName: string;
}

/**
 * 尽力解析融合门户渲染出来的身份信息（div.infoTxt）。
 * 解析不出来返回 null —— 这不算失败，权威校验用 fetchCurrentUserInfo。
 */
async function parsePortalIdentity(html: string): Promise<PortalIdentityGuess | null> {
  if (/<input\b[^>]*type\s*=\s*["']?password/i.test(html)) return null;
  // workerd 实测坑：`HTMLRewriter.transform().text()` 对**空响应体**永远不会
  // resolve（会一直挂到超时）。空输入本来也没有可解析的内容，直接短路。

  if (html.trim() === '') return null;

  const identities: Array<{ text: string; realName: string }> = [];
  let inInfo = false;
  let infoText = '';
  let realName = '';
  let inRealName = false;

  const rewriter = new HTMLRewriter()
    .on('div.infoTxt', {
      element(element) {
        inInfo = true;
        infoText = '';
        realName = '';
        element.onEndTag(() => {
          identities.push({ text: infoText, realName });
          inInfo = false;
        });
      },
      text(chunk) {
        if (inInfo) infoText += chunk.text;
      },
    })
    .on('div.infoTxt em', {
      element(element) {
        inRealName = true;
        element.onEndTag(() => {
          inRealName = false;
        });
      },
      text(chunk) {
        if (inRealName) realName += chunk.text;
      },
    });

  await rewriter.transform(new Response(html)).text();

  if (identities.length !== 1) return null;
  const info = identities[0];
  const name = info.realName.trim();
  const account = /(?:学工号|学号|工号)\s*[：:]\s*([A-Za-z0-9._@-]+)/.exec(info.text)?.[1];
  if (name === '' || account === undefined || account === '') return null;
  return { username: account, realName: name };
}

/**
 * 用 SSO 的 JSON 接口确认「确实登录成功了」。
 * 这是权威校验：HTML 登录页 / 被反射的表单都不算证据。
 */
async function verifySsoUser(
  session: CookieSession,
): Promise<{ userId: string } | null> {
  const response = await session.get(URLS.ssoFetchCurrentUser, {
    headers: { Accept: 'application/json' },
    guard: ssoOnlyGuard,
  });
  if (response.status !== 200) return null;
  try {
    const body = JSON.parse(response.body) as Record<string, unknown>;
    if (body['ok'] !== true) return null;
    const data = body['data'];
    if (typeof data !== 'object' || data === null) return null;
    const userId = (data as Record<string, unknown>)['userId'];
    const normalized =
      typeof userId === 'string' ? userId : typeof userId === 'number' ? String(userId) : '';
    if (normalized === '' || normalized === '0') return null;
    return { userId: normalized };
  } catch {
    return null;
  }
}

/**
 * 执行一次完整登录。
 * @param username 学号 / 工号
 * @param password 统一身份认证密码
 */
export async function login(username: string, password: string): Promise<LoginResult> {
  if (username === '' || password === '') {
    throw new LoginError('账号和密码不能为空', 'empty_credentials');
  }

  const startedAt = Date.now();
  const session = new CookieSession(new CookieJar(), MOBILE_UA);
  let requestCount = 0;

  const count = <T>(value: T): T => {
    requestCount++;
    return value;
  };

  // ---- 1. 取融合门户登录页 ----
  const fusionLoginUrl = `${URLS.ssoLogin}?service=${encodeURIComponent(URLS.portalLogin)}`;
  const page = count(
    await session.get(fusionLoginUrl, {
      guard: portalRedirectGuard,
      headers: {
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
      },
    }),
  );
  if (page.status !== 200) {
    throw new LoginError(`登录入口返回 HTTP ${page.status}`, 'sso_entry_failed');
  }

  // ---- 2. 解析 CIMS 引导配置 ----
  let bootstrap;
  try {
    bootstrap = await parseCimsBootstrap(page.body, page.url);
  } catch (error) {
    if (error instanceof CimsLoginError) throw new LoginError(error.message, 'cims_parse');
    throw error;
  }

  // ---- 3. 打开认证 iframe ----
  const iframe = count(
    await session.get(bootstrap.iframeUri, {
      referer: bootstrap.parentUri,
      guard: ssoOnlyGuard,
      headers: {
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        'X-Requested-With': 'XMLHttpRequest',
      },
    }),
  );
  if (iframe.status !== 200) {
    throw new LoginError(`认证 iframe 返回 HTTP ${iframe.status}`, 'iframe_failed');
  }

  // ---- 4. 初始化认证会话 (getqrcode) ----
  const qrCodeUrl =
    new URL('api/verify/getqrcode', bootstrap.authBase).toString() +
    '?' +
    new URLSearchParams({
      type: '0',
      sign: bootstrap.sign,
      username: '',
      urlCode: bootstrap.appUrl,
    }).toString();

  const initial = successfulApi(
    count(
      await session.get(qrCodeUrl, {
        referer: bootstrap.iframeUri,
        guard: ssoOnlyGuard,
        follow: false,
        headers: {
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
      }),
    ),
  );
  if (String(initial['token'] ?? '') === '') {
    throw new LoginError('认证初始化响应缺少 token', 'auth_no_token');
  }
  const policy = String(initial['policy']);
  const authTypes = String(initial['authtypes']).split(',');
  if (!['0', '1'].includes(policy) || !authTypes.includes('8')) {
    throw new LoginError(
      '本次策略不允许普通密码登录或需要组合认证，请使用官方页面',
      'auth_policy_blocked',
    );
  }

  // ---- 5. 取一次性密码 token 与公钥 ----
  const issuedResponse = successfulApi(
    count(
      await session.postForm(
        new URL('api/verify/othertype', bootstrap.authBase).toString(),
        {
          sign: bootstrap.sign,
          username,
          type: '8',
          appUrl: bootstrap.appUrl,
        },
        {
          referer: bootstrap.iframeUri,
          guard: ssoOnlyGuard,
          follow: false,
          headers: {
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: 'https://sso.hunau.edu.cn',
          },
        },
      ),
    ),
  );
  const issued = issuedResponse['response_body'];
  if (typeof issued !== 'object' || issued === null) {
    throw new LoginError('认证响应缺少 token、公钥或加密配置', 'auth_bad_issue');
  }
  const issuedMap = issued as Record<string, unknown>;
  const token = issuedMap['token'];
  const publicKey = issuedMap['publicKey'];
  const encryptor = issuedMap['encryptor'];
  if (
    typeof token !== 'string' ||
    token === '' ||
    typeof publicKey !== 'string' ||
    publicKey === '' ||
    typeof encryptor !== 'string' ||
    encryptor === ''
  ) {
    throw new LoginError('认证响应缺少 token、公钥或加密配置', 'auth_bad_issue');
  }

  let encryptedPassword: string;
  try {
    encryptedPassword = encryptCimsPassword(publicKey, encryptor, password, token);
  } catch (error) {
    throw new LoginError(
      error instanceof Error ? error.message : '密码加密失败',
      'password_encrypt',
    );
  }

  // ---- 6. 校验加密密码，拿 usersign ----
  const checkedResponse = successfulApi(
    count(
      await session.postForm(
        new URL('api/verify/checkAuthcode', bootstrap.authBase).toString(),
        {
          sign: bootstrap.sign,
          token,
          authcode: encryptedPassword,
          type: '8',
          username,
          vericode: '',
          verificationcode: '',
          uuid: '',
          appUrl: bootstrap.appUrl,
        },
        {
          referer: bootstrap.iframeUri,
          guard: ssoOnlyGuard,
          follow: false,
          headers: {
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: 'https://sso.hunau.edu.cn',
          },
        },
      ),
    ),
  );
  const checked = checkedResponse['response_body'];
  const usersign =
    typeof checked === 'object' && checked !== null
      ? (checked as Record<string, unknown>)['usersign']
      : undefined;
  if (
    typeof usersign !== 'string' ||
    !/^[A-Z]{4}\|[A-Za-z0-9+/]+=*\|[A-Za-z0-9+/]+=*$/.test(usersign)
  ) {
    throw new LoginError('认证接口没有返回有效的 usersign', 'auth_no_usersign');
  }

  // ---- 7. 提交 CAS 签名 ----
  // 保留页面上的所有 hidden 字段（含 cimsUser 等），只替换签名字段。
  // 用户的密码从不发往 CAS。
  const fields: Array<[string, string]> = bootstrap.fields
    .filter(([key]) => key !== bootstrap.signatureField)
    .concat([[bootstrap.signatureField, `${usersign}:${bootstrap.appSignature}`]]);

  const submitted = count(
    await session.postForm(bootstrap.postUri, fields, {
      referer: bootstrap.parentUri,
      guard: ssoOnlyGuard,
      follow: false,
      headers: {
        Origin: 'https://sso.hunau.edu.cn',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }),
  );
  if (submitted.status === 307 || submitted.status === 308) {
    throw new LoginError('认证请求要求重复提交，已停止以避免重复认证', 'auth_repeat_submit');
  }
  const location = submitted.headers.get('location');
  if (![301, 302, 303].includes(submitted.status) || location === null || location === '') {
    throw new LoginError('CAS 未返回有效的门户跳转，未重试认证', 'cas_no_redirect');
  }

  // ---- 8. 跟随回跳，完成融合门户授权 ----
  const portal = count(
    await session.get(new URL(location, bootstrap.postUri).toString(), {
      guard: portalRedirectGuard,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }),
  );
  const portalUrl = new URL(portal.url);
  if (
    portal.status !== 200 ||
    portalUrl.hostname !== 'portal.hunau.edu.cn' ||
    portalUrl.pathname === '/login' ||
    portalUrl.pathname.includes('/cas/login') ||
    portal.body.includes('CIMS.init') ||
    /<input\b[^>]*type\s*=\s*["']?password/i.test(portal.body)
  ) {
    throw new LoginError('SSO 认证成功，但融合门户授权未完成，请重新登录', 'portal_not_authorized');
  }

  // ---- 9. 校验身份 ----
  const guessed = await parsePortalIdentity(portal.body);
  if (guessed !== null && guessed.username !== username) {
    throw new LoginError('门户返回的账号与本次登录账号不一致，已停止登录', 'identity_mismatch');
  }

  let userId: string | undefined;
  if (guessed === null) {
    // 门户结构变了也别失败：退回 SSO 的 JSON 接口做权威校验
    const verified = await verifySsoUser(session);
    if (verified === null) {
      throw new LoginError('认证已提交，但未确认登录成功', 'verify_failed');
    }
    userId = verified.userId;
  }

  session.jar.prune();

  return {
    jar: session.jar,
    identity: {
      username: guessed?.username ?? username,
      realName: guessed?.realName ?? '',
      ...(userId === undefined ? {} : { userId }),
    },
    requestCount,
    elapsedMs: Date.now() - startedAt,
  };
}

export { HttpError, CookieSession };
