/**
 * ChillEast Relay API (api.chilleast.soilzhu.su) 客户端。
 *
 * 所有 MCP 工具统一通过本客户端调用已部署的零状态中转服务，不再在 MCP 服务端
 * 直连湖南农业大学各内网/CAS 系统。
 */

import type { Env } from '../env';
import type { Credentials } from '../auth/session-manager';
import type { ToolContext } from '../mcp/registry';
import { getEffectiveSessionKey, seal } from '../auth/crypto-box';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 500, code = 'error') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export const DEFAULT_API_BASE_URL = 'https://api.chilleast.soilzhu.su';

export function getApiBaseUrl(env?: Env): string {
  const url = env?.API_BASE_URL ?? DEFAULT_API_BASE_URL;
  return url.replace(/\/+$/, '');
}

/** 默认 Token 有效期：30 天 */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function createStatelessToken(
  env: Env,
  credentials: Credentials,
  ttlMs = TOKEN_TTL_MS,
): Promise<string> {
  const payload = {
    oaId: credentials.oaId.trim(),
    oaKey: credentials.oaKey,
    exp: Date.now() + ttlMs,
  };
  const jsonStr = JSON.stringify(payload);
  const sealed = await seal(jsonStr, getEffectiveSessionKey(env));
  return sealed.replace(/\+/g, '-').replace(/\//g, '_');
}

const tokenCache = new Map<string, { token: string; exp: number }>();

export async function getRelayToken(context: { env: Env; credentials: Credentials }): Promise<string> {
  const cacheKey = `${context.credentials.oaId.trim()}:${context.credentials.oaKey}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.exp > Date.now() + 60_000) {
    return cached.token;
  }

  // 1. 如果本地配置了合法的 SESSION_KEY，直接本地签署，零开销自包含 Token
  if (context.env.SESSION_KEY && context.env.SESSION_KEY.length >= 32) {
    try {
      const token = await createStatelessToken(context.env, context.credentials);
      tokenCache.set(cacheKey, { token, exp: Date.now() + 24 * 3600 * 1000 });
      return token;
    } catch {
      // 密钥异常时回退到远程登录
    }
  }

  // 2. 本地无密钥或签署失败时，走 /api/auth/login 换取 Token
  const baseUrl = getApiBaseUrl(context.env);
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      oaId: context.credentials.oaId,
      oaKey: context.credentials.oaKey,
    }),
  });

  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok || !body?.ok || !body?.data?.token) {
    const message = body?.error?.message || `身份认证失败 (${res.status})`;
    const code = body?.error?.code || 'auth_failed';
    throw new ApiError(message, res.status, code);
  }

  const token = body.data.token as string;
  tokenCache.set(cacheKey, { token, exp: Date.now() + 24 * 3600 * 1000 });
  return token;
}

export async function callRelayApi<T = any>(
  arg1: ToolContext | { env: Env; credentials: Credentials } | Env,
  arg2: string | Credentials,
  arg3?: RequestInit | string,
  arg4?: RequestInit,
): Promise<T> {
  let env: Env;
  let credentials: Credentials;
  let path: string;
  let options: RequestInit = {};

  if (typeof arg2 === 'string') {
    // callRelayApi(context, path, options)
    const ctx = arg1 as { env: Env; credentials: Credentials };
    env = ctx.env;
    credentials = ctx.credentials;
    path = arg2;
    options = (arg3 as RequestInit) || {};
  } else {
    // callRelayApi(env, credentials, path, options)
    env = arg1 as Env;
    credentials = arg2;
    path = arg3 as string;
    options = arg4 || {};
  }

  const token = await getRelayToken({ env, credentials });
  const baseUrl = getApiBaseUrl(env);
  const url = path.startsWith('http://') || path.startsWith('https://')
    ? path
    : `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;

  const headers = new Headers(options.headers || {});
  if (!headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!headers.has('Content-Type') && options.method && options.method !== 'GET') {
    headers.set('Content-Type', 'application/json');
  }

  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData) && !(options.body instanceof ArrayBuffer) && !(options.body instanceof Uint8Array)) {
    options = {
      ...options,
      body: JSON.stringify(options.body),
    };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
    });
  } catch (err) {
    throw new ApiError(
      `请求 api.chilleast.soilzhu.su 失败: ${err instanceof Error ? err.message : String(err)}`,
      0,
      'network_error',
    );
  }

  let body: any;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  } else {
    body = await response.text();
  }

  if (!response.ok) {
    const message = body?.error?.message || body?.message || `接口请求失败 (${response.status})`;
    const code = body?.error?.code || 'request_failed';
    throw new ApiError(message, response.status, code);
  }

  if (body && typeof body === 'object' && body.ok === false) {
    const message = body.error?.message || body.message || '接口调用返回失败';
    const code = body.error?.code || 'api_error';
    throw new ApiError(message, 400, code);
  }

  return body?.data !== undefined ? body.data : body;
}
