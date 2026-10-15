import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const CREDENTIAL_HEADERS = {
  'Content-Type': 'application/json',
  'X-OA-Id': '20230001',
  'X-OA-Key': 'not-a-real-password',
};

function rpc(body: unknown, headers: Record<string, string> = CREDENTIAL_HEADERS): Request {
  return new Request('https://mcp.test/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('HTTP 层', () => {
  it('GET /health 免鉴权并报告工具数', async () => {
    const response = await SELF.fetch('https://mcp.test/health');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['status']).toBe('ok');
    expect(body['tools']).toBeGreaterThan(0);
    expect(body['sessionKeyConfigured']).toBe(true);
  });

  it('未知路径返回 404 并给出提示', async () => {
    const response = await SELF.fetch('https://mcp.test/nope');
    expect(response.status).toBe(404);
  });

  it('缺少凭据时返回 401 并说明如何配置', async () => {
    const response = await SELF.fetch(
      rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'Content-Type': 'application/json' }),
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('X-OA-Id');
  });

  it('GET /mcp 返回 405（无状态服务端不提供 SSE）', async () => {
    const response = await SELF.fetch('https://mcp.test/mcp', {
      method: 'GET',
      headers: CREDENTIAL_HEADERS,
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toContain('POST');
  });

  it('OPTIONS 预检带 CORS 头', async () => {
    const response = await SELF.fetch('https://mcp.test/mcp', { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('X-OA-Id');
  });
});

describe('凭据提取', () => {
  it('拒绝 Authorization: Bearer base64("学号:密码")（已废除明文 Base64 兼容）', async () => {
    const token = btoa('20230001:secret-pass');
    const response = await SELF.fetch(
      rpc(
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ),
    );
    expect(response.status).toBe(401);
  });

  it('拒绝 ?oa_id=&oa_key= 传入密码以防日志泄露（必须走请求头）', async () => {
    const response = await SELF.fetch(
      'https://mcp.test/mcp?oa_id=20230001&oa_key=secret-pass',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      },
    );
    expect(response.status).toBe(401);
  });
});

describe('MCP 协议', () => {
  it('initialize 回协商后的协议版本与工具能力', async () => {
    const response = await SELF.fetch(
      rpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', clientInfo: { name: 't', version: '1' } },
      }),
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } };
    };
    // 客户端要 2025-03-26，我们支持它就沿用
    expect(body.result.protocolVersion).toBe('2025-03-26');
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo.name).toBe('chilleast-mcp');
  });

  it('不认识的协议版本回落到我们最新的版本', async () => {
    const response = await SELF.fetch(
      rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }),
    );
    const body = (await response.json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe('2025-06-18');
  });

  it('通知返回 202 且无响应体', async () => {
    const response = await SELF.fetch(
      rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });

  it('tools/list 返回已实现工具，且 schema 合法', async () => {
    const response = await SELF.fetch(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
    };

    const names = body.result.tools.map((tool) => tool.name);
    expect(names).toContain('query_empty_classrooms');
    expect(names).toContain('query_notices');
    expect(names).toContain('query_questionnaires');

    for (const tool of body.result.tools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description.length).toBeGreaterThan(10);
      const schema = tool.inputSchema as { type?: string };
      expect(schema.type).toBe('object');
    }
  });

  it('tools/call 未知工具返回 JSON-RPC 错误', async () => {
    const response = await SELF.fetch(
      rpc({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'does_not_exist', arguments: {} },
      }),
    );
    const body = (await response.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32602); // InvalidParams
    expect(body.error.message).toContain('does_not_exist');
  });

  it('tools/call 参数非法（缺 name）返回错误', async () => {
    const response = await SELF.fetch(
      rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {} }),
    );
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32602);
  });

  it('未知方法返回 MethodNotFound', async () => {
    const response = await SELF.fetch(rpc({ jsonrpc: '2.0', id: 5, method: 'no/such/method' }));
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });

  it('ping 返回空结果', async () => {
    const response = await SELF.fetch(rpc({ jsonrpc: '2.0', id: 6, method: 'ping' }));
    const body = (await response.json()) as { result: unknown };
    expect(body.result).toEqual({});
  });

  it('非法 JSON 返回 ParseError', async () => {
    const response = await SELF.fetch(
      new Request('https://mcp.test/mcp', {
        method: 'POST',
        headers: CREDENTIAL_HEADERS,
        body: '{not json',
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it('批量请求逐条响应，通知被丢弃', async () => {
    const response = await SELF.fetch(
      rpc([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ]),
    );
    const body = (await response.json()) as Array<{ id: number }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((item) => item.id)).toEqual([1, 2]);
  });

  it('Content-Type 不对时返回 415', async () => {
    const response = await SELF.fetch(
      new Request('https://mcp.test/mcp', {
        method: 'POST',
        headers: { ...CREDENTIAL_HEADERS, 'Content-Type': 'text/plain' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(415);
  });
});
