/**
 * MCP Streamable HTTP 传输 + JSON-RPC 分发。
 *
 * 这是**纯无状态**服务端：不签发 Mcp-Session-Id，每个请求由客户端自带凭据。
 * 适合 serverless 环境，服务端不持久化存储任何凭据或数据库，由请求携带凭据
 * 并在 Worker 内存中转代理打学校 SSO 执行工具。
 */

import type { Env } from '../env';
import { LoginError, SessionExpiredError, SessionUnavailableError } from '../auth/session-manager';
import type { Credentials } from '../auth/session-manager';
import {
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  errorResult,
  isNotification,
  negotiateProtocolVersion,
  textResult,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpToolResult,
} from './protocol';
import type { ToolRegistry } from './registry';

export interface ServerDependencies {
  env: Env;
  registry: ToolRegistry;
  credentials: Credentials;
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function success(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function failure(
  id: JsonRpcRequest['id'],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

/** 处理单个 JSON-RPC 请求。返回 null 表示这是通知，不需要响应。 */
async function handleRequest(
  request: JsonRpcRequest,
  deps: ServerDependencies,
): Promise<JsonRpcResponse | null> {
  const { registry, env, credentials } = deps;

  switch (request.method) {
    case 'initialize': {
      const requested = request.params?.['protocolVersion'];
      const protocolVersion = negotiateProtocolVersion(requested);
      return success(request.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          '湖南农业大学（Hunan Agricultural University）校园服务工具。' +
          '需要在该 MCP 客户端的请求头里提供 X-OA-Id（学号）与 X-OA-Key（统一身份认证密码）。',
      });
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/roots/list_changed':
      return null;

    case 'ping':
      return success(request.id, {});

    case 'tools/list':
      return success(request.id, { tools: registry.list() });

    case 'tools/call': {
      const params = request.params;
      const name = params?.['name'];
      if (typeof name !== 'string' || name === '') {
        return failure(request.id, ErrorCode.InvalidParams, '缺少工具名称 params.name');
      }
      const tool = registry.get(name);
      if (tool === undefined) {
        return failure(request.id, ErrorCode.InvalidParams, `未知工具：${name}`);
      }

      const rawArguments = params?.['arguments'];
      const args =
        typeof rawArguments === 'object' && rawArguments !== null && !Array.isArray(rawArguments)
          ? (rawArguments as Record<string, unknown>)
          : {};

      const log = (message: string, fields?: Record<string, unknown>) => {
        console.log(JSON.stringify({ tool: name, message, ...(fields ?? {}) }));
      };

      try {
        const result = await tool.handler(args, { env, credentials, log });
        return success(request.id, result);
      } catch (error) {
        // 工具执行失败按 MCP 规范包成 isError 结果，而不是 JSON-RPC 错误，
        // 这样模型能看到失败原因并自行调整。
        return success(request.id, toErrorResult(error, name));
      }
    }

    default:
      return failure(
        request.id,
        ErrorCode.MethodNotFound,
        `未知的 MCP 方法：${request.method}`,
      );
  }
}

/** 把内部异常翻译成模型可读、且不泄露敏感信息的错误结果。 */
function toErrorResult(error: unknown, toolName: string): McpToolResult {
  if (error instanceof SessionExpiredError) {
    return errorResult(`校园会话已失效且自动重登未成功，请重试。(${error.message})`);
  }
  if (error instanceof SessionUnavailableError) {
    return errorResult(`无法建立校园会话：${error.message}`);
  }
  if (error instanceof LoginError) {
    const hint = error.code ?? '';
    return errorResult(
      `登录失败：${error.message}` +
        (hint === 'auth_policy_blocked' || hint === 'auth_rejected'
          ? '（如提示需要验证码，请先在浏览器完成一次登录）'
          : ''),
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return errorResult(`执行工具 [${toolName}] 失败：${message}`);
}

/** 处理 POST /mcp 的请求体。 */
export async function handleMcpRequest(
  request: Request,
  deps: ServerDependencies,
): Promise<Response> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return jsonResponse(
      failure(null, ErrorCode.InvalidRequest, 'Content-Type 必须是 application/json'),
      415,
    );
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return jsonResponse(failure(null, ErrorCode.ParseError, 'JSON 解析失败'), 400);
  }

  // 批量请求（2025-03-26 及更早支持；2025-06-18 已移除，这里向后兼容）
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return jsonResponse(failure(null, ErrorCode.InvalidRequest, '空批量请求'), 400);
    }
    const responses: JsonRpcResponse[] = [];
    for (const item of parsed) {
      const single = await handleRequest(item as JsonRpcRequest, deps);
      if (single !== null) responses.push(single);
    }
    // 全是通知：按规范回 202 空响应
    if (responses.length === 0) return new Response(null, { status: 202 });
    return jsonResponse(responses);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return jsonResponse(failure(null, ErrorCode.InvalidRequest, '请求体不是 JSON 对象'), 400);
  }

  const rpc = parsed as JsonRpcRequest;
  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    return jsonResponse(
      failure(rpc.id ?? null, ErrorCode.InvalidRequest, '不是合法的 JSON-RPC 2.0 请求'),
      400,
    );
  }

  const response = await handleRequest(rpc, deps);
  if (response === null) {
    // 通知一律回 202
    return new Response(null, { status: 202 });
  }
  return jsonResponse(response);
}

/** GET /mcp：无状态服务端不提供 SSE 流，按规范回 405。 */
export function methodNotAllowed(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: ErrorCode.InvalidRequest,
        message: '本服务端为无状态模式，仅支持 POST。请使用 POST /mcp 发送 JSON-RPC 请求。',
      },
    }),
    { status: 405, headers: { ...JSON_HEADERS, Allow: 'POST, DELETE, OPTIONS' } },
  );
}

export { LATEST_PROTOCOL_VERSION, textResult };
