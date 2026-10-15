import { env, fetchMock, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clearRegisteredClients, verifyPkce } from '../src/oauth/endpoints';
import { renderAuthorizePage } from '../src/oauth/authorize-page';
import { renderConsentPage } from '../src/oauth/consent-page';
import * as hunauLogin from '../src/auth/hunau-login';
import { CookieJar } from '../src/auth/cookies';
import {
  acquireSession,
  clearRamSessionCache,
  invalidateSession,
  ramSessionCacheSize,
  runWithSession,
} from '../src/auth/session-manager';
import { decodeTokenCredentials } from '../src/oauth/resolve';
import { getEffectiveSessionKey, seal } from '../src/auth/crypto-box';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
  clearRamSessionCache();
  clearRegisteredClients();
  vi.restoreAllMocks();
});

function mockSiteverify(success = true): void {
  fetchMock
    .get('https://challenges.cloudflare.com')
    .intercept({ path: '/turnstile/v0/siteverify', method: 'POST' })
    .reply(200, { success, hostname: 'mcp.test' });
}

const BASE = 'https://mcp.test';

/** 生成一对 PKCE 值（S256）。 */
async function makePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of verifierBytes) binary += String.fromCharCode(byte);
  const verifier = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let digestBinary = '';
  for (const byte of new Uint8Array(digest)) digestBinary += String.fromCharCode(byte);
  const challenge = btoa(digestBinary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}

describe('PKCE S256', () => {
  it('正确的 verifier 通过', async () => {
    const { verifier, challenge } = await makePkce();
    expect(await verifyPkce(verifier, challenge)).toBe(true);
  });

  it('错误的 verifier 不通过', async () => {
    const { challenge } = await makePkce();
    expect(await verifyPkce('wrong-verifier-wrong-verifier', challenge)).toBe(false);
  });

  it('空值一律不通过', async () => {
    expect(await verifyPkce('', 'abc')).toBe(false);
    expect(await verifyPkce('abc', '')).toBe(false);
  });

  it('长度不同也不通过（且不抛错）', async () => {
    const { verifier } = await makePkce();
    expect(await verifyPkce(verifier, 'short')).toBe(false);
  });
});

