/**
 * MCP 授权（OAuth 2.1 + PKCE + 动态客户端注册）：
 * ChatGPT 网页版与 Gemini 的远程 MCP 连接器只支持 OAuth。
 *
 * 服务端纯无状态模式：
 *   - 服务端不持久化存储用户的用户名、密码或密文。
 *   - /authorize 页面校验用户输入的账号密码能成功登录学校 SSO；
 *   - 校验通过后，签发包含加密凭据的自包含临时 code（5分钟有效）；
 *   - /token 端点校验 PKCE 后，返回经 AES-GCM 加密的自包含 access_token（1年有效）；
 *   - 客户端后续调用带上该 Bearer token，由 Worker 临时解密并在内存中转打学校 SSO。
 */

import type { Env } from '../env';
import { getEffectiveSessionKey, open, seal } from '../auth/crypto-box';
import { login } from '../auth/hunau-login';
import { renderAuthorizePage } from './authorize-page';
import { renderConsentPage } from './consent-page';
import { decodeTokenCredentials } from './resolve';
import { verifyTurnstile } from './turnstile';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "frame-ancestors 'none'; default-src 'self'; script-src 'self' https://challenges.cloudflare.com 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src https://challenges.cloudflare.com;",
    },
  });
}

/** 资源元数据（RFC 9728）。 */
export function protectedResourceMetadata(origin: string): Response {
  return json({
    resource: origin,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: [],
    resource_name: 'ChillEast MCP（湖南农大校园服务）',
  });
}

/** 授权服务器元数据（RFC 8414）。 */
export function authorizationServerMetadata(origin: string): Response {
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    // 公开客户端：没有 client secret，靠 PKCE 保证安全
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [],
    service_documentation: `${origin}/`,
  });
}

/** 401 时必须带这个头，客户端才知道去哪找授权服务器。 */
export function unauthorizedResponse(origin: string): Response {
  return json(
    {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32001,
        message:
          '需要授权。这个 MCP 服务器支持两种方式：' +
          '（1）OAuth —— 在 ChatGPT / Gemini 里直接添加连接器，浏览器会弹出登录页；' +
          '（2）请求头 X-OA-Id / X-OA-Key —— 供 Claude Code / Cursor 等支持自定义头的客户端使用。',
      },
    },
    401,
    {
      'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    },
  );
}

// ---- 动态客户端注册（RFC 7591）-------------------------------------------

export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}

interface ClientPayload {
  name: string;
  uris: string[];
  iat: number;
}

export async function createClientId(
  env: Env,
  clientName: string,
  redirectUris: string[],
): Promise<string> {
  const payload: ClientPayload = {
    name: clientName,
    uris: redirectUris,
    iat: Date.now(),
  };
  const jsonStr = JSON.stringify(payload);
  const sealed = await seal(jsonStr, getEffectiveSessionKey(env));
  return sealed.replace(/\+/g, '-').replace(/\//g, '_');
}

export async function parseClientId(env: Env, clientId: string): Promise<OAuthClient | null> {
  try {
    const rawSealed = clientId.replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = await open(rawSealed, getEffectiveSessionKey(env));
    const payload = JSON.parse(jsonStr) as ClientPayload;
    if (
      typeof payload.name !== 'string' ||
      !Array.isArray(payload.uris) ||
      payload.uris.length === 0
    ) {
      return null;
    }
    return {
      client_id: clientId,
      client_name: payload.name,
      redirect_uris: payload.uris,
    };
  } catch {
    return null;
  }
}

/** 内存中的轻量客户端注册记录（备用与测试容错） */
const registeredClients = new Map<string, OAuthClient>();

export function clearRegisteredClients(): void {
  registeredClients.clear();
}

export async function handleRegister(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return oauthError('invalid_client_metadata', '请求体不是合法 JSON');
  }

  const rawUris = body['redirect_uris'];
  const redirectUris = Array.isArray(rawUris)
    ? rawUris.filter((uri): uri is string => typeof uri === 'string' && uri !== '')
    : [];
  if (redirectUris.length === 0) {
    return oauthError('invalid_redirect_uri', '必须提供至少一个 redirect_uris');
  }
  for (const uri of redirectUris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return oauthError('invalid_redirect_uri', `redirect_uri 不是合法 URL：${uri}`);
    }
    const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !isLocalhost) {
      return oauthError('invalid_redirect_uri', 'redirect_uri 必须是 https（本地调试支持 http://localhost 或 http://127.0.0.1）');
    }
  }

  const clientName = typeof body['client_name'] === 'string' ? body['client_name'] : '';
  const clientId = await createClientId(env, clientName, redirectUris);

  const client: OAuthClient = {
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
  };
  registeredClients.set(clientId, client);

  return json(
    {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    201,
  );
}

