import { describe, expect, it } from 'vitest';
import { decodeCimsUri, parseCimsBootstrap } from '../src/auth/cims';

/**
 * 这个 fixture 按**线上真实页面**的结构写死（2026-10 实测 sso.hunau.edu.cn）：
 * host / postaction 用 `\/` 转义、formid 与 postArgument 用单引号、username 为空、
 * sig_request 形如 "XD|<base64>|<base64>"、postArgument 是 signedCimsResponse。
 * 值本身是假的，结构是真的 —— 解析器要匹配的正是这个契约（不是默认的 sig_response）。
 */
const REAL_SHAPE_PAGE = `<!DOCTYPE html>
<html>
<head><title>统一身份认证</title></head>
<body>
<form method="post" id="cims_form" class="fm-v clearfix">
  <input type="hidden" name="execution" value="exec-token-abc_XYZ"/>
  <input type="hidden" name="_eventId" value="login"/>
  <input type="hidden" name="geolocation"/>
  <input type="hidden" name="username" value="cimsUser"/>
  <input type="text" name="visibleField" value="ignored"/>
  <input type="hidden" name="disabledField" value="ignored" disabled/>
</form>
<script type="text/javascript">
  CIMS.init({
    host: "https:\\/\\/sso.hunau.edu.cn\\/authn",
    postaction: "https:\\/\\/sso.hunau.edu.cn\\/cas\\/login",
    formid: 'cims_form',
    postArgument: 'signedCimsResponse',
    sig_request: "XD|QUJDREVGRw==|MTc5MTkzODQ3Mg==:APP|QUJDREVGRw==|c2lnbmF0dXJl",
    version: 'v2',
    username: "",
    reAuthError: "false"
  });
</script>
</body>
</html>`;

const CAS_LOGIN_URL =
  'https://sso.hunau.edu.cn/cas/login?service=https%3A%2F%2Fportal.hunau.edu.cn%2Flogin';

describe('decodeCimsUri', () => {
  it('保留 reserved 转义（base64 的 %3D %2B %2F 不能被解开）', () => {
    expect(decodeCimsUri('a%3Db%2Bc%2Fd')).toBe('a%3Db%2Bc%2Fd');
  });

  it('解开普通转义', () => {
    expect(decodeCimsUri('%E5%AD%A6%E5%8F%B7')).toBe('学号');
    expect(decodeCimsUri('a%20b')).toBe('a b');
  });

  it('混合场景', () => {
    expect(decodeCimsUri('%E4%B8%AD%3D%E6%96%87')).toBe('中%3D文');
  });
});

describe('parseCimsBootstrap', () => {
  it('解析线上真实结构的配置', async () => {
    const parsed = await parseCimsBootstrap(REAL_SHAPE_PAGE, CAS_LOGIN_URL);

    expect(parsed.authBase).toBe('https://sso.hunau.edu.cn/authn/');
    expect(parsed.postUri).toBe('https://sso.hunau.edu.cn/cas/login');
    expect(parsed.signatureField).toBe('signedCimsResponse');
    // 注意：decodeCimsUri 仿的是 JS 的 decodeURI，**故意保留** %3D。
    // 所以 sign 里的 base64 填充保持百分号编码状态 —— 这与厂商 SDK 一致，
    // 后续拼 getqrcode 时再被编码一次，服务端解一次刚好还原。
    expect(parsed.sign).toBe('XD|QUJDREVGRw%3D%3D|MTc5MTkzODQ3Mg%3D%3D');
    expect(parsed.appSignature).toBe('APP|QUJDREVGRw==|c2lnbmF0dXJl');
    expect(parsed.parentUri).toBe(CAS_LOGIN_URL);
  });

  it('只收 hidden 且未 disabled 的字段', async () => {
    const parsed = await parseCimsBootstrap(REAL_SHAPE_PAGE, CAS_LOGIN_URL);
    const names = parsed.fields.map(([name]) => name);

    expect(names).toContain('execution');
    expect(names).toContain('_eventId');
    expect(names).toContain('username');
    expect(names).toContain('geolocation');
    // 非 hidden 的可见字段与 disabled 字段都不能进 CAS 表单
    expect(names).not.toContain('visibleField');
    expect(names).not.toContain('disabledField');
  });

  it('execution 必须存在', async () => {
    const withoutExecution = REAL_SHAPE_PAGE.replace(/<input type="hidden" name="execution"[^>]*>/, '');
    await expect(parseCimsBootstrap(withoutExecution, CAS_LOGIN_URL)).rejects.toThrow(/execution/);
  });

  it('从 iframe 的 parent 二次解码里取出 appUrl(service)', async () => {
    const parsed = await parseCimsBootstrap(REAL_SHAPE_PAGE, CAS_LOGIN_URL);
    expect(parsed.appUrl).toBe('https://portal.hunau.edu.cn/login');
  });

  it('iframe URL 参数与 Dart 侧手工拼装一致', async () => {
    const parsed = await parseCimsBootstrap(REAL_SHAPE_PAGE, CAS_LOGIN_URL);
    const url = new URL(parsed.iframeUri);

    expect(url.origin + url.pathname).toBe('https://sso.hunau.edu.cn/authn/login.html');
    expect(url.searchParams.get('view')).toBe('frame');
    expect(url.searchParams.get('type')).toBe('0');
    expect(url.searchParams.get('sign')).toBe('XD|QUJDREVGRw==|MTc5MTkzODQ3Mg==');
    expect(url.searchParams.get('version')).toBe('v2');
    expect(url.searchParams.get('reAuthError')).toBe('false');
  });

  it('要求二次认证时明确失败', async () => {
    const withUsername = REAL_SHAPE_PAGE.replace('username: ""', 'username: "zhangsan"');
    await expect(parseCimsBootstrap(withUsername, CAS_LOGIN_URL)).rejects.toThrow(/二次认证/);
  });

  it('不支持自定义 submit_callback 时失败', async () => {
    const withCallback = REAL_SHAPE_PAGE.replace(
      'version: \'v2\',',
      "version: 'v2',\n    submit_callback: function(){},",
    );
    await expect(parseCimsBootstrap(withCallback, CAS_LOGIN_URL)).rejects.toThrow(/自定义提交回调/);
  });

  it('缺少 CIMS.init 时失败', async () => {
    await expect(parseCimsBootstrap('<html></html>', CAS_LOGIN_URL)).rejects.toThrow(/CIMS/);
  });

  it('拒绝非预期域名的登录页（防凭据外泄）', async () => {
    await expect(
      parseCimsBootstrap(REAL_SHAPE_PAGE, 'https://evil.test/cas/login'),
    ).rejects.toThrow(/拒绝向非预期域名/);
  });

  it('拒绝 http:// 的登录页', async () => {
    await expect(
      parseCimsBootstrap(REAL_SHAPE_PAGE, 'http://sso.hunau.edu.cn/cas/login'),
    ).rejects.toThrow(/拒绝向非预期域名/);
  });

  it('host/postaction 指向别的域名时失败（SSRF 防护）', async () => {
    const poisoned = REAL_SHAPE_PAGE.replace(
      'host: "https:\\/\\/sso.hunau.edu.cn\\/authn"',
      'host: "https:\\/\\/evil.test\\/authn"',
    );
    await expect(parseCimsBootstrap(poisoned, CAS_LOGIN_URL)).rejects.toThrow(/拒绝向非预期域名/);
  });
});
