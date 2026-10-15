/**
 * 湖南农业大学各系统地址常量。
 * 来源：ChillEast `lib/core/constants/app_constants.dart`（保持同源，便于日后对齐）。
 */

export const HOSTS = {
  sso: 'https://sso.hunau.edu.cn',
  portal: 'https://portal.hunau.edu.cn',
  xgxt: 'https://xgxt.hunau.edu.cn',
  bxpt: 'https://bxpt.hunau.edu.cn',
  sun: 'https://sun.hunau.edu.cn',
  finServ: 'https://fin-serv.hunau.edu.cn',
  ydjwxt: 'https://ydjwxt.hunau.edu.cn',
  superlib: 'https://superlib.hunau.edu.cn',
  chaoxingAuth: 'https://auth.chaoxing.com',
  chaoxingNotice: 'https://notice.chaoxing.com',
  chaoxingOffice: 'https://office.chaoxing.com',
  chaoxingMooc: 'https://mooc1-api.chaoxing.com',
} as const;

export const URLS = {
  ssoLogin: `${HOSTS.sso}/cas/login`,
  ssoMainPage: `${HOSTS.sso}/portal/main.html`,
  ssoFetchCurrentUser: `${HOSTS.sso}/portal/user/fetchCurrentUserInfo`,

  portalLogin: `${HOSTS.portal}/login`,
  portalClassroomIndex: `${HOSTS.portal}/pc/view/kxClassRoomIndex`,
  portalClassroomQuery: `${HOSTS.portal}/pc/view/refreshKxClassRoom`,

  xgxtCas: `${HOSTS.xgxt}/cas`,
  xgxtWapHome: `${HOSTS.xgxt}/wap/main/welcome`,
  xgxtQuestionnaireList: `${HOSTS.xgxt}/content/tabledata/fwk/wjdc/stu/xs_wjdc`,
  xgxtQuestionnaireDetail: `${HOSTS.xgxt}/content/json/fwk/wjdc/stu/ks_sj/sjvo`,
  xgxtQuestionnaireSubmit: `${HOSTS.xgxt}/content/fwk/wjdc/stu/ks_sj/submit`,
  xgxtLeaveApply: `${HOSTS.xgxt}/content/student/leave/apply_stu`,
  xgxtLeaveList: `${HOSTS.xgxt}/content/tabledata/student/leave/apply_stu`,
  xgxtLeaveDelete: `${HOSTS.xgxt}/content/student/leave/apply_stu/del`,
  xgxtLeaveDict: `${HOSTS.xgxt}/content/json/selects`,
  xgxtLeaveRegion: `${HOSTS.xgxt}/content/json/selects/wap/ssx`,
  xgxtLeaveCalculate: `${HOSTS.xgxt}/content/student/leave/calculate`,

  /**
   * 报修的 CAS 入口。
   *
   * ⚠️ `service` 里的 **http:// 是故意的，不能改成 https** —— 它必须与学校
   * CAS 里登记的服务地址完全一致，否则 CAS 会拒绝发票据（表现为被弹回登录页）。
   * ChillEast 客户端的 `repairsSsoUrl` 同样是 http（`app_constants.dart:104`）。
   * 跳转结果里的 http:// 由 `exchangeCasTicket` 的 `upgradeInsecureHosts` 升级，
   * 所以票据不会真的走明文。
   */
  bxptSso:
    `${HOSTS.sso}/cas/login?service=http%3A%2F%2Fbxpt.hunau.edu.cn%2Frelax%2Fsso%2Fcas%2Flogin`,
  bxptIndex: `${HOSTS.bxpt}/relax/mobile/index.html`,
  bxptRpc: `${HOSTS.bxpt}/relax/mobile/rpc`,

  /**
   * 移动教务的入口 —— **超星 OAuth**，不是 CAS。
   *
   * 取值与 `app_constants.dart:95` 的 `ydjwxtOAuthUrl` 完全一致。
   * ChillEast 的 `ydjwxt_auth_service.dart` 就是把这个 URL 丢给 WebView，
   * 再用 JS 从 localStorage 读 token。那条链本身是纯 302，
   * 所以这里用 HTTP 走一遍（同 `campus_card_service.authenticate()` 的做法）。
   */
  ydjwxtOAuthUrl:
    'https://auth.chaoxing.com/connect/oauth2/authorize?appid=ccf57937af7e40dcbdef0523e05e5ddd&redirect_uri=https%3A%2F%2Fydjwxt.hunau.edu.cn%2Fnjwhd%2Flogin%2Foauth2%3FappId%3Dccf57937af7e40dcbdef0523e05e5ddd%26appKey%3D1D13d6neUcz6c20f%26uid%3D22073114%26fidEnc%3Da915b52ee0aa18ad%26mappId%3D6127153%26formid%3D&response_type=code&scope=snsapi_base&state=128516',

  /**
   * 阳光服务的 CAS OAuth2 入口。
   *
   * ⚠️ 同上：`redirect_uri` 里的 **http:// 是故意的**，必须与 CAS 登记的
   * 回调地址一致。ChillEast 客户端的 `SunshineService.authorizationUrl` 也是 http
   * （`sunshine_service.dart:34`），随后由 `_authorize` 把跳转结果升级成 https。
   */
  sunOAuth:
    `${HOSTS.sso}/cas/oauth2.0/authorize?response_type=code&client_secret=trusfort` +
    `&client_id=yg1000002&redirect_uri=http%3A%2F%2Fsun.hunau.edu.cn%2FOAuthLogin.aspx`,

  /**
   * 一卡通财务平台（fin-serv）授权入口，口令与 `app_constants.dart` 的
   * `campusCardUrl` 完全一致（`state` 里那个 uid=22073114 是固定的应用参数，
   * 不是学号，别改）。
   *
   * 整条链是纯 302，不需要执行 JS（依据 `debug/付款码/finserv授权.har`，共 5 跳）：
   *   auth.chaoxing/connect/oauth2/authorize
   *     -> http  fin-serv/homecx/openCXOAuthPage
   *     -> https fin-serv/homecx/openCXOAuthPage
   *     -> http  fin-serv/homeCX/openHomePage?openid=…&usertype=2
   *     -> https fin-serv/homeCX/openHomePage?openid=…&usertype=2   (200)
   * openid（96 位大写 hex）出现在第 3 跳的 Location 里。
   */
  campusCardAuthorize:
    'https://auth.chaoxing.com/connect/oauth2/authorize?appid=5f1cdbd2506748a8a1d7cbe737e40d32&redirect_uri=http%3A%2F%2Ffin-serv.hunau.edu.cn%2Fhomecx%2FopenCXOAuthPage%3Furltype%3D1%26appId%3D5f1cdbd2506748a8a1d7cbe737e40d32%26appKey%3D8VT2Ov83Vv12M8ZC%26uid%3D22073114%26fidEnc%3Da915b52ee0aa18ad%26mappId%3D4556968%26formid%3Dnull&response_type=code&scope=snsapi_base&state=128516',
} as const;

/**
 * fin-serv 的 Location 全是 `http://`（见 HAR），浏览器靠 HSTS 兜底。
 * 不升级的话 `CookieJar` 会因为 `Secure` 属性拒绝回发 Cookie，整条链直接断。
 */
export const FIN_SERV_INSECURE_HOSTS = ['fin-serv.hunau.edu.cn'] as const;

/** 移动端 UA —— 学校系统按 UA 返回不同布局，移动端 UA 才能拿到 /wap 与移动接口。 */
export const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/147.0.0.0 Mobile Safari/537.36';

/** 桌面 UA —— 融合门户 / 空教室查询等 PC 页面用。 */
export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0';

/** 超星 App 内置 WebView UA（校园卡/图书馆等超星系系统要求）。 */
export const CHAOXING_UA =
  'Mozilla/5.0 (Linux; Android 16; MEIZU 20 Build/BQ2A.251110.001-BP2A.250605.031.A3; wv) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/147.0.7727.55 Mobile Safari/537.36 ' +
  '(device:MEIZU 20) Language/zh_CN com.chaoxing.mobile.hunannongyedaxue/' +
  'ChaoXingStudy_1000257_5.3_android_phone_53_234 (Kalimdor)';
