/**
 * 解析 Bearer Token：
 * 必须以 AES-GCM 解密自包含的 JWE Token，并校验有效期；
 * 拒绝任何未加密或格式不合法的明文/伪造 Token。
 */

import type { Env } from '../env';
import type { Credentials } from '../auth/session-manager';
import { getEffectiveSessionKey, open } from '../auth/crypto-box';

export interface ResolvedToken {
  credentials: Credentials;
  fingerprint: string;
}

export async function decodeTokenCredentials(env: Env, token: string): Promise<Credentials | null> {
  if (token === '') return null;
  const trimmed = token.trim();

  // 必须以 AES-GCM 解密自包含 Token
  try {
    const rawSealed = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = await open(rawSealed, getEffectiveSessionKey(env));
    const payload = JSON.parse(jsonStr) as { oaId?: unknown; oaKey?: unknown; exp?: unknown };
    if (
      typeof payload.oaId === 'string' &&
      payload.oaId !== '' &&
      typeof payload.oaKey === 'string' &&
      payload.oaKey !== ''
    ) {
      if (typeof payload.exp === 'number' && Date.now() > payload.exp) {
        return null; // 已过期
      }
      return { oaId: payload.oaId, oaKey: payload.oaKey };
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * 解析 Bearer token。
 * 格式为加密 Token 或 Base64("oaId:oaKey")，格式错误或过期返回 null。
 */
export async function resolveBearerToken(
  env: Env,
  token: string,
): Promise<ResolvedToken | null> {
  const creds = await decodeTokenCredentials(env, token);
  if (creds === null) return null;
  return {
    credentials: creds,
    fingerprint: creds.oaId,
  };
}

/**
 * 令牌本身是否有效。
 */
export async function tokenExists(env: Env, token: string): Promise<boolean> {
  return (await decodeTokenCredentials(env, token)) !== null;
}
