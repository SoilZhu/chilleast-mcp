import { describe, expect, it } from 'vitest';
import { URLS } from '../src/school/hunau/constants';

/**
 * CAS 入口参数契约测试：URL 里的 `http://` 看似笔误，其实是**故意的** ——
 * `service` / `redirect_uri` 必须与学校 CAS 登记值完全一致，否则拒绝发票据（症状是弹回登录页）。
 * 最初写 https 时报修与阳光服务真实换票失败过；而票据不会走明文：跳转里的 http:// 由
 * exchangeCasTicket 的 upgradeInsecureHosts 升级成 https。谁"顺手改成 https"，这里立刻失败。
 */
describe('CAS 入口参数必须与登记值一致（http:// 不能改成 https://）', () => {
  it('报修的 service 是 http://bxpt.hunau.edu.cn/relax/sso/cas/login', () => {
    const service = new URL(URLS.bxptSso).searchParams.get('service');
    expect(service).toBe('http://bxpt.hunau.edu.cn/relax/sso/cas/login');
  });

  it('阳光服务的 redirect_uri 是 http://sun.hunau.edu.cn/OAuthLogin.aspx', () => {
    const redirect = new URL(URLS.sunOAuth).searchParams.get('redirect_uri');
    expect(redirect).toBe('http://sun.hunau.edu.cn/OAuthLogin.aspx');
  });

  it('两次授权入口都指向 SSO 且带齐必要参数', () => {
    const bxpt = new URL(URLS.bxptSso);
    expect(bxpt.origin).toBe('https://sso.hunau.edu.cn');
    expect(bxpt.pathname).toBe('/cas/login');

    const sun = new URL(URLS.sunOAuth);
    expect(sun.origin).toBe('https://sso.hunau.edu.cn');
    expect(sun.pathname).toBe('/cas/oauth2.0/authorize');
    expect(sun.searchParams.get('response_type')).toBe('code');
    expect(sun.searchParams.get('client_id')).toBe('yg1000002');
    expect(sun.searchParams.get('client_secret')).toBe('trusfort');
  });

  it('接受 http 的只是这两个登记值；其它系统地址一律 https', () => {
    // 防止有人据此把全局的 http 升级逻辑整个关掉
    expect(URLS.ssoLogin.startsWith('https://')).toBe(true);
    expect(URLS.portalClassroomIndex.startsWith('https://')).toBe(true);
    expect(URLS.xgxtCas.startsWith('https://')).toBe(true);
    expect(URLS.xgxtQuestionnaireList.startsWith('https://')).toBe(true);
  });
});

describe('教务系统的入口是超星 OAuth（不是 CAS 换票）', () => {
  it('ydjwxtOAuthUrl 与 app_constants.dart 逐字节一致', async () => {
    const { URLS } = await import('../src/school/hunau/constants');
    // ChillEast 的 ydjwxt_auth_service 就是把这个 URL 交给 WebView，
    // 而这条链本身全是 302，所以服务端可以直接走。
    expect(URLS.ydjwxtOAuthUrl).toContain(
      'https://auth.chaoxing.com/connect/oauth2/authorize?appid=ccf57937af7e40dcbdef0523e05e5ddd',
    );
    expect(URLS.ydjwxtOAuthUrl).toContain(
      'redirect_uri=https%3A%2F%2Fydjwxt.hunau.edu.cn%2Fnjwhd%2Flogin%2Foauth2',
    );
    expect(URLS.ydjwxtOAuthUrl).toContain('response_type=code');
    expect(URLS.ydjwxtOAuthUrl).toContain('scope=snsapi_base');
  });

  it('能从跳转 URL 里取出 token / askToken', async () => {
    const { extractToken } = await import('../src/school/hunau/ydjwxt');
    expect(extractToken('https://ydjwxt.hunau.edu.cn/hnnydx/?token=abc.def.ghi')).toEqual({
      token: 'abc.def.ghi',
    });
    // askToken 还要再换一次（SPA 的 aksCasLogin）
    expect(extractToken('https://ydjwxt.hunau.edu.cn/hnnydx/?askToken=XYZ')).toEqual({
      askToken: 'XYZ',
    });
    expect(extractToken('https://ydjwxt.hunau.edu.cn/hnnydx/#/homeIndex')).toEqual({});
    expect(extractToken('')).toEqual({});
    expect(extractToken('https://a.test/?token=')).toEqual({});
  });

  it('能取出 hash 路由里的 token（这是实际踩到的坑）', async () => {
    const { extractToken } = await import('../src/school/hunau/ydjwxt');
    // SPA 是 hash 路由，Vue 的 $route.query 读的是 # 之后那一段。
    // 只读 searchParams 会完全漏掉，而 safePath 又会把它藏起来 —— 两者叠加
    // 导致最初只看到 "200 .../hnnydx/"，误判成"整条链没有 token"。
    expect(extractToken('https://ydjwxt.hunau.edu.cn/hnnydx/#/login?token=abcdefghij0123456789')).toEqual(
      { token: 'abcdefghij0123456789' },
    );
    expect(
      extractToken('https://ydjwxt.hunau.edu.cn/hnnydx/#/login?askToken=abcdefghij0123456789'),
    ).toEqual({ askToken: 'abcdefghij0123456789' });
    // search 与 hash 同时有参数时要能合并
    expect(
      extractToken('https://ydjwxt.hunau.edu.cn/hnnydx/?a=1#/login?token=abcdefghij0123456789'),
    ).toEqual({ token: 'abcdefghij0123456789' });
    // 普通 hash 路由不带 token
    expect(extractToken('https://ydjwxt.hunau.edu.cn/hnnydx/#/homeIndex')).toEqual({});
  });

  it('能从页面正文里取出 token（SPA 写 localStorage 的那种）', async () => {
    const { extractTokenFromBody } = await import('../src/school/hunau/ydjwxt');
    expect(
      extractTokenFromBody("try{localStorage.setItem('token','eyJhbGciOiJIUzI1NiJ9.abc.def')}catch(e){}"),
    ).toEqual({ token: 'eyJhbGciOiJIUzI1NiJ9.abc.def' });
    expect(extractTokenFromBody('{"data":{"token":"0123456789abcdef0123456789abcdef"}}')).toEqual({
      token: '0123456789abcdef0123456789abcdef',
    });
    // askToken 优先，避免与普通 token 混淆
    expect(extractTokenFromBody('{"askToken":"abcdefghij0123456789"}')).toEqual({
      askToken: 'abcdefghij0123456789',
    });
    // 太短的不要误判
    expect(extractTokenFromBody('token: "short"')).toEqual({});
    expect(extractTokenFromBody('')).toEqual({});
  });
});
