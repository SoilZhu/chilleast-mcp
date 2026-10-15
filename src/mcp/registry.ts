/**
 * MCP 工具注册表。
 * 工具只声明 schema 与 handler，凭据 / 会话 / 重登由框架层注入。
 */

import type { Env } from '../env';
import type { Credentials } from '../auth/session-manager';
import type { McpToolDefinition, McpToolResult } from './protocol';

export interface ToolContext {
  env: Env;
  credentials: Credentials;
  /** 结构性日志（不含凭据、不含 Cookie 值） */
  log: (message: string, fields?: Record<string, unknown>) => void;
}

export interface ToolDefinition extends McpToolDefinition {
  handler: (args: Record<string, unknown>, context: ToolContext) => Promise<McpToolResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具重名：${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): McpToolDefinition[] {
    return [...this.tools.values()]
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get size(): number {
    return this.tools.size;
  }
}