// ---- 授权端点 --------------------------------------------------------------

interface AuthorizeParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
}

function readAuthorizeParams(source: URLSearchParams): AuthorizeParams {
  return {
    response_type: source.get('response_type') ?? '',
    client_id: source.get('client_id') ?? '',
    redirect_uri: source.get('redirect_uri') ?? '',
    state: source.get('state') ?? '',
    code_challenge: source.get('code_challenge') ?? '',
    code_challenge_method: source.get('code_challenge_method') ?? '',
  };
}

/** 校验参数并取出客户端。返回错误响应或客户端。 */
async function validateAuthorizeRequest(
  env: Env,
  params: AuthorizeParams,
): Promise<{ error: Response } | { client: OAuthClient }> {
  if (params.response_type !== 'code') {
    return { error: oauthError('unsupported_response_type', '只支持 response_type=code') };
  }
  if (params.client_id === '') {
    return { error: oauthError('invalid_request', '缺少 client_id') };
  }
  if (params.code_challenge === '' || params.code_challenge_method !== 'S256') {
    return { error: oauthError('invalid_request', '必须提供 PKCE 的 code_challenge，且 method 为 S256') };
  }

  const client = (await parseClientId(env, params.client_id)) ?? registeredClients.get(params.client_id);

  if (!client) {
    return { error: oauthError('invalid_client', '未注册的 client_id') };
  }
  if (!client.redirect_uris.includes(params.redirect_uri)) {
    return { error: oauthError('invalid_request', 'redirect_uri 与该客户端注册的不一致') };
  }
  return { client };
}

function loginPage(
  env: Env,
  params: AuthorizeParams,
  oaId: string,
  error: string | null,
): string {
  return renderAuthorizePage(
    Object.entries(params) as Array<[string, string]>,
    oaId,
    error,
    env.TURNSTILE_SITE_KEY ?? '',
  );
}

/** 客户端 IP（Cloudflare 注入）。 */
export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? '';
}

export function humanizeWait(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return '不到 1 分钟';
  if (minutes < 60) return `约 ${minutes} 分钟`;
  return `约 ${Math.ceil(minutes / 60)} 小时`;
}

export async function handleAuthorizeGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const params = readAuthorizeParams(url.searchParams);
  const validated = await validateAuthorizeRequest(env, params);
  if ('error' in validated) return validated.error;

  return html(loginPage(env, params, '', null));
}



interface CodePayload {
  oaId: string;
  oaKey: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  exp: number;
}

