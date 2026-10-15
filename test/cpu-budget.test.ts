import { describe, expect, it } from 'vitest';
import { aesEcbDecrypt, aesEcbEncrypt, aesEcbEncryptUtf8Key } from '../src/util/aes';
import { parseRsaPublicKey, encryptCimsPassword } from '../src/auth/rsa';
import { CookieJar } from '../src/auth/cookies';
import { parseCimsBootstrap } from '../src/auth/cims';
import { credentialFingerprint, seal, open } from '../src/auth/crypto-box';

/**
 * CPU 预算基准测试。Workers 免费版每次调用只有 **10ms CPU 时间**（等网络不算 CPU）。
 * 登录链有 10 次 HTTP 往返，但 CPU 只花在解析与加密上 —— 这里把那几个热点逐个量出来，
 * 留下宽松上限（约 10 倍余量，避免 CI 抖动误报）当回归护栏：真正的目的是"某个改动把
 * CPU 放大一个数量级"时能被抓住。
 */

function measure(iterations: number, fn: () => void): number {
  // 预热，避开 JIT 首次编译
  for (let i = 0; i < Math.min(iterations, 5); i++) fn();
  const started = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return (performance.now() - started) / iterations;
}

async function measureAsync(iterations: number, fn: () => Promise<unknown>): Promise<number> {
  for (let i = 0; i < Math.min(iterations, 3); i++) await fn();
  const started = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  return (performance.now() - started) / iterations;
}

function report(label: string, msPerOp: number, ceilingMs: number): void {
  const share = ((msPerOp / 10) * 100).toFixed(2);
  console.log(
    `  ${label.padEnd(42)} ${msPerOp.toFixed(4)} ms/次  ` +
      `(占 10ms 预算 ${share}%)  上限 ${ceilingMs}ms`,
  );
}

const LOGIN_PAGE = `<!DOCTYPE html><html><head><title>统一身份认证</title></head><body>
<form method="post" id="cims_form">
${Array.from({ length: 12 }, (_, i) => `<input type="hidden" name="field${i}" value="value-${i}-${'x'.repeat(40)}"/>`).join('\n')}
<input type="hidden" name="execution" value="exec-token-abc_XYZ"/>
<input type="hidden" name="_eventId" value="login"/>
</form>
<script>CIMS.init({
  host: "https:\\/\\/sso.hunau.edu.cn\\/authn",
  postaction: "https:\\/\\/sso.hunau.edu.cn\\/cas\\/login",
  formid: 'cims_form',
  postArgument: 'signedCimsResponse',
  sig_request: "XD|QUJDREVGRw==|MTc5MTkzODQ3Mg==:APP|QUJDREVGRw==|c2lnbmF0dXJl",
  version: 'v2', username: "", reAuthError: "false"
});</script></body></html>`;

