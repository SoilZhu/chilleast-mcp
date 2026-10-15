/**
 * MCP (Model Context Protocol) 协议类型与常量。
 * 参考 spec revision 2024-11-05 / 2025-03-26 / 2025-06-18。
 */

/** 我们支持的协议版本，按新到旧排列。 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

export const LATEST_PROTOCOL_VERSION: ProtocolVersion = '2025-06-18';
export const SERVER_NAME = 'chilleast-mcp';
export const SERVER_VERSION = '0.1.0';

/** JSON-RPC 2.0 错误码 */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** MCP 工具定义。 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP 工具调用结果里的内容块。 */
export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpToolResult {
  content: McpTextContent[];
  isError?: boolean;
  /** 供客户端做结构化展示，不影响兼容性 */
  structuredContent?: unknown;
}

export function textResult(text: string, structuredContent?: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

export function errorResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** 判断请求是否是通知（没有 id，不需要响应）。 */
export function isNotification(request: JsonRpcRequest): boolean {
  return request.id === undefined || request.id === null;
}

/** 版本协商：客户端要的版本支持就沿用，否则回我们最新的。 */
export function negotiateProtocolVersion(requested: unknown): ProtocolVersion {
  if (
    typeof requested === 'string' &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
  ) {
    return requested as ProtocolVersion;
  }
  return LATEST_PROTOCOL_VERSION;
}