async function createAuthorizationCode(env: Env, payload: CodePayload): Promise<string> {
  const jsonStr = JSON.stringify(payload);
  const sealed = await seal(jsonStr, getEffectiveSessionKey(env));
  return sealed.replace(/\+/g, '-').replace(/\//g, '_');
}

async function parseAuthorizationCode(env: Env, code: string): Promise<CodePayload | null> {
  try {
    const rawSealed = code.replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = await open(rawSealed, getEffectiveSessionKey(env));
    const payload = JSON.parse(jsonStr) as CodePayload;
    if (
      typeof payload.oaId !== 'string' ||
      typeof payload.oaKey !== 'string' ||
      typeof payload.codeChallenge !== 'string' ||
      typeof payload.exp !== 'number'
    ) {
      return null;
    }
    if (Date.now() > payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

interface ConsentTicketPayload {
  oaId: string;
  oaKey: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  clientName: string;
  exp: number;
}

async function createConsentTicket(env: Env, payload: ConsentTicketPayload): Promise<string> {
  const jsonStr = JSON.stringify(payload);
  const sealed = await seal(jsonStr, getEffectiveSessionKey(env));
  return sealed.replace(/\+/g, '-').replace(/\//g, '_');
}

async function parseConsentTicket(env: Env, ticket: string): Promise<ConsentTicketPayload | null> {
  try {
    const rawSealed = ticket.replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = await open(rawSealed, getEffectiveSessionKey(env));
    const payload = JSON.parse(jsonStr) as ConsentTicketPayload;
    if (
      typeof payload.oaId !== 'string' ||
      typeof payload.oaKey !== 'string' ||
      typeof payload.clientId !== 'string' ||
      typeof payload.redirectUri !== 'string' ||
      typeof payload.codeChallenge !== 'string' ||
      typeof payload.exp !== 'number'
    ) {
      return null;
    }
    if (Date.now() > payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export async function handleAuthorizePost(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const flat = new URLSearchParams();
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') flat.set(key, value);
  }

  // 阶段二：用户在授权确认页（Consent Screen）做出的选择
  if (flat.get('action') === 'consent') {
    const decision = flat.get('decision') ?? '';
    const rawTicket = flat.get('consent_ticket') ?? '';
    if (rawTicket === '') {
      return oauthError('invalid_request', '缺少授权确认凭据');
    }

    const payload = await parseConsentTicket(env, rawTicket);
    if (payload === null) {
      return oauthError('invalid_request', '授权确认凭据已失效或过期，请重新登录授权');
    }

    // 用户取消授权
    if (decision === 'cancel') {
      const redirect = new URL(payload.redirectUri);
      redirect.searchParams.set('error', 'access_denied');
      redirect.searchParams.set('error_description', '用户取消了授权');
      if (payload.state !== '') redirect.searchParams.set('state', payload.state);
      return Response.redirect(redirect.toString(), 302);
    }

    // 用户同意授权：正式签发临时自包含加密 code（2分钟有效）并 302 重定向
    const code = await createAuthorizationCode(env, {
      oaId: payload.oaId,
      oaKey: payload.oaKey,
      clientId: payload.clientId,
      redirectUri: payload.redirectUri,
      codeChallenge: payload.codeChallenge,
      exp: Date.now() + 2 * 60 * 1000,
    });

    const redirect = new URL(payload.redirectUri);
    redirect.searchParams.set('code', code);
    if (payload.state !== '') redirect.searchParams.set('state', payload.state);
    return Response.redirect(redirect.toString(), 302);
  }

  // 阶段一：用户在登录页输入账号与密码
  const params = readAuthorizeParams(flat);
  const validated = await validateAuthorizeRequest(env, params);
  if ('error' in validated) return validated.error;

  const oaId = (flat.get('oa_id') ?? '').trim();
  const oaKey = flat.get('oa_key') ?? '';
  if (oaId === '' || oaKey === '') {
    return html(loginPage(env, params, '', '请填写账号与密码'), 400);
  }
  if (flat.get('consent') !== 'on') {
    return html(loginPage(env, params, oaId, '请先阅读并勾选下方的隐私与数据处理说明'), 400);
  }

  const ip = clientIp(request);

  // 1. IP 洪水防护
  if (env.LOGIN_RATE_LIMITER !== undefined) {
    const rateKey = ip === '' ? 'unknown' : ip;
    try {
      const outcome = await env.LOGIN_RATE_LIMITER.limit({ key: rateKey });
      if (!outcome.success) {
        return html(loginPage(env, params, oaId, '请求过于频繁，请稍后再试'), 429);
      }
    } catch {
      // 容错放行
    }
  }

  // 2. Turnstile 人机验证
  const turnstile = await verifyTurnstile(
    env.TURNSTILE_SECRET ?? '',
    flat.get('cf-turnstile-response') ?? '',
    ip,
    new URL(request.url).hostname,
  );
  if (!turnstile.ok) {
    console.warn(
      JSON.stringify({ event: 'authorize_turnstile_rejected', reason: turnstile.reason }),
    );
    return html(loginPage(env, params, oaId, turnstile.reason), 403);
  }

  // 3. 校验账号密码：实时去学校 SSO 登录一次
  try {
    await login(oaId, oaKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : '登录失败';
    return html(loginPage(env, params, oaId, message), 401);
  }

  // 4. 登录验证成功：先不重定向！展示授权确认页（Consent Screen），告知用户即将授权的目标域名
  const consentTicket = await createConsentTicket(env, {
    oaId,
    oaKey,
    clientId: params.client_id,
    redirectUri: params.redirect_uri,
    codeChallenge: params.code_challenge,
    state: params.state,
    clientName: validated.client.client_name,
    exp: Date.now() + 2 * 60 * 1000,
  });

  return html(
    renderConsentPage({
      clientName: validated.client.client_name,
      redirectUri: params.redirect_uri,
      oaId,
      consentTicket,
    }),
  );
}

// ---- 令牌端点 --------------------------------------------------------------

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE S256 校验：BASE64URL(SHA256(verifier)) 必须等于 challenge。 */
export async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  if (verifier === '' || challenge === '') return false;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const computed = bytesToBase64Url(new Uint8Array(digest));
  if (computed.length !== challenge.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ challenge.charCodeAt(i);
  }
  return diff === 0;
}

async function readTokenRequest(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === 'string') params.set(key, value);
      }
      return params;
    } catch {
      return new URLSearchParams();
    }
  }
  const form = await request.formData();
  const params = new URLSearchParams();
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') params.set(key, value);
  }
  return params;
}

export async function handleToken(request: Request, env: Env): Promise<Response> {
  const params = await readTokenRequest(request);
  const grantType = params.get('grant_type') ?? '';

  if (grantType === 'authorization_code') {
    const code = params.get('code') ?? '';
    const codeVerifier = params.get('code_verifier') ?? '';
    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';

    if (code === '' || codeVerifier === '') {
      return oauthError('invalid_request', '缺少 code 或 code_verifier');
    }

    const payload = await parseAuthorizationCode(env, code);
    if (payload === null) {
      return oauthError('invalid_grant', '授权码无效、已使用或已过期');
    }
    if (clientId !== '' && clientId !== payload.clientId) {
      return oauthError('invalid_grant', '授权码不是发给该客户端的');
    }
    if (redirectUri !== '' && redirectUri !== payload.redirectUri) {
      return oauthError('invalid_grant', 'redirect_uri 与授权时不一致');
    }
    if (!(await verifyPkce(codeVerifier, payload.codeChallenge))) {
      return oauthError('invalid_grant', 'PKCE 校验失败');
    }

    // 核心：签发加密的 JWE / Sealed Token（1年有效期）
    const TOKEN_TTL_SECONDS = 365 * 24 * 3600;
    const tokenPayload = {
      oaId: payload.oaId,
      oaKey: payload.oaKey,
      exp: Date.now() + TOKEN_TTL_SECONDS * 1000,
    };
    const accessToken = (await seal(JSON.stringify(tokenPayload), getEffectiveSessionKey(env)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    return json({
      access_token: accessToken,
      refresh_token: accessToken,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_SECONDS,
    });
  }

  if (grantType === 'refresh_token') {
    const refreshToken = params.get('refresh_token') ?? '';
    if (refreshToken === '') return oauthError('invalid_request', '缺少 refresh_token');

    const creds = await decodeTokenCredentials(env, refreshToken);
    if (creds === null) {
      return oauthError('invalid_grant', 'refresh_token 无效或已过期');
    }

    const TOKEN_TTL_SECONDS = 365 * 24 * 3600;
    const tokenPayload = {
      oaId: creds.oaId,
      oaKey: creds.oaKey,
      exp: Date.now() + TOKEN_TTL_SECONDS * 1000,
    };
    const newAccessToken = (await seal(JSON.stringify(tokenPayload), getEffectiveSessionKey(env)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    return json({
      access_token: newAccessToken,
      refresh_token: newAccessToken,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_SECONDS,
    });
  }

  return oauthError('unsupported_grant_type', `不支持的 grant_type：${grantType}`);
}
