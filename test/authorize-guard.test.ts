import { fetchMock, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { credentialFingerprint } from '../src/auth/crypto-box';

/**
 * `/authorize` 的防滥用：守的是「这个服务不会被当成校园密码爆破器」——
 * 没有验证码不许碰学校接口、按账号锁定、注册回调域名受限、指纹带密钥。
 * 全部走 SELF.fetch + fetchMock，出网的请求都被拦下，测试不碰真实学校。
 */

const BASE = 'https://mcp.test';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const VERIFIER = 'verifier-abcdefghijklmnopqrstuvwxyz-0123456789';
const TEST_PEPPER = 'dGVzdC1wZXBwZXItMzItYnl0ZXMtZm9yLXVuaXQtdGVzdHM=';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

/** 让 siteverify 返回指定结果（默认成功，hostname 与本测试的 host 一致）。 */
function mockSiteverify(success: boolean, times = 1, hostname = 'mcp.test'): void {
  fetchMock
    .get('https://challenges.cloudflare.com')
    .intercept({ path: '/turnstile/v0/siteverify', method: 'POST' })
    .reply(
      200,
      success
        ? { success: true, hostname }
        : { success: false, 'error-codes': ['invalid-input-response'] },
    )
    .times(times);
}

/** 学校侧一律回 500：登录必然失败，用来判断"代码有没有走到登录那一步"。 */
function mockSchoolUnavailable(times = 1): void {
  fetchMock
    .get('https://sso.hunau.edu.cn')
    .intercept({ path: /^\/cas\/login/, method: 'GET' })
    .reply(500, '')
    .times(times);
}

async function registerClient(redirectUri = REDIRECT): Promise<string> {
  const response = await SELF.fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'guard-test', redirect_uris: [redirectUri] }),
  });
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

async function challenge(): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(VERIFIER));
  const binary = String.fromCharCode(...new Uint8Array(digest));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface AuthorizeFields {
  oaId: string;
  oaKey?: string;
  turnstile?: string;
  consent?: string;
  ip?: string;
}

async function authorize(fields: AuthorizeFields): Promise<Response> {
  const clientId = await registerClient();
  const form = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: 'st-1',
    code_challenge: await challenge(),
    code_challenge_method: 'S256',
    oa_id: fields.oaId,
    oa_key: fields.oaKey ?? 'pw-' + fields.oaId,
  });
  if (fields.turnstile !== undefined) form.set('cf-turnstile-response', fields.turnstile);
  if (fields.consent !== undefined) form.set('consent', fields.consent);

  return await SELF.fetch(`${BASE}/authorize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // 每个用例用不同 IP，免得撞上按 IP 的洪水防护
      'CF-Connecting-IP': fields.ip ?? '203.0.113.1',
    },
    body: form.toString(),
  });
}

describe('授权页：验证码是硬门槛', () => {
  it('没带验证码 → 403，而且根本不联系学校', async () => {
    const response = await authorize({ oaId: '90000001', consent: 'on', ip: '203.0.113.11' });
    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain('缺少验证码');
  });

  it('验证码校验失败 → 403', async () => {
    mockSiteverify(false);
    const response = await authorize({
      oaId: '90000002',
      turnstile: 'bogus-token',
      consent: 'on',
      ip: '203.0.113.12',
    });
    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain('验证码校验未通过');
  });

  it('验证码被搬到别的域名上解题 → 拒绝（hostname 不匹配）', async () => {
    mockSiteverify(true, 1, 'evil.example');
    const response = await authorize({
      oaId: '90000003',
      turnstile: 'ok-token',
      consent: 'on',
      ip: '203.0.113.13',
    });
    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain('域名不匹配');
  });

  it('没勾选声明 → 400，连验证码都不校验（更不会联系学校）', async () => {
    // 故意不注册 siteverify 拦截器：一旦代码去校验验证码，
    // disableNetConnect 会让它失败并返回 403，断言就会挂 —— 以此证明顺序
    const response = await authorize({
      oaId: '90000004',
      turnstile: 'ok-token',
      ip: '203.0.113.14',
    });
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('请先阅读并勾选');
  });

  it('验证码过了且勾了同意 → 才真的去登录（此时学校不可用，得到 401）', async () => {
    mockSiteverify(true);
    mockSchoolUnavailable();
    const response = await authorize({
      oaId: '90000005',
      turnstile: 'ok-token',
      consent: 'on',
      ip: '203.0.113.15',
    });
    expect(response.status).toBe(401);
  });
});



describe('动态客户端注册', () => {
  it('开放注册：放行任何合法的 https 或 localhost 回调地址', async () => {
    for (const uri of [
      'https://chatgpt.com/connector_platform_oauth_redirect',
      'https://claude.ai/api/mcp/auth_callback',
      'http://localhost:8765/callback',
      'https://custom-client.example.com/oauth/callback',
    ]) {
      const response = await SELF.fetch(`${BASE}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [uri] }),
      });
      expect(response.status, uri).toBe(201);
    }
  });

  it('拒绝非 https 的非 localhost 回调地址', async () => {
    const response = await SELF.fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://insecure.example.com/callback'] }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_redirect_uri' });
  });
});

describe('凭据指纹带密钥', () => {
  it('配了 pepper 时是 HMAC，与无盐 SHA-256 不同', async () => {
    const keyed = await credentialFingerprint('20230001', 'pw', TEST_PEPPER);
    const legacy = await credentialFingerprint('20230001', 'pw');

    expect(keyed).toMatch(/^[0-9a-f]{64}$/);
    expect(keyed).not.toBe(legacy);
  });

  it('换一把 pepper，同一个密码得到完全不同的指纹（拖库的人无法离线比对）', async () => {
    const a = await credentialFingerprint('20230001', 'pw', TEST_PEPPER);
    const b = await credentialFingerprint(
      '20230001',
      'pw',
      'YW5vdGhlci1wZXBwZXItMzItYnl0ZXMtZm9yLXRlc3RzISE=',
    );
    expect(a).not.toBe(b);
  });

  it('pepper 太短直接报错，不静默降级', async () => {
    await expect(credentialFingerprint('a', 'b', 'c2hvcnQ=')).rejects.toThrow();
  });
});

