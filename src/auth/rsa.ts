/**
 * RSA PKCS#1 v1.5 加密（用于 CIMS 统一认证的密码加密）。
 *
 * 为什么不用 WebCrypto：
 *   workerd 的 crypto.subtle 只支持 RSA-OAEP / RSASSA-PKCS1-v1_5，
 *   **不支持** RSAES-PKCS1-v1_5（已实测：generateKey 直接抛
 *   NotSupportedError: Unrecognized key generation algorithm "RSAES-PKCS1-v1_5"）。
 *   而学校认证接口要求的就是 PKCS#1 v1.5，所以这里用 BigInt 自己实现。
 *   2048 位密钥的模幂在 Worker 里只需几毫秒。
 */

import {
  b64ToBytes,
  bigIntToBytes,
  bytesToB64,
  bytesToBigInt,
  stripPem,
} from '../util/bytes';

export interface RsaPublicKey {
  /** modulus */
  n: bigint;
  /** public exponent */
  e: bigint;
  /** 模长（字节），用于定长输出 */
  size: number;
}

/** 极简 DER 读取器：只处理 RSA 公钥需要的 SEQUENCE / INTEGER / BIT STRING。 */
class DerReader {
  private offset = 0;
  constructor(private readonly buf: Uint8Array) {}

  get pos(): number {
    return this.offset;
  }

  peekTag(): number {
    if (this.offset >= this.buf.length) throw new Error('DER: unexpected end of input');
    return this.buf[this.offset];
  }

  private readLength(): number {
    let len = this.buf[this.offset++];
    if (len === undefined) throw new Error('DER: truncated length');
    if (len & 0x80) {
      const byteCount = len & 0x7f;
      if (byteCount === 0 || byteCount > 4) throw new Error('DER: unsupported length form');
      len = 0;
      for (let i = 0; i < byteCount; i++) {
        const b = this.buf[this.offset++];
        if (b === undefined) throw new Error('DER: truncated long length');
        len = (len << 8) | b;
      }
    }
    return len;
  }

  /** 断言并消费一个 tag，返回其内容长度。 */
  enter(expectedTag: number): number {
    const tag = this.buf[this.offset++];
    if (tag !== expectedTag) {
      throw new Error(
        `DER: expected tag 0x${expectedTag.toString(16)}, got 0x${(tag ?? 0).toString(16)}`,
      );
    }
    return this.readLength();
  }

  /** 读取一个 INTEGER，返回其大端内容（去掉 DER 的符号前导 0x00）。 */
  readInteger(): bigint {
    const len = this.enter(0x02);
    let bytes = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    if (bytes.length > 1 && bytes[0] === 0x00) bytes = bytes.subarray(1);
    return bytesToBigInt(bytes);
  }

  /** 跳过 n 个字节。 */
  skip(n: number): void {
    this.offset += n;
  }
}

/**
 * 解析 RSA 公钥，同时支持：
 *   - SubjectPublicKeyInfo（`-----BEGIN PUBLIC KEY-----`，含 AlgorithmIdentifier）
 *   - PKCS#1 RSAPublicKey（`-----BEGIN RSA PUBLIC KEY-----`，裸 SEQUENCE{INTEGER,INTEGER}）
 *   - 无 PEM 头的裸 DER base64（学校接口返回的就是这种）
 *
 * 结构判别而不是按标签猜：SPKI 的 SEQUENCE 首个子元素是 SEQUENCE，
 * PKCS#1 的首个子元素是 INTEGER。
 */
export function parseRsaPublicKey(input: string): RsaPublicKey {
  const der = b64ToBytes(input);
  const reader = new DerReader(der);

  reader.enter(0x30); // 外层 SEQUENCE

  if (reader.peekTag() === 0x30) {
    // SubjectPublicKeyInfo: SEQUENCE { AlgorithmIdentifier, BIT STRING }
    const algLen = reader.enter(0x30);
    reader.skip(algLen);
    const bitStringLen = reader.enter(0x03);
    reader.skip(1); // BIT STRING 首字节是 "unused bits"
    void bitStringLen;
    // BIT STRING 内是完整的 PKCS#1 RSAPublicKey
    reader.enter(0x30);
  }

  const n = reader.readInteger();
  const e = reader.readInteger();

  if (n <= 0n || e <= 0n) throw new Error('RSA: invalid public key values');
  if (n.toString(16).length < 128) throw new Error('RSA: modulus is suspiciously small');

  return { n, e, size: Math.ceil(n.toString(16).length / 2) };
}

/** 模幂。exp 为公钥指数（通常 65537），循环次数很少。 */
function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

/**
 * 明文编码与 ChillEast 客户端 `encryptCimsPassword` 一致：
 * 逐 UTF-16 code unit 按 UTF-8 规则编码（等价于 CESU-8，代理对会被编成两段三字节）。
 * 对 ASCII 学号/密码而言就是普通 ASCII 字节，但保持一致以免边界情况行为不同。
 */
export function encodeCimsPlaintext(password: string, token: string): Uint8Array {
  const source = `${password}|${token}`;
  const out: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(out);
}

/** PKCS#1 v1.5 块填充：0x00 || 0x02 || PS(非零随机) || 0x00 || M */
function pkcs1v15Pad(message: Uint8Array, keySize: number): Uint8Array {
  if (message.length > keySize - 11) {
    throw new Error('RSA: plaintext too long for a single PKCS#1 v1.5 block');
  }
  const block = new Uint8Array(keySize);
  block[0] = 0x00;
  block[1] = 0x02;
  const psLength = keySize - 3 - message.length;
  const ps = crypto.getRandomValues(new Uint8Array(psLength));
  for (let i = 0; i < psLength; i++) {
    // 填充串必须全部非零
    ps[i] = ps[i] === 0 ? 1 : ps[i];
  }
  block.set(ps, 2);
  block[2 + psLength] = 0x00;
  block.set(message, 3 + psLength);
  return block;
}

/** RSA PKCS#1 v1.5 加密，返回 base64 密文。 */
export function rsaEncryptPkcs1v15(key: RsaPublicKey, message: Uint8Array): string {
  const block = pkcs1v15Pad(message, key.size);
  const cipher = modPow(bytesToBigInt(block), key.e, key.n);
  return bytesToB64(bigIntToBytes(cipher, key.size));
}

/**
 * 学校认证接口要求的「公钥 + 密码 + 一次性 token -> authcode」。
 * encryptor 目前只支持 INTERNATIONAL（RSA）；NATIONAL 是国密 SM2，
 * ChillEast 客户端同样未支持，这里保持一致直接拒绝而不是静默降级。
 */
export function encryptCimsPassword(
  publicKey: string,
  encryptor: string,
  password: string,
  token: string,
): string {
  if (encryptor === 'NATIONAL') {
    throw new Error('服务端要求 SM2 加密，暂不支持，请在官方登录页面完成认证');
  }
  if (encryptor !== 'INTERNATIONAL') {
    throw new Error(`未知密码加密配置：${encryptor}`);
  }
  let key: RsaPublicKey;
  try {
    key = parseRsaPublicKey(publicKey);
  } catch {
    throw new Error('公钥格式无效');
  }
  return rsaEncryptPkcs1v15(key, encodeCimsPlaintext(password, token));
}

/** 供测试使用：从 PEM 文本里取出纯 base64。 */
export const __testing = { stripPem, bytesToBigInt, bigIntToBytes, pkcs1v15Pad };
