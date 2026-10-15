export interface Env {
  /**
   * 临时授权码加密密钥（base64 编码的 32 字节 AES-256 密钥）。
   * `wrangler secret put SESSION_KEY`。用于 /authorize 到 /token 之间无状态加密传递临时 code。
   */
  SESSION_KEY?: string;
  /**
   * 凭据指纹的 HMAC 密钥（base64，32 字节）。
   * 不设置时退化为 SHA-256，`/health` 报 `accountPepperConfigured: false`。
   */
  ACCOUNT_PEPPER?: string;
  /** 授权页验证码的公开 sitekey（渲染进 HTML，不是秘密）。 */
  TURNSTILE_SITE_KEY?: string;
  /** 验证码的服务端密钥。不设置时授权 POST **一律拒绝**（fail closed）。 */
  TURNSTILE_SECRET?: string;
  /** 授权接口的洪水防护（见 wrangler.jsonc 的 ratelimits）。 */
  LOGIN_RATE_LIMITER?: RateLimit;
}
