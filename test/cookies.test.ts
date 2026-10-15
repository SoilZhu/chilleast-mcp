import { describe, expect, it } from 'vitest';
import { CookieJar, parseSetCookie } from '../src/auth/cookies';

describe('parseSetCookie', () => {
  it('没有 Domain 属性时是 host-only', () => {
    const cookie = parseSetCookie('TGC=abc; Path=/cas; Secure; HttpOnly', 'https://sso.hunau.edu.cn/cas/login');
    expect(cookie).not.toBeNull();
    expect(cookie!.hostOnly).toBe(true);
    expect(cookie!.domain).toBe('sso.hunau.edu.cn');
    expect(cookie!.path).toBe('/cas');
    expect(cookie!.secure).toBe(true);
    expect(cookie!.httpOnly).toBe(true);
  });

  it('解析 Domain 属性并去掉前导点', () => {
    const cookie = parseSetCookie('UID=42; Domain=.chaoxing.com; Path=/', 'https://passport2-api.chaoxing.com/api/v2/login6');
    expect(cookie!.hostOnly).toBe(false);
    expect(cookie!.domain).toBe('chaoxing.com');
  });

  it('Max-Age 换算成绝对过期时间', () => {
    const before = Math.floor(Date.now() / 1000);
    const cookie = parseSetCookie('a=b; Max-Age=60', 'https://x.test/');
    expect(cookie!.expires).toBeGreaterThanOrEqual(before + 59);
  });

  it('Max-Age=0 立即过期', () => {
    const cookie = parseSetCookie('a=b; Max-Age=0', 'https://x.test/');
    expect(cookie!.expires).toBe(0);
  });

  it('Domain 与响应 host 不匹配时抛错', () => {
    expect(() => parseSetCookie('a=b; Domain=evil.test', 'https://sso.hunau.edu.cn/')).toThrow();
  });
});

describe('CookieJar 作用域', () => {
  it('host-only Cookie 绝不外泄到同类域名（登录安全模型的关键）', () => {
    const jar = new CookieJar();
    jar.absorb('https://portal.hunau.edu.cn/login', ['FUSION=secret; Path=/']);

    expect(jar.getCookieHeader('https://portal.hunau.edu.cn/index')).toContain('FUSION=secret');
    // 兄弟域与父域都不能拿到
    expect(jar.getCookieHeader('https://sso.hunau.edu.cn/')).toBeNull();
    expect(jar.getCookieHeader('https://hunau.edu.cn/')).toBeNull();
    expect(jar.getCookieHeader('https://evil-portal.hunau.edu.cn/')).toBeNull();
  });

  it('带 Domain 的 Cookie 可以下发到子域', () => {
    const jar = new CookieJar();
    jar.absorb('https://passport2-api.chaoxing.com/api/v2/login6', [
      'UID=42; Domain=.chaoxing.com; Path=/',
    ]);

    expect(jar.getCookieHeader('https://notice.chaoxing.com/pc/notice/x')).toContain('UID=42');
    expect(jar.getCookieHeader('https://office.chaoxing.com/front/x')).toContain('UID=42');
    // 后缀相似但不是子域，不能下发
    expect(jar.getCookieHeader('https://notchaoxing.com/')).toBeNull();
  });

  it('遵守 Path 作用域', () => {
    const jar = new CookieJar();
    jar.absorb('https://sso.hunau.edu.cn/cas/login', ['TGC=x; Path=/cas']);
    jar.absorb('https://sso.hunau.edu.cn/authn/login.html', ['AUTHN=y; Path=/authn']);

    const loginHeader = jar.getCookieHeader('https://sso.hunau.edu.cn/cas/login');
    expect(loginHeader).toContain('TGC=x');
    expect(loginHeader).not.toContain('AUTHN');

    const authnHeader = jar.getCookieHeader('https://sso.hunau.edu.cn/authn/api/verify/getqrcode');
    expect(authnHeader).toContain('AUTHN=y');
    expect(authnHeader).not.toContain('TGC');
  });

  it('Secure Cookie 不会走明文 HTTP', () => {
    const jar = new CookieJar();
    jar.absorb('https://sso.hunau.edu.cn/', ['S=1; Secure; Path=/']);
    expect(jar.getCookieHeader('https://sso.hunau.edu.cn/')).toContain('S=1');
    expect(jar.getCookieHeader('http://sso.hunau.edu.cn/')).toBeNull();
  });

  it('同名 Cookie 按 (name, domain, path) 覆盖而不是叠加', () => {
    const jar = new CookieJar();
    jar.absorb('https://a.test/', ['k=1; Path=/']);
    jar.absorb('https://a.test/', ['k=2; Path=/']);
    expect(jar.size).toBe(1);
    expect(jar.getCookieHeader('https://a.test/')).toBe('k=2');
  });

  it('过期 Cookie 在匹配时被忽略', () => {
    const jar = new CookieJar();
    jar.put({
      name: 'old',
      value: 'x',
      domain: 'a.test',
      path: '/',
      hostOnly: true,
      expires: Math.floor(Date.now() / 1000) - 10,
      secure: false,
      httpOnly: false,
    });
    expect(jar.getCookieHeader('https://a.test/')).toBeNull();
  });

  it('多 Cookie 按路径长度降序排列', () => {
    const jar = new CookieJar();
    jar.absorb('https://a.test/', ['root=1; Path=/']);
    jar.absorb('https://a.test/deep/page', ['deep=2; Path=/deep']);
    expect(jar.getCookieHeader('https://a.test/deep/page')).toBe('deep=2; root=1');
  });

  it('序列化往返后语义不变', () => {
    const jar = new CookieJar();
    jar.absorb('https://a.test/', ['x=1; Path=/']);
    jar.absorb('https://b.test/', ['y=2; Path=/; Secure']);
    const restored = CookieJar.fromJSON(jar.toJSON());
    expect(restored.size).toBe(2);
    expect(restored.getCookieHeader('https://a.test/')).toBe('x=1');
    expect(restored.getCookieHeader('https://b.test/')).toBe('y=2');
  });
});
