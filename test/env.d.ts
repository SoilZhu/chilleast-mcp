/// <reference types="@cloudflare/vitest-pool-workers" />

import type { Env } from '../src/env';

// 让 `env` (来自 cloudflare:test) 带上 wrangler.jsonc 里声明的绑定类型
declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}