describe('OAuth 元数据发现', () => {
  it('资源元数据指向自身作为授权服务器', async () => {
    const response = await SELF.fetch(`${BASE}/.well-known/oauth-protected-resource`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['resource']).toBe(BASE);
    expect(body['authorization_servers']).toEqual([BASE]);
  });

  it('带 /mcp 后缀的路径也能取到（有的客户端会拼）', async () => {
    const response = await SELF.fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
  });

  it('授权服务器元数据齐全（ChatGPT 与 Gemini 都靠它）', async () => {
    const response = await SELF.fetch(`${BASE}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body['issuer']).toBe(BASE);
    expect(body['authorization_endpoint']).toBe(`${BASE}/authorize`);
    expect(body['token_endpoint']).toBe(`${BASE}/token`);
    // 动态客户端注册：ChatGPT 在你不填 client_id 时就走这条
    expect(body['registration_endpoint']).toBe(`${BASE}/register`);
    expect(body['response_types_supported']).toContain('code');
    expect(body['grant_types_supported']).toContain('authorization_code');
    expect(body['grant_types_supported']).toContain('refresh_token');
    // PKCE 必须声明 S256
    expect(body['code_challenge_methods_supported']).toContain('S256');
    // 公开客户端（无 secret）
    expect(body['token_endpoint_auth_methods_supported']).toContain('none');
  });
});

describe('动态客户端注册', () => {
  it('注册成功返回 client_id 且回显 redirect_uris', async () => {
    const response = await SELF.fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT',
        redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body['client_id']).toBe('string');
    expect(body['token_endpoint_auth_method']).toBe('none');
    expect(body['redirect_uris']).toEqual(['https://chatgpt.com/connector_platform_oauth_redirect']);
  });

  it('缺少 redirect_uris 时拒绝', async () => {
    const response = await SELF.fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'x' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toBe('invalid_redirect_uri');
  });

  it('拒绝非 https 的 redirect_uri（localhost 除外）', async () => {
    const bad = await SELF.fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://evil.test/cb'] }),
    });
    expect(bad.status).toBe(400);

    const localhost = await SELF.fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://localhost:3000/cb'] }),
    });
    expect(localhost.status).toBe(201);
  });
});

describe('授权端点', () => {
  async function registerClient(redirectUri: string): Promise<string> {
    const response = await SELF.fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'test', redirect_uris: [redirectUri] }),
    });
    const body = (await response.json()) as { client_id: string };
    return body.client_id;
  }

  it('参数齐全时渲染登录表单（含全部 hidden 参数）', async () => {
    const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
    const clientId = await registerClient(redirectUri);
    const { challenge } = await makePkce();

    const url = new URL(`${BASE}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', 'xyz-state');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    const response = await SELF.fetch(url.toString());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const html = await response.text();
    expect(html).toContain('name="oa_id"');
    expect(html).toContain('name="oa_key"');
    expect(html).toContain('type="password"');
    // 参数必须透传，否则 POST 回来就丢了
    expect(html).toContain(`value="${clientId}"`);
    expect(html).toContain('value="xyz-state"');
  });

  it('redirect_uri 与注册值不符时直接报错，绝不重定向', async () => {
    const clientId = await registerClient('https://chatgpt.com/connector_platform_oauth_redirect');
    const { challenge } = await makePkce();

    const url = new URL(`${BASE}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', 'https://attacker.test/steal');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    const response = await SELF.fetch(url.toString());
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toBe('invalid_request');
  });

  it('缺少 PKCE 或 method 不是 S256 时拒绝', async () => {
    const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
    const clientId = await registerClient(redirectUri);

    const noPkce = new URL(`${BASE}/authorize`);
    noPkce.searchParams.set('response_type', 'code');
    noPkce.searchParams.set('client_id', clientId);
    noPkce.searchParams.set('redirect_uri', redirectUri);
    expect((await SELF.fetch(noPkce.toString())).status).toBe(400);

    const plain = new URL(`${BASE}/authorize`);
    plain.searchParams.set('response_type', 'code');
    plain.searchParams.set('client_id', clientId);
    plain.searchParams.set('redirect_uri', redirectUri);
    plain.searchParams.set('code_challenge', 'abc');
    plain.searchParams.set('code_challenge_method', 'plain');
    expect((await SELF.fetch(plain.toString())).status).toBe(400);
  });

  it('未注册的 client_id 被拒绝', async () => {
    const url = new URL(`${BASE}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', 'not-registered');
    url.searchParams.set('redirect_uri', 'https://chatgpt.com/connector_platform_oauth_redirect');
    url.searchParams.set('code_challenge', 'abc');
    url.searchParams.set('code_challenge_method', 'S256');
    expect((await SELF.fetch(url.toString())).status).toBe(400);
  });

  it('自包含加密 client_id：即使内存注册表被清空，跨实例依然可通过授权校验', async () => {
    const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
    const clientId = await registerClient(redirectUri);
    const { challenge } = await makePkce();

    // 模拟跨边缘节点 / 实例冷启动：清空内存注册表
    clearRegisteredClients();

    const url = new URL(`${BASE}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', 'xyz-state');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    const response = await SELF.fetch(url.toString());
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`value="${clientId}"`);
  });

  it('未动态注册的 UUID client_id 被拒绝', async () => {
    const dummyUuid = crypto.randomUUID();
    const { challenge } = await makePkce();
    const url = new URL(`${BASE}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', dummyUuid);
    url.searchParams.set('redirect_uri', 'https://client.example.com/oauth/callback');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    const response = await SELF.fetch(url.toString());
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toBe('invalid_client');
  });
});

describe('登录页（PC 样式）', () => {
  it('左半屏品牌区 + 右半屏 Material 输入框与按钮', async () => {
    const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
    const registered = await SELF.fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'page-test', redirect_uris: [redirectUri] }),
    });
    const { client_id: clientId } = (await registered.json()) as { client_id: string };
    const { challenge } = await makePkce();

    const url = new URL(`${BASE}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', 'xyz-state');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    const html = await (await SELF.fetch(url.toString())).text();

    // 品牌区：标语 + 两层纹样（绿环瓦片 + 蓝环那条"河"），都是内联 SVG，少一次请求
    expect(html).toContain('东湖事');
    expect(html).toContain('自在事');
    expect((html.match(/url\("data:image\/svg\+xml/g) ?? []).length).toBe(2);

    // 输入框：Material 外框式，标签压在边框上（label 必须在 input 之后，样式靠 + 选择器）
    expect(html).toContain('name="oa_id"');
    expect(html).toContain('<label for="oa_id">账号</label>');
    expect(html).toContain('<label for="oa_key">密码</label>');
    expect(html).toContain('type="submit">登录</button>');
  });

  it('参数与错误信息一律转义（登录页是最容易被塞 XSS 的地方）', () => {
    const html = renderAuthorizePage(
      [['state', '"><script>alert(1)</script>']],
      '2023<img src=x>',
      '密码错误 <b>bold</b>',
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;b&gt;');
    // 报错要能被读屏软件念出来
    expect(html).toContain('role="alert"');
  });
});

describe('令牌端点', () => {
  it('无效授权码返回 invalid_grant', async () => {
    const response = await SELF.fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'not-a-real-code',
        code_verifier: 'whatever',
        client_id: 'x',
      }).toString(),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toBe('invalid_grant');
  });

  it('无效 refresh_token 返回 invalid_grant', async () => {
    const response = await SELF.fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'not-a-real-token',
      }).toString(),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toBe('invalid_grant');
  });

  it('不支持的 grant_type 明确报错', async () => {
    const response = await SELF.fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toBe('unsupported_grant_type');
  });

  it('也接受 JSON 形式的请求体', async () => {
    const response = await SELF.fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code: 'nope', code_verifier: 'v' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toBe('invalid_grant');
  });
});

describe('MCP 端点的授权挑战', () => {
  it('无凭据时 401 且带 WWW-Authenticate 指向资源元数据', async () => {
    const response = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);

    // 这个头是 OAuth 客户端发现授权服务器的入口，少了它 ChatGPT 连不上
    const challenge = response.headers.get('WWW-Authenticate') ?? '';
    expect(challenge).toContain('Bearer');
    expect(challenge).toContain('/.well-known/oauth-protected-resource');
  });

  it('无效的 Bearer token 同样回 401 挑战', async () => {
    const response = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer totally-invalid-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });

  it('拒绝 Bearer base64("学号:密码")，仅接受合法加密的 Bearer Token', async () => {
    const response = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${btoa('20230001:secret')}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(response.status).toBe(401);

    const validToken = await seal(
      JSON.stringify({ oaId: '20230001', oaKey: 'secret', exp: Date.now() + 60000 }),
      getEffectiveSessionKey(env),
    );
    const successRes = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${validToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(successRes.status).toBe(200);
  });

  it('/health 列出两种接入方式', async () => {
    const response = await SELF.fetch(`${BASE}/health`);
    const body = (await response.json()) as { auth: Record<string, unknown> };
    expect(body.auth['oauth']).toBeDefined();
    expect(body.auth['headers']).toBeDefined();
  });
});

describe('登录页与授权确认页共用同一套外观', () => {
  const siteKey = '1x00000000000000000000AA';

  it('两页都有品牌区（圆环纹样 + 标语）和规范视觉结构', () => {
    const login = renderAuthorizePage([['response_type', 'code']], '', null, siteKey);
    const consent = renderConsentPage({
      clientName: 'ChatGPT',
      redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      oaId: '20230001',
      consentTicket: 'test-ticket',
    });

    for (const html of [login, consent]) {
      // 外壳：左右分栏 + 左半屏品牌区
      expect(html).toContain('class="page"');
      expect(html).toContain('class="brand"');
      expect(html).toContain('rings--river');
      expect(html).toContain('东湖事');
      expect(html).toContain('--brand-bg: #034933');
      expect(html).toContain('class="form-col"');
    }
  });

  it('登录按钮是主色，授权确认页有同意授权与取消两个按钮', () => {
    const login = renderAuthorizePage([], '', null, siteKey);
    const consent = renderConsentPage({
      clientName: 'ChatGPT',
      redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      oaId: '20230001',
      consentTicket: 'test-ticket',
    });

    expect(login).toContain('<div class="actions"><button type="submit">登录</button></div>');
    expect(consent).toContain('允许</button>');
    expect(consent).toContain('class="btn-secondary">取消</button>');
  });

  it('授权确认页展示目标域名，且文本被转义', () => {
    const consent = renderConsentPage({
      clientName: '<script>alert(1)</script>',
      redirectUri: 'https://evil.example.com/steal',
      oaId: '20230001',
      consentTicket: 'test-ticket',
    });
    expect(consent).toContain('evil.example.com');
    expect(consent).not.toContain('<script>alert(1)</script>');
    expect(consent).toContain('&lt;script&gt;');
  });
});

describe('隐私与数据处理说明', () => {
  const siteKey = '1x00000000000000000000AA';

  it('是折叠块，默认收起，标题带展开/收起提示', () => {
    const html = renderAuthorizePage([], '', null, siteKey);
    expect(html).toContain('<details class="accordion">');
    // 没有 open 属性 = 默认收起
    expect(html).not.toContain('<details class="accordion" open>');
    expect(html).toContain('隐私与数据处理说明');
    expect(html).toContain('>展开<');
    expect(html).toContain('>收起<');
  });

  it('文案简洁且明确告知纯无状态与加密令牌', () => {
    const html = renderAuthorizePage([], '', null, siteKey);
    expect(html).toContain('本服务不以任何方式持久化记录或储存您的用户名与密码');
    expect(html).toContain('由客户端储存');
    expect(html).toContain('在客户端中删除连接器即可');
  });

  it('勾选行指向说明，且服务端也校验', async () => {
    const html = renderAuthorizePage([], '', null, siteKey);
    expect(html).toContain('name="consent"');
    expect(html).toContain('我已阅读并同意下方的隐私与数据处理说明');
  });
});

describe('登录页与确认页的标题与居中', () => {
  const siteKey = '1x00000000000000000000AA';

  it('登录页标题是「登录「自在东湖」MCP 服务」', () => {
    const html = renderAuthorizePage([], '', null, siteKey);
    expect(html).toContain('<h1 class="title">登录「自在东湖」MCP 服务</h1>');
  });

  it('两页都启用严格居中', () => {
    const login = renderAuthorizePage([], '', null, siteKey);
    const consent = renderConsentPage({
      clientName: 'ChatGPT',
      redirectUri: 'https://chatgpt.com/callback',
      oaId: '20230001',
      consentTicket: 'test-ticket',
    });

    expect(login).toContain('<div class="panel panel--centered">');
    expect(consent).toContain('<div class="panel panel--centered">');
    expect(login).toContain('<div class="main">');
    expect(consent).toContain('<div class="main">');
  });
});

describe('桌面端左半屏固定', () => {
  const siteKey = '1x00000000000000000000AA';

  it('两个页面都用 fixed 钉住品牌区（共用外壳，一处生效即两处生效）', () => {
    for (const html of [
      renderAuthorizePage([], '', null, siteKey),
      renderConsentPage({
        clientName: 'ChatGPT',
        redirectUri: 'https://chatgpt.com/callback',
        oaId: '20230001',
        consentTicket: 'test-ticket',
      }),
    ]) {
      expect(html).toContain('@media (min-width: 881px)');
      expect(html).toContain('.brand { position: fixed; inset: 0 auto 0 0; width: 50%; }');
      expect(html).toContain('.panel { grid-column: 2; }');
    }
  });

  it('不用 sticky：粘性定位的活动范围受网格行限制，而说明块是绝对定位的，网格行不会变高', () => {
    const html = renderAuthorizePage([], '', null, siteKey);
    expect(html).not.toContain('position: sticky');
  });
});

describe('授权确认页（Consent Screen）的结构', () => {
  it('展示标题、域名标识与操作按钮', () => {
    const html = renderConsentPage({
      clientName: 'ChatGPT',
      redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      oaId: '20230001',
      consentTicket: 'test-ticket-xyz',
    });
    expect(html).toContain('consent-title');
    expect(html).toContain('想要访问您的校园账号');
    expect(html).toContain('ChatGPT');
    expect(html).toContain('chatgpt.com');
    expect(html).toContain('name="consent_ticket" value="test-ticket-xyz"');
    expect(html).toContain('name="decision" value="approve"');
    expect(html).toContain('name="decision" value="cancel"');
  });
});

describe('无状态 OAuth 2.0 流程与加密 JWE Bearer 令牌', () => {
  const TEST_OA_ID = '20230001';
  const TEST_OA_KEY = 'mypassword123';
  const REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect';

  it('走完整两步式 OAuth 2.0 流程：经过验证与确认后，返回加密的 JWE access_token', async () => {
    // 1. 动态客户端注册
    const regRes = await SELF.fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT',
        redirect_uris: [REDIRECT_URI],
      }),
    });
    expect(regRes.status).toBe(201);
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };

    // 2. PKCE 生成
    const { verifier, challenge } = await makePkce();

    // 3. 用户在 /authorize 提交账号密码
    mockSiteverify(true);
    const loginSpy = vi.spyOn(hunauLogin, 'login').mockResolvedValue({
      jar: new CookieJar(),
      identity: { username: TEST_OA_ID, realName: '张三' },
      requestCount: 7,
      elapsedMs: 100,
    });

    const authForm = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: 'my-state-123',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      oa_id: TEST_OA_ID,
      oa_key: TEST_OA_KEY,
      consent: 'on',
      'cf-turnstile-response': 'valid-turnstile-token',
    });

    const authRes = await SELF.fetch(`${BASE}/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: authForm.toString(),
      redirect: 'manual',
    });

    // 确保调用了学校 SSO 验证
    expect(loginSpy).toHaveBeenCalledWith(TEST_OA_ID, TEST_OA_KEY);

    // 阶段一验证成功：返回 200 并渲染 Consent 确认屏
    expect(authRes.status).toBe(200);
    const consentHtml = await authRes.text();
    expect(consentHtml).toContain('想要访问您的校园账号');
    expect(consentHtml).toContain('chatgpt.com');
    expect(consentHtml).toContain('name="consent_ticket"');

    // 提取 consent_ticket
    const match = /name="consent_ticket"\s+value="([^"]+)"/.exec(consentHtml);
    expect(match).not.toBeNull();
    const consentTicket = match![1];

    // 阶段二：用户确认授权
    const confirmForm = new URLSearchParams({
      action: 'consent',
      decision: 'approve',
      consent_ticket: consentTicket,
    });

    const confirmRes = await SELF.fetch(`${BASE}/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: confirmForm.toString(),
      redirect: 'manual',
    });

    expect(confirmRes.status).toBe(302);
    const location = confirmRes.headers.get('Location') ?? '';
    expect(location).toContain(REDIRECT_URI);

    const redirectUrl = new URL(location);
    expect(redirectUrl.searchParams.get('state')).toBe('my-state-123');
    const code = redirectUrl.searchParams.get('code');
    expect(typeof code).toBe('string');
    expect(code!.length).toBeGreaterThan(10);

    // 4. 客户端用 code + code_verifier 请求 POST /token 换取令牌
    const tokenRes = await SELF.fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
      }).toString(),
    });

    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
    };

    expect(tokenBody.token_type).toBe('Bearer');
    expect(tokenBody.expires_in).toBe(365 * 24 * 3600);
    // 关键核心验证：返回的 bearer 必须是加密密文，绝不是明文 base64("学号:密码")
    const plainBearer = btoa(`${TEST_OA_ID}:${TEST_OA_KEY}`);
    expect(tokenBody.access_token).not.toBe(plainBearer);

    // 能被安全解密验证
    const decodedCreds = await decodeTokenCredentials(env, tokenBody.access_token);
    expect(decodedCreds).toEqual({ oaId: TEST_OA_ID, oaKey: TEST_OA_KEY });

    // 5. 校验该 Bearer Token 能够成功访问 /mcp 端点
    const mcpRes = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenBody.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
      }),
    });

    expect(mcpRes.status).toBe(200);
    const mcpBody = (await mcpRes.json()) as { jsonrpc: string; id: number; result: unknown };
    expect(mcpBody.jsonrpc).toBe('2.0');
    expect(mcpBody.id).toBe(1);
  });

  it('用户在确认页点击取消时，返回 302 附带 access_denied 错误', async () => {
    const regRes = await SELF.fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT',
        redirect_uris: [REDIRECT_URI],
      }),
    });
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };
    const { challenge } = await makePkce();

    mockSiteverify(true);
    vi.spyOn(hunauLogin, 'login').mockResolvedValue({
      jar: new CookieJar(),
      identity: { username: TEST_OA_ID, realName: '张三' },
      requestCount: 7,
      elapsedMs: 100,
    });

    const authForm = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: 'my-state-cancel',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      oa_id: TEST_OA_ID,
      oa_key: TEST_OA_KEY,
      consent: 'on',
      'cf-turnstile-response': 'valid-turnstile-token',
    });

    const authRes = await SELF.fetch(`${BASE}/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: authForm.toString(),
      redirect: 'manual',
    });
    expect(authRes.status).toBe(200);
    const html = await authRes.text();
    const consentTicket = /name="consent_ticket"\s+value="([^"]+)"/.exec(html)![1];

    // 用户点击取消
    const cancelRes = await SELF.fetch(`${BASE}/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'consent',
        decision: 'cancel',
        consent_ticket: consentTicket,
      }).toString(),
      redirect: 'manual',
    });

    expect(cancelRes.status).toBe(302);
    const loc = new URL(cancelRes.headers.get('Location')!);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('my-state-cancel');
  });

  it('密码错误时，/authorize 回显错误提示且不发放 code', async () => {
    const regRes = await SELF.fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT',
        redirect_uris: [REDIRECT_URI],
      }),
    });
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };
    const { challenge } = await makePkce();

    mockSiteverify(true);
    vi.spyOn(hunauLogin, 'login').mockRejectedValue(new hunauLogin.LoginError('账号或密码错误'));

    const authForm = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: 'my-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      oa_id: TEST_OA_ID,
      oa_key: 'wrong-password',
      consent: 'on',
      'cf-turnstile-response': 'valid-turnstile-token',
    });

    const res = await SELF.fetch(`${BASE}/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: authForm.toString(),
      redirect: 'manual',
    });

    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).toContain('账号或密码错误');
  });

  it('decodeTokenCredentials 严格要求 AES-GCM 加密，彻底拒绝裸 Base64 与畸形令牌', async () => {
    const raw = `${TEST_OA_ID}:${TEST_OA_KEY}`;
    const rawBase64 = btoa(raw);

    // 裸 Base64 凭据必须被拒绝
    expect(await decodeTokenCredentials(env, rawBase64)).toBeNull();
    expect(await decodeTokenCredentials(env, 'invalid-base64')).toBeNull();
    expect(await decodeTokenCredentials(env, btoa('no-separator'))).toBeNull();
    expect(await decodeTokenCredentials(env, '')).toBeNull();

    // 只有经过 SESSION_KEY AES-GCM 加密的合法 Token 才能解出凭据
    const validToken = await seal(
      JSON.stringify({ oaId: TEST_OA_ID, oaKey: TEST_OA_KEY, exp: Date.now() + 60000 }),
      getEffectiveSessionKey(env),
    );
    expect(await decodeTokenCredentials(env, validToken)).toEqual({
      oaId: TEST_OA_ID,
      oaKey: TEST_OA_KEY,
    });

    // 已过期的加密 Token 返回 null
    const expiredToken = await seal(
      JSON.stringify({ oaId: TEST_OA_ID, oaKey: TEST_OA_KEY, exp: Date.now() - 1000 }),
      getEffectiveSessionKey(env),
    );
    expect(await decodeTokenCredentials(env, expiredToken)).toBeNull();
  });
});

