/**
 * AES-ECB（PKCS#7）。
 *
 * 为什么不用 WebCrypto：`crypto.subtle` 没有 ECB，而 AES-CBC 自带 PKCS#7 ——
 * 解密会自动去填充，所以「零 IV 逐块跑 CBC」这个技巧只对加密成立，解密会抛
 * OperationError。既然加解密都要正确，这里实现一个自包含的 AES：S 盒在模块
 * 加载时由 GF(2^8) 乘法逆元 + 仿射变换推导，避免手打 256 字节常量表抄错。
 *
 * CPU：本项目载荷都很小，纯 JS AES 处理 1KB 约 0.1ms 量级，相对 10ms 预算可忽略。
 */

const BLOCK_SIZE = 16;

// ---- GF(2^8) 与 S 盒推导 ----

function gfMultiply(a: number, b: number): number {
  let product = 0;
  let x = a;
  let y = b;
  for (let i = 0; i < 8; i++) {
    if (y & 1) product ^= x;
    const highBit = x & 0x80;
    x = (x << 1) & 0xff;
    if (highBit) x ^= 0x1b; // AES 的不可约多项式 x^8+x^4+x^3+x+1
    y >>= 1;
  }
  return product;
}

/** 乘法逆元：a^254（a=0 时定义为 0）。 */
function gfInverse(a: number): number {
  if (a === 0) return 0;
  let result = 1;
  for (let i = 0; i < 254; i++) result = gfMultiply(result, a);
  return result;
}

function rotateByteLeft(value: number, bits: number): number {
  return ((value << bits) | (value >> (8 - bits))) & 0xff;
}

function buildSBox(): Uint8Array {
  const sbox = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const inv = gfInverse(i);
    sbox[i] =
      (inv ^
        rotateByteLeft(inv, 1) ^
        rotateByteLeft(inv, 2) ^
        rotateByteLeft(inv, 3) ^
        rotateByteLeft(inv, 4) ^
        0x63) &
      0xff;
  }
  return sbox;
}

const SBOX = buildSBox();
const INV_SBOX = (() => {
  const inverse = new Uint8Array(256);
  for (let i = 0; i < 256; i++) inverse[SBOX[i]] = i;
  return inverse;
})();

// ---- 密钥扩展 ----

interface AesKey {
  /** 轮密钥，每轮 16 字节 */
  roundKeys: Uint8Array[];
  rounds: number;
}

function expandKey(key: Uint8Array): AesKey {
  if (key.length !== 16 && key.length !== 24 && key.length !== 32) {
    throw new Error(`AES: 密钥长度必须是 16/24/32 字节，收到 ${key.length}`);
  }
  const nk = key.length / 4; // 密钥字数
  const rounds = nk + 6; // 10 / 12 / 14
  const totalWords = 4 * (rounds + 1);

  const words: number[][] = [];
  for (let i = 0; i < nk; i++) {
    words.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
  }

  let rcon = 1;
  for (let i = nk; i < totalWords; i++) {
    let temp = [...words[i - 1]];
    if (i % nk === 0) {
      // RotWord + SubWord + Rcon
      temp = [temp[1], temp[2], temp[3], temp[0]].map((b) => SBOX[b]);
      temp[0] ^= rcon;
      rcon = gfMultiply(rcon, 2);
    } else if (nk > 6 && i % nk === 4) {
      temp = temp.map((b) => SBOX[b]);
    }
    const previous = words[i - nk];
    words.push([0, 1, 2, 3].map((j) => previous[j] ^ temp[j]));
  }

  const roundKeys: Uint8Array[] = [];
  for (let round = 0; round <= rounds; round++) {
    const roundKey = new Uint8Array(16);
    for (let word = 0; word < 4; word++) {
      const w = words[round * 4 + word];
      roundKey[4 * word] = w[0];
      roundKey[4 * word + 1] = w[1];
      roundKey[4 * word + 2] = w[2];
      roundKey[4 * word + 3] = w[3];
    }
    roundKeys.push(roundKey);
  }
  return { roundKeys, rounds };
}

// ---- 轮变换（状态按列主序：state[r + 4c]） ----

function addRoundKey(state: Uint8Array, roundKey: Uint8Array): void {
  for (let i = 0; i < 16; i++) state[i] ^= roundKey[i];
}

function subBytes(state: Uint8Array, box: Uint8Array): void {
  for (let i = 0; i < 16; i++) state[i] = box[state[i]];
}

function shiftRows(state: Uint8Array): void {
  // 第 r 行循环左移 r 个字节
  for (let row = 1; row < 4; row++) {
    const rowValues = [state[row], state[row + 4], state[row + 8], state[row + 12]];
    for (let column = 0; column < 4; column++) {
      state[row + 4 * column] = rowValues[(column + row) % 4];
    }
  }
}

function inverseShiftRows(state: Uint8Array): void {
  for (let row = 1; row < 4; row++) {
    const rowValues = [state[row], state[row + 4], state[row + 8], state[row + 12]];
    for (let column = 0; column < 4; column++) {
      state[row + 4 * column] = rowValues[(column - row + 4) % 4];
    }
  }
}

