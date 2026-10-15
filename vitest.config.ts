import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// 测试跑在 workerd 里（不是 Node），这样 HTMLRewriter、TextDecoder('gbk')
// 与 WebCrypto 的行为都和线上完全一致。
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        isolatedStorage: false,
        miniflare: {
          bindings: {
            SESSION_KEY: 'dGVzdC1rZXktMzItYnl0ZXMtZm9yLXVuaXQtdGVzdHM=',
            // 测试用的指纹 HMAC 密钥（与线上那把无关）
            ACCOUNT_PEPPER: 'dGVzdC1wZXBwZXItMzItYnl0ZXMtZm9yLXVuaXQtdGVzdHM=',
            // Turnstile 的"永远通过"测试密钥。真实验证走 fetchMock 拦截，
            // 所以测试可以随意模拟成功/失败。
            TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
            TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
          },
        },
      },
    },
  },
});