describe('内存 RAM 会话防抖缓存机制', () => {
  const TEST_OA_ID = '20230001';
  const TEST_OA_KEY = 'mypassword123';

  it('首次调用走 SSO 登录，后续并发/连续调用直接复用内存 Cookie', async () => {
    const loginSpy = vi.spyOn(hunauLogin, 'login').mockResolvedValue({
      jar: new CookieJar(),
      identity: { username: TEST_OA_ID, realName: '张三' },
      requestCount: 7,
      elapsedMs: 100,
    });

    expect(ramSessionCacheSize()).toBe(0);

    // 第 1 次调用：触发真实 SSO 登录
    const session1 = await acquireSession(env, { oaId: TEST_OA_ID, oaKey: TEST_OA_KEY });
    expect(session1.didLogin).toBe(true);
    expect(loginSpy).toHaveBeenCalledTimes(1);
    expect(ramSessionCacheSize()).toBe(1);

    // 第 2 次调用：直接命中内存缓存，无需再次打学校 SSO（不消耗网络请求，防止风控）
    const session2 = await acquireSession(env, { oaId: TEST_OA_ID, oaKey: TEST_OA_KEY });
    expect(session2.didLogin).toBe(false);
    expect(session2.identity?.realName).toBe('张三');
    expect(loginSpy).toHaveBeenCalledTimes(1);
  });

  it('会话失效时触发 invalidateSession，下一次调用重新走 SSO', async () => {
    const loginSpy = vi.spyOn(hunauLogin, 'login').mockResolvedValue({
      jar: new CookieJar(),
      identity: { username: TEST_OA_ID, realName: '张三' },
      requestCount: 7,
      elapsedMs: 100,
    });
    const creds = { oaId: TEST_OA_ID, oaKey: TEST_OA_KEY };

    const first = await acquireSession(env, creds);
    expect(first.didLogin).toBe(true);
    expect(loginSpy).toHaveBeenCalledTimes(1);

    // 模拟会话失效
    await invalidateSession(env, creds);
    expect(ramSessionCacheSize()).toBe(0);

    // 重新发起学校 SSO
    const second = await acquireSession(env, creds);
    expect(second.didLogin).toBe(true);
    expect(loginSpy).toHaveBeenCalledTimes(2);
  });

  it('runWithSession 在内存中执行并支持自动持久化新 Cookie', async () => {
    vi.spyOn(hunauLogin, 'login').mockResolvedValue({
      jar: new CookieJar(),
      identity: { username: TEST_OA_ID, realName: '张三' },
      requestCount: 7,
      elapsedMs: 100,
    });
    const creds = { oaId: TEST_OA_ID, oaKey: TEST_OA_KEY };

    const result = await runWithSession(env, creds, async (ctx) => {
      // 模拟工具调用期间写入新的子系统 Cookie
      ctx.session.jar.absorb('https://jwxt.hunau.edu.cn', ['subsystem_token=abc123xyz; Path=/']);
      return { ok: true, name: ctx.identity?.realName };
    });

    expect(result.ok).toBe(true);
    expect(result.name).toBe('张三');

    // 再次获取，内存里的 CookieJar 包含新加的 Cookie
    const next = await acquireSession(env, creds);
    expect(next.didLogin).toBe(false);
    expect(next.session.jar.getCookieHeader('https://jwxt.hunau.edu.cn')).toContain(
      'subsystem_token=abc123xyz',
    );
  });
});
