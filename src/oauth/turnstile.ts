/**
 * 授权页的验证码校验。
 *
 * 为什么必须有：`/authorize` 会拿用户提交的凭据去学校真登录一次。没有这层，
 * 它就是一个公开的校园凭据校验预言机 —— 任何人都能拿它撞库，而流量从本服务的
 * IP 出去，学校看到的是**我们在**攻击统一认证，被撞的学生可能被封号。
 *
 * 规则：未配置 `TURNSTILE_SECRET` 时一律拒绝（fail closed）；校验必须发生在
 * 调用学校接口之前；同时比对 siteverify 返回的 hostname 与本次请求的 host，
 * 防止 sitekey 被搬到别处；超时或非 200 同样按失败处理。
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** 校验接口的等待上限：不能让一个卡住的第三方拖住登录页。 */
const SITEVERIFY_TIMEOUT_MS = 5_000;

export interface TurnstileResult {
  ok: boolean;
  /** 失败原因，仅用于日志与页面提示（不含敏感信息）。 */
  reason: string;
}

interface SiteverifyResponse {
  success?: boolean;
  hostname?: string;
  'error-codes'?: string[];
}

/**
 * 校验一次验证码。
 *
 * @param secret  `TURNSTILE_SECRET`
 * @param token   表单里的 `cf-turnstile-response`
 * @param remoteIp 客户端 IP（可选，交给 Cloudflare 一起判定）
 * @param expectedHostname 本次请求的 host（比对用；传空则跳过比对）
 */
export async function verifyTurnstile(
  secret: string,
  token: string,
  remoteIp: string,
  expectedHostname: string,
): Promise<TurnstileResult> {
  if (secret === '') return { ok: false, reason: '服务端未配置验证码密钥' };
  if (token === '') return { ok: false, reason: '缺少验证码，请完成人机校验后重试' };

  let payload: SiteverifyResponse;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp !== '') body.set('remoteip', remoteIp);

    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: `验证码校验服务返回 HTTP ${response.status}` };
    payload = (await response.json()) as SiteverifyResponse;
  } catch {
    // 超时 / 网络错误 / 响应不是 JSON：一律不放行
    return { ok: false, reason: '验证码校验未能完成，请重试' };
  }

  if (payload.success !== true) {
    const codes = (payload['error-codes'] ?? []).join(',');
    return { ok: false, reason: `验证码校验未通过${codes === '' ? '' : `（${codes}）`}` };
  }
  if (
    expectedHostname !== '' &&
    typeof payload.hostname === 'string' &&
    payload.hostname.toLowerCase() !== expectedHostname.toLowerCase()
  ) {
    // sitekey 被搬到别的域名上用了
    return { ok: false, reason: '验证码来源域名不匹配' };
  }

  return { ok: true, reason: '' };
}
