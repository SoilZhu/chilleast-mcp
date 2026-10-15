/**
 * ChillEast MCP Serverless —— 入口。
 *
 * 湖南农业大学校园服务 MCP Server，运行在 Cloudflare Workers 上。
 * 纯无状态架构与零数据留存设计：
 *   - 服务端不持久化存储用户的用户名、密码或凭据密文；
 *   - 支持标准 OAuth 2.0 流程，签发 AES-GCM 加密的自包含 Bearer Token；
 *   - 每次 LLM 调用工具时带上该 Bearer Token，经由 Worker 临时内存中转请求学校 SSO 获取会话；
 *   - 单实例提供内存 RAM 防抖缓存，避免瞬时并发触发学校 SSO 风控。
 */

import type { Env } from './env';
import { LoginError, SessionUnavailableError, type Credentials } from './auth/session-manager';
import { handleMcpRequest, methodNotAllowed } from './mcp/server';
import { buildRegistry } from './tools';
import { SERVER_NAME, SERVER_VERSION } from './mcp/protocol';
import {
  authorizationServerMetadata,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleRegister,
  handleToken,
  protectedResourceMetadata,
  unauthorizedResponse,
} from './oauth/endpoints';
import { resolveBearerToken } from './oauth/resolve';

/** 注册表是纯数据 + 无状态 handler，模块级构建一次即可复用。 */
const registry = buildRegistry();

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, X-OA-Id, X-OA-Key',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * 从请求头里同步提取凭据（无需查库或发起网络请求）：
 *   - X-OA-Id / X-OA-Key：Claude Code / Cursor / Cline 等自定义请求头客户端
 */
function extractHeaderCredentials(request: Request): Credentials | null {
  const headerId = request.headers.get('X-OA-Id');
  const headerKey = request.headers.get('X-OA-Key');
  if (headerId !== null && headerId !== '' && headerKey !== null && headerKey !== '') {
    return { oaId: headerId.trim(), oaKey: headerKey };
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/health' || url.pathname === '/') {
      return withCors(
        json({
          service: SERVER_NAME,
          version: SERVER_VERSION,
          status: 'ok',
          tools: registry.size,
          sessionKeyConfigured: (env.SESSION_KEY ?? '') !== '',
          // 没配 pepper 时指纹退化为无盐 SHA-256（可离线爆破），这里要能看出来
          accountPepperConfigured: (env.ACCOUNT_PEPPER ?? '') !== '',
          // 没配验证码密钥时授权 POST 一律拒绝（fail closed）
          turnstileConfigured: (env.TURNSTILE_SECRET ?? '') !== '',
          rateLimiterConfigured: env.LOGIN_RATE_LIMITER !== undefined,
          auth: {
            // ChatGPT / Gemini 这类只支持 OAuth 的客户端走这条
            oauth: {
              protectedResource: '/.well-known/oauth-protected-resource',
              authorizationServer: '/.well-known/oauth-authorization-server',
              authorize: '/authorize',
            },
            // Claude Code / Cursor / Cline 走这条
            headers: ['X-OA-Id + X-OA-Key', 'Authorization: Bearer <Token>'],
          },
          endpoints: { mcp: '/mcp' },
        }),
      );
    }

    // ---- OAuth（ChatGPT 网页版 / Gemini 的唯一接入方式） ----
    // 有的客户端会把资源路径拼在 well-known 后面，两种都认
    if (
      url.pathname === '/.well-known/oauth-protected-resource' ||
      url.pathname === '/.well-known/oauth-protected-resource/mcp'
    ) {
      return protectedResourceMetadata(url.origin);
    }
    if (
      url.pathname === '/.well-known/oauth-authorization-server' ||
      url.pathname === '/.well-known/oauth-authorization-server/mcp'
    ) {
      return authorizationServerMetadata(url.origin);
    }
    if (url.pathname === '/register' && request.method === 'POST') {
      return withCors(await handleRegister(request, env));
    }
    if (url.pathname === '/authorize') {
      if (request.method === 'GET') return await handleAuthorizeGet(request, env);
      if (request.method === 'POST') return await handleAuthorizePost(request, env);
      return json({ error: 'Method Not Allowed' }, 405);
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      return withCors(await handleToken(request, env));
    }

    if (url.pathname !== '/mcp') {
      return withCors(
        json({ error: 'Not Found', hint: 'MCP 端点是 POST /mcp；OAuth 见 /health' }, 404),
      );
    }

    if (request.method === 'GET') {
      // 无状态服务端不提供 SSE 流
      return withCors(methodNotAllowed());
    }
    if (request.method === 'DELETE') {
      // 无状态服务端没有会话可删，按规范回 405
      return withCors(methodNotAllowed());
    }
    if (request.method !== 'POST') {
      return withCors(json({ error: 'Method Not Allowed' }, 405));
    }

    // 凭据来源：
    //   1. X-OA-Id / X-OA-Key（自定义请求头客户端）
    //   2. Authorization: Bearer <token>（OAuth 或 Token 客户端）
    let credentials = extractHeaderCredentials(request);
    if (credentials === null) {
      const authorization = request.headers.get('Authorization') ?? '';
      const bearer = /^Bearer\s+(.+)$/i.exec(authorization.trim());
      if (bearer !== null) {
        const token = bearer[1].trim();
        const resolved = await resolveBearerToken(env, token);
        if (resolved !== null) {
          credentials = resolved.credentials;
        }
      }
    }
    if (credentials === null) {
      return withCors(unauthorizedResponse(url.origin));
    }

    try {
      const response = await handleMcpRequest(request, { env, registry, credentials });
      return withCors(response);
    } catch (error) {
      if (error instanceof LoginError || error instanceof SessionUnavailableError) {
        return withCors(json({ error: { message: error.message } }, 401));
      }
      const message = error instanceof Error ? error.message : '未知错误';
      console.error(JSON.stringify({ level: 'error', message }));
      return withCors(json({ error: { message: '服务内部错误' } }, 500));
    }
  },
} satisfies ExportedHandler<Env>;