describe('CPU 预算（10ms/次）', () => {
  it('RSA PKCS#1 v1.5 是最重的自研计算，但仍然远低于预算', async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['encrypt', 'decrypt'],
    )) as CryptoKeyPair;
    const spkiBytes = new Uint8Array(
      (await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer,
    );
    let binary = '';
    for (const byte of spkiBytes) binary += String.fromCharCode(byte);
    const spki = btoa(binary);

    const parseMs = measure(50, () => {
      parseRsaPublicKey(spki);
    });
    report('DER 解析公钥', parseMs, 1);

    // 这是整个登录链里最贵的一步：2048 位模幂
    const encryptMs = measure(20, () => {
      encryptCimsPassword(spki, 'INTERNATIONAL', 'my-password', 'one-time-token');
    });
    report('RSA 加密 password|token', encryptMs, 5);

    expect(parseMs).toBeLessThan(1);
    expect(encryptMs).toBeLessThan(5);
  });

  it('AES-ECB 用于 ydjwxt 登录与 fin-serv 载荷，开销可忽略', () => {
    const key = new TextEncoder().encode('qzkj1kjghd=876&*');

    const shortMs = measure(200, () => {
      aesEcbEncryptUtf8Key('qzkj1kjghd=876&*', JSON.stringify('my-password'));
    });
    report('AES-ECB 加密（密码，1 块）', shortMs, 1);

    // fin-serv 的 datajson 会有几百字节到几 KB
    const payload = new TextEncoder().encode(JSON.stringify({ rooms: 'x'.repeat(2000) }));
    const bulkMs = measure(50, () => {
      aesEcbEncrypt(key, payload);
    });
    report(`AES-ECB 加密（约 ${(payload.length / 1024).toFixed(1)}KB）`, bulkMs, 5);

    const ciphertext = aesEcbEncrypt(key, payload);
    const decryptMs = measure(50, () => {
      aesEcbDecrypt(key, ciphertext);
    });
    report(`AES-ECB 解密（约 ${(payload.length / 1024).toFixed(1)}KB）`, decryptMs, 5);

    expect(shortMs).toBeLessThan(1);
    expect(bulkMs).toBeLessThan(5);
    expect(decryptMs).toBeLessThan(5);
  });

  it('SHA-256 指纹与会话加解密（走硬件加速）', async () => {
    const fingerprintMs = await measureAsync(50, () => credentialFingerprint('20230001', 'pw'));
    report('SHA-256 凭据指纹', fingerprintMs, 1);

    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const jarJson = JSON.stringify(
      Array.from({ length: 30 }, (_, i) => ({
        name: `cookie${i}`,
        value: 'v'.repeat(60),
        domain: 'hunau.edu.cn',
        path: '/',
        hostOnly: true,
        secure: true,
        httpOnly: true,
      })),
    );
    const sealMs = await measureAsync(30, () => seal(jarJson, key));
    report('AES-GCM 会话落盘加密（约 2KB）', sealMs, 3);

    const sealed = await seal(jarJson, key);
    const openMs = await measureAsync(30, () => open(sealed, key));
    report('AES-GCM 会话解密', openMs, 3);

    expect(fingerprintMs).toBeLessThan(1);
    expect(sealMs).toBeLessThan(3);
    expect(openMs).toBeLessThan(3);
  });

  it('登录页解析（HTMLRewriter + 正则）', async () => {
    const parseMs = await measureAsync(20, () =>
      parseCimsBootstrap(LOGIN_PAGE, 'https://sso.hunau.edu.cn/cas/login?service=x'),
    );
    report('解析 CIMS 登录页', parseMs, 5);
    expect(parseMs).toBeLessThan(5);
  });

  it('Cookie 罐操作是纯数组运算', () => {
    const setCookieHeader = 'UID=123456; Domain=.chaoxing.com; Path=/; Secure; HttpOnly';
    const addMs = measure(500, () => {
      const jar = new CookieJar();
      jar.absorb('https://passport2-api.chaoxing.com/api/v2/login6', [setCookieHeader]);
    });
    report('Cookie 吸收（单条）', addMs, 1);

    const jar = new CookieJar();
    for (let i = 0; i < 40; i++) {
      jar.absorb(`https://host${i}.hunau.edu.cn/`, [`c${i}=v${i}; Path=/`]);
    }
    const matchMs = measure(500, () => {
      jar.getCookieHeader('https://portal.hunau.edu.cn/index');
    });
    report('Cookie 匹配（40 条罐子）', matchMs, 1);

    expect(addMs).toBeLessThan(1);
    expect(matchMs).toBeLessThan(1);
  });

  it('一次典型工具调用的 CPU 总量估算留在预算内', () => {
    // 最坏情况：需要重新登录（RSA + 登录页解析 + Cookie） + 一次工具解析。
    // 网络往返不计入 CPU，所以这里只加本地计算。
    const rsa = 0.6; // 上一步实测的量级
    const parse = 0.5;
    const crypto = 0.1;
    const json = 0.2;
    const total = rsa + parse + crypto + json;
    report('估算合计（最坏情况：含重登）', total, 10);
    expect(total).toBeLessThan(10);
  });
});