function mixColumns(state: Uint8Array): void {
  for (let column = 0; column < 4; column++) {
    const offset = 4 * column;
    const a0 = state[offset];
    const a1 = state[offset + 1];
    const a2 = state[offset + 2];
    const a3 = state[offset + 3];
    state[offset] = gfMultiply(a0, 2) ^ gfMultiply(a1, 3) ^ a2 ^ a3;
    state[offset + 1] = a0 ^ gfMultiply(a1, 2) ^ gfMultiply(a2, 3) ^ a3;
    state[offset + 2] = a0 ^ a1 ^ gfMultiply(a2, 2) ^ gfMultiply(a3, 3);
    state[offset + 3] = gfMultiply(a0, 3) ^ a1 ^ a2 ^ gfMultiply(a3, 2);
  }
}

function inverseMixColumns(state: Uint8Array): void {
  for (let column = 0; column < 4; column++) {
    const offset = 4 * column;
    const a0 = state[offset];
    const a1 = state[offset + 1];
    const a2 = state[offset + 2];
    const a3 = state[offset + 3];
    state[offset] = gfMultiply(a0, 14) ^ gfMultiply(a1, 11) ^ gfMultiply(a2, 13) ^ gfMultiply(a3, 9);
    state[offset + 1] = gfMultiply(a0, 9) ^ gfMultiply(a1, 14) ^ gfMultiply(a2, 11) ^ gfMultiply(a3, 13);
    state[offset + 2] = gfMultiply(a0, 13) ^ gfMultiply(a1, 9) ^ gfMultiply(a2, 14) ^ gfMultiply(a3, 11);
    state[offset + 3] = gfMultiply(a0, 11) ^ gfMultiply(a1, 13) ^ gfMultiply(a2, 9) ^ gfMultiply(a3, 14);
  }
}

function encryptBlock(state: Uint8Array, key: AesKey): void {
  addRoundKey(state, key.roundKeys[0]);
  for (let round = 1; round < key.rounds; round++) {
    subBytes(state, SBOX);
    shiftRows(state);
    mixColumns(state);
    addRoundKey(state, key.roundKeys[round]);
  }
  subBytes(state, SBOX);
  shiftRows(state);
  addRoundKey(state, key.roundKeys[key.rounds]);
}

function decryptBlock(state: Uint8Array, key: AesKey): void {
  addRoundKey(state, key.roundKeys[key.rounds]);
  for (let round = key.rounds - 1; round >= 1; round--) {
    inverseShiftRows(state);
    subBytes(state, INV_SBOX);
    addRoundKey(state, key.roundKeys[round]);
    inverseMixColumns(state);
  }
  inverseShiftRows(state);
  subBytes(state, INV_SBOX);
  addRoundKey(state, key.roundKeys[0]);
}

// ---- PKCS#7 与 ECB 组装 ----

/** PKCS#7 填充。 */
export function pkcs7Pad(data: Uint8Array): Uint8Array {
  const padLength = BLOCK_SIZE - (data.length % BLOCK_SIZE);
  const out = new Uint8Array(data.length + padLength);
  out.set(data, 0);
  out.fill(padLength, data.length);
  return out;
}

/** 去掉并校验 PKCS#7 填充。 */
export function pkcs7Unpad(data: Uint8Array): Uint8Array {
  if (data.length === 0 || data.length % BLOCK_SIZE !== 0) {
    throw new Error('AES: 密文长度不是块大小的整数倍');
  }
  const padLength = data[data.length - 1];
  if (padLength < 1 || padLength > BLOCK_SIZE) {
    throw new Error('AES: PKCS#7 填充非法');
  }
  for (let i = data.length - padLength; i < data.length; i++) {
    if (data[i] !== padLength) throw new Error('AES: PKCS#7 填充校验失败');
  }
  return data.subarray(0, data.length - padLength);
}

/** AES-ECB + PKCS#7 加密。 */
export function aesEcbEncrypt(keyBytes: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const key = expandKey(keyBytes);
  const padded = pkcs7Pad(plaintext);
  const out = new Uint8Array(padded.length);
  for (let offset = 0; offset < padded.length; offset += BLOCK_SIZE) {
    const state = padded.slice(offset, offset + BLOCK_SIZE);
    encryptBlock(state, key);
    out.set(state, offset);
  }
  return out;
}

/** AES-ECB + PKCS#7 解密。 */
export function aesEcbDecrypt(keyBytes: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (ciphertext.length === 0 || ciphertext.length % BLOCK_SIZE !== 0) {
    throw new Error('AES: 密文长度非法');
  }
  const key = expandKey(keyBytes);
  const out = new Uint8Array(ciphertext.length);
  for (let offset = 0; offset < ciphertext.length; offset += BLOCK_SIZE) {
    const state = ciphertext.slice(offset, offset + BLOCK_SIZE);
    decryptBlock(state, key);
    out.set(state, offset);
  }
  return pkcs7Unpad(out);
}

/** UTF-8 密钥便捷封装（加密）。 */
export function aesEcbEncryptUtf8Key(key: string, plaintext: string): Uint8Array {
  return aesEcbEncrypt(new TextEncoder().encode(key), new TextEncoder().encode(plaintext));
}

/** UTF-8 密钥便捷封装（解密）。 */
export function aesEcbDecryptUtf8Key(key: string, ciphertext: Uint8Array): string {
  return new TextDecoder().decode(aesEcbDecrypt(new TextEncoder().encode(key), ciphertext));
}

/** 供测试使用的内部件。 */
export const __testing = { SBOX, INV_SBOX, expandKey, encryptBlock, decryptBlock };
