/**
 * fin-serv（一卡通财务平台）纯逻辑单测，跑在 workerd 里（`@cloudflare/vitest-pool-workers`），
 * 所以 `HTMLRewriter` 行为与线上一致，卡片解析用例直接拿 HAR 原文当夹具。最有分量的是
 * `真实抓包向量`：密文来自 `chilleast/debug/付款码/付款码.har`（真实客户端 + 真实服务端），
 * 一次锁死 handleKey 移位/反转、AES-128-ECB/PKCS7 与 `密钥前 16 位 + base64 密文` —— 错一处就解不出原文。
 */

import { describe, expect, it } from 'vitest';
import {
  DK_KEY_ALPHABET,
  HAR_VECTORS,
  decryptPayload,
  decryptServerResponse,
  displayRoomName,
  encryptPayload,
  generateDataKey,
  handleKey,
  parseCardHtml,
  resolveTradeType,
  resolveTransactionRange,
  roomNameFromAccount,
  schoolToday,
} from '../src/school/hunau/finserv';
import { createFinServTools } from '../src/tools/finserv';
import { ToolRegistry } from '../src/mcp/registry';
import { bytesToB64 } from '../src/util/bytes';
import { aesEcbEncryptUtf8Key } from '../src/util/aes';

// ===========================================================================
// DkywCrypto
// ===========================================================================

describe('handleKey —— 对齐 my-encryption.js 的移位 + 反转', () => {
  it('加密方向：key[10:] + key[:10] 之后整体反转', () => {
    // 0123456789abcdef -> abcdef0123456789 -> 9876543210fedcba
    expect(handleKey('0123456789abcdef', true)).toBe('9876543210fedcba');
  });

  it('解密方向：整体反转后把开头 6 位挪到末尾', () => {
    expect(handleKey('9876543210fedcba', false)).toBe('0123456789abcdef');
  });

  it('两个方向互逆（10 + 6 = 16）', () => {
    for (let round = 0; round < 200; round++) {
      const key = generateDataKey(16);
      expect(handleKey(handleKey(key, true), false)).toBe(key);
      expect(handleKey(handleKey(key, false), true)).toBe(key);
    }
  });

  it('长度不是 16 直接报错，不静默算出垃圾密钥', () => {
    expect(() => handleKey('short', true)).toThrow(/16 位密钥/);
    expect(() => handleKey('0123456789abcde', false)).toThrow(/16 位密钥/);
    expect(() => handleKey('0123456789abcdef0', true)).toThrow(/16 位密钥/);
  });
});

describe('generateDataKey', () => {
  it('默认 16 位，且只含 [A-Za-z0-9]', () => {
    for (let round = 0; round < 50; round++) {
      const key = generateDataKey();
      expect(key).toHaveLength(16);
      for (const char of key) expect(DK_KEY_ALPHABET).toContain(char);
    }
  });

  it('长样本能覆盖到全部 62 个字符（拒绝采样没把值域截断）', () => {
    const seen = new Set<string>();
    for (let round = 0; round < 400; round++) {
      for (const char of generateDataKey(16)) seen.add(char);
    }
    expect(seen.size).toBe(DK_KEY_ALPHABET.length);
  });

  it('支持自定义长度', () => {
    expect(generateDataKey(24)).toHaveLength(24);
  });
});

describe('encryptPayload / decryptPayload 往返', () => {
  it('对象、数组、标量、中文都能原样回来', () => {
    const samples: unknown[] = [
      { txamt: '1', payWay: '2', openid: 'ABC', idserial: '202300010001' },
      ['a', 'b', { c: 1 }],
      { nested: { list: [1, 2, 3], text: '金岸公寓空调·302' } },
      {},
      { 中文键: '中文值', emoji: '⚡' },
    ];
    for (const sample of samples) {
      expect(decryptPayload(encryptPayload(sample))).toEqual(sample);
    }
  });

  it('密文短于等于 16 位时原样返回（Dart 的 early return）', () => {
    expect(decryptPayload('1234567890123456')).toBe('1234567890123456');
    expect(decryptPayload('')).toBe('');
  });

  it('封装格式是「16 位密钥 + base64」，整体长度对齐到 4 字节', () => {
    const packed = encryptPayload({ a: 1 });
    expect(packed.length).toBeGreaterThan(16);
    expect((packed.length - 16) % 4).toBe(0);
    for (const char of packed.slice(0, 16)) expect(DK_KEY_ALPHABET).toContain(char);
  });
});

// ===========================================================================
// 真实抓包向量 —— 与线上实现一致的证明
// ===========================================================================

describe('真实抓包向量（debug/付款码/付款码.har）', () => {
  it('解出真实请求体 {idserial, openid}', () => {
    expect(decryptPayload(HAR_VECTORS.requestCipher)).toEqual(HAR_VECTORS.requestPlain);
  });

  it('解出真实响应体 {message, resultData, success}', () => {
    expect(decryptPayload(HAR_VECTORS.responseCipher)).toEqual(HAR_VECTORS.responsePlain);
  });

  it('从密文里反推出的 AES 密钥与手工推导一致', () => {
    // 这两条把 handleKey 的「解密方向」钉死在真实数据上
    expect(handleKey(HAR_VECTORS.requestCipher.slice(0, 16), false)).toBe('9uTntyVgOkHx80tJ');
    expect(handleKey(HAR_VECTORS.responseCipher.slice(0, 16), false)).toBe('8NmmiH4fuBmP9M5Y');
  });

  it('真实响应走完整信封解析后仍是 {success:true}', () => {
    const envelope = JSON.stringify({ datajson: HAR_VECTORS.responseCipher });
    expect(decryptServerResponse(envelope)).toEqual(HAR_VECTORS.responsePlain);
  });
});

// ===========================================================================
// decryptServerResponse 的各种包裹形态
// ===========================================================================

describe('decryptServerResponse 兼容分支', () => {
  const payload = { txamt: '10', payWay: '2', openid: 'X' };

  it('1. 已经是对象 {datajson: …}', () => {
    expect(decryptServerResponse({ datajson: encryptPayload(payload) })).toEqual(payload);
  });

  it('2. 原始 JSON 字符串 {"datajson":"…"}', () => {
    const body = JSON.stringify({ datajson: encryptPayload(payload) });
    expect(decryptServerResponse(body)).toEqual(payload);
  });

  it('3. HTML 转义 + 外层引号包裹（createPreThirdTrade 的形态）', () => {
    const body = `"${JSON.stringify({ datajson: encryptPayload(payload) }).replaceAll('"', '&quot;')}"`;
    expect(body).toContain('&quot;');
    expect(decryptServerResponse(body)).toEqual(payload);
  });

  it('3b. 只有 HTML 转义、没有外层引号', () => {
    const body = JSON.stringify({ datajson: encryptPayload(payload) }).replaceAll('"', '&quot;');
    expect(decryptServerResponse(body)).toEqual(payload);
  });

  it('4. 不是合法 JSON 时用正则捞 datajson 密文', () => {
    const cipher = encryptPayload(payload);
    expect(decryptServerResponse(`datajson=${cipher}`)).toEqual(payload);
    expect(decryptServerResponse(`{datajson: '${cipher}'}`)).toEqual(payload);
  });

  it('明文是 JSON 字符串时再解一层', () => {
    const doubleEncoded = JSON.stringify(JSON.stringify(payload));
    expect(decryptServerResponse({ datajson: encryptPayload(doubleEncoded) })).toEqual(payload);
  });

  it('明文不是 JSON 时原样返回字符串', () => {
    expect(decryptServerResponse({ datajson: encryptPayload('plain text') })).toBe('plain text');
  });

  it('null / 没有 datajson 的对象 / 数组都按 Dart 语义返回', () => {
    expect(decryptServerResponse(null)).toBeNull();
    expect(decryptServerResponse(undefined)).toBeNull();
    expect(decryptServerResponse({ a: 1 })).toEqual({ a: 1 });
    expect(decryptServerResponse([1, 2])).toEqual([1, 2]);
  });

  it('会话失效时返回 HTML 原文（上层据此抛 SessionExpiredError）', () => {
    const html = '<html><body>统一身份认证 <input type="password"></body></html>';
    expect(decryptServerResponse(html)).toBe(html);
  });
});

// ===========================================================================
// 卡片信息 HTML 解析（夹具取自 HAR 原文）
// ===========================================================================

/** `付款码.har` 里 openVirtualcard 的实际片段。 */
const VIRTUALCARD_FRAGMENT = `<input id="openid" value="FEA275B6280F7863C75FE57AFE4004386CD8065A797E3D462F924286B82B0C02245E9D0B4DF389D37A94891E99FC7217" type="hidden">
<body class="bdbg">
<div class="top gradient2">
    <h1 class="c1">
        <a class="fl" href="/home/openHomePage?openid=FEA275B6280F7863C75FE57AFE4004386CD8065A797E3D462F924286B82B0C02245E9D0B4DF389D37A94891E99FC7217"><img src="/images/white-black.png"></a>
        <!--付款码-->
        <p1 class="fl">虚拟卡</p1>
    </h1>
</div>
<div class="mode-w">
    <div class="code-w">
        <p class="bdb">张三：202300010001 余额：0.10元</p>
        <!--二维码-->
        <div class="code">
            <img id="qrcode" onclick="refreshPaycode();" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAOEAAADhCAIA">
        </div>
    </div>
</div>
<input id="idserial" value="202300010001" type="hidden">`;

/** `校园卡充值（微信）（加密）.har` 里 openCardPay 的实际片段（顺序与 HAR 一致）。 */
const CARDPAY_FRAGMENT = `<div class="query-condition">
    <form name="form1" method="post" id="form1">
        <div class="condition">
            <!--学工号-->
            <label>学工号</label>
            <input placeholder="学工号" value="202300010001" readonly type="text">
        </div>
        <div class="condition">
            <!--卡余额-->
            <label>卡余额</label>
            <p>0.10元</p>
        </div>
        <div class="condition">
            <!--充值金额-->
            <label>充值金额</label>
            <input id="txamt" name="txamt" placeholder="请输入充值金额" type="number">
        </div>
        <p class="">系统开放时间:<em>01:00-23:00</em></p>
        <p class="">充值金额不可大于<em>1000.00</em>元</p>
        <p class="">温馨提示：<em>使用农行掌银支付前请先安装农行掌银APP</em></p>
    </form>
</div>
<input id="openid" name="openid" value="FEA275B6280F7863C75FE57AFE4004386CD8065A797E3D462F924286B82B0C02245E9D0B4DF389D37A94891E99FC7217" type="hidden">
<input id="idserial" name="idserial" value="202300010001" type="hidden">
<input id="username" name="username" value="张三" type="hidden">`;

describe('卡片信息解析（HAR 原文夹具）', () => {
  it('付款码页：一行 <p class="bdb"> 就能拿全三项', async () => {
    expect(await parseCardHtml(VIRTUALCARD_FRAGMENT)).toEqual({
      name: '张三',
      idserial: '202300010001',
      balance: '0.10',
    });
  });

  it('充值页：隐藏 input + 卡余额段落', async () => {
    expect(await parseCardHtml(CARDPAY_FRAGMENT)).toEqual({
      name: '张三',
      idserial: '202300010001',
      balance: '0.10',
    });
  });

  it('充值页不会把「充值金额不可大于 1000.00 元」误当成余额', async () => {
    const parsed = await parseCardHtml(CARDPAY_FRAGMENT);
    expect(parsed?.balance).toBe('0.10');
    expect(parsed?.balance).not.toBe('1000.00');
  });

  it('没有卡片信息的页面返回 null', async () => {
    expect(await parseCardHtml('<html><body><p>资源受限</p></body></html>')).toBeNull();
  });
});

// ===========================================================================
// 流水查询参数（东八区日期 + 服务端限制）
// ===========================================================================

describe('schoolToday —— 必须按东八区算「今天」', () => {
  it('UTC 还是前一天时，中国已经是次日', () => {
    // 2026-09-21T17:00Z == 中国 2026-09-22 01:00
    expect(schoolToday(Date.UTC(2026, 8, 21, 17, 0, 0))).toEqual({
      year: 2026,
      month: 9,
      day: 22,
    });
  });

  it('UTC 15:59 仍是中国的当天', () => {
    // 2026-09-21T15:59Z == 中国 2026-09-21 23:59
    expect(schoolToday(Date.UTC(2026, 8, 21, 15, 59, 0))).toEqual({
      year: 2026,
      month: 9,
      day: 21,
    });
  });
});

describe('resolveTransactionRange', () => {
  // 固定「现在」= 中国 2026-09-22 10:00
  const NOW = Date.UTC(2026, 8, 22, 2, 0, 0);

  it('不传日期默认近 7 天（含今天）', () => {
    const result = resolveTransactionRange({ now: NOW });
    expect(result).toEqual({
      ok: true,
      range: {
        beginDate: '2026-09-16',
        endDate: '2026-09-22',
        tradeType: '-1',
        tradeLabel: '全部',
      },
    });
  });

  it('中文类型名与数字取值都认', () => {
    for (const [input, value] of [
      ['消费', '1'],
      ['充值', '2'],
      ['补助', '3'],
      ['转账', '4'],
      ['全部', '-1'],
      ['1', '1'],
      ['2', '2'],
    ] as const) {
      const result = resolveTransactionRange({ now: NOW, tradeType: input });
      expect(result.ok && result.range.tradeType).toBe(value);
    }
  });

  it('未知类型回落「全部」', () => {
    expect(resolveTradeType('乱写')).toEqual({ value: '-1', label: '全部' });
  });

  it('恰好 31 天放行，32 天拒绝', () => {
    expect(resolveTransactionRange({ now: NOW, beginDate: '2026-08-22', endDate: '2026-09-22' }).ok).toBe(
      true,
    );
    const tooLong = resolveTransactionRange({
      now: NOW,
      beginDate: '2026-08-21',
      endDate: '2026-09-22',
    });
    expect(tooLong.ok).toBe(false);
    expect(tooLong.ok === false && tooLong.message).toContain('31 天');
  });

  it('截止日期不能超过今天', () => {
    const result = resolveTransactionRange({ now: NOW, endDate: '2026-09-23' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('不能超过今天');
  });

  it('截止日期不能早于起始日期', () => {
    const result = resolveTransactionRange({
      now: NOW,
      beginDate: '2026-09-20',
      endDate: '2026-09-18',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('不能早于');
  });

  it('格式错误与不存在的日期都被拒绝', () => {
    for (const bad of ['2026/09/01', '2026-9-1', '20260901', '2026-02-31', '昨天']) {
      const result = resolveTransactionRange({ now: NOW, beginDate: bad });
      expect(result.ok).toBe(false);
    }
  });
});

// ===========================================================================
// 房间名展示
// ===========================================================================

describe('房间名展示', () => {
  it('哈希房号从账户名里抠出真实房号', () => {
    expect(roomNameFromAccount('XS-JA-1-629(学生公寓空调.金岸1栋.629)')).toBe('629');
    expect(roomNameFromAccount('XS-DH-2-101(学生公寓照明)')).toBe('101');
    expect(roomNameFromAccount('没有可提取的房号')).toBe('');
  });

  it('哈希 ID 不直接展示给用户', () => {
    const hash = 'a'.repeat(32);
    expect(displayRoomName({ roomId: hash, roomName: hash })).toBe('所选宿舍');
    expect(displayRoomName({ roomId: hash, roomName: '302' })).toBe('302');
    expect(displayRoomName({ roomId: '302', roomName: '' })).toBe('302');
  });
});

// ===========================================================================
// 工具定义契约（不依赖 src/tools/index.ts 的注册）
// ===========================================================================

describe('createFinServTools 契约', () => {
  const tools = createFinServTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  it('恰好 5 个工具，工具名与 ChillEast 完全一致', () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'query_bill',
      'query_campus_card_balance',
      'query_card_transactions',
      'query_electricity',
      'recharge_electricity',
    ]);
  });

  it('没有重名，描述都足够长', () => {
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
    for (const tool of tools) expect(tool.description.trim().length).toBeGreaterThan(10);
  });

  it('每个 inputSchema 都是合法 object schema 且禁止额外参数', () => {
    for (const tool of tools) {
      expect(tool.inputSchema['type'], tool.name).toBe('object');
      expect(typeof tool.inputSchema['properties'], tool.name).toBe('object');
      expect(tool.inputSchema['additionalProperties'], tool.name).toBe(false);
    }
  });

  it('别名与主实现共用同一个 handler（真的是"同一个实现"）', () => {
    expect(byName.get('query_electricity')?.handler).toBe(
      byName.get('recharge_electricity')?.handler,
    );
    expect(byName.get('query_bill')?.handler).toBe(
      byName.get('query_card_transactions')?.handler,
    );
  });

  it('别名与主实现的入参 schema 完全一致', () => {
    expect(byName.get('query_electricity')?.inputSchema).toEqual(
      byName.get('recharge_electricity')?.inputSchema,
    );
    expect(byName.get('query_bill')?.inputSchema).toEqual(
      byName.get('query_card_transactions')?.inputSchema,
    );
  });

  it('电费工具声明了 query_balance / recharge 等 action', () => {
    const schema = byName.get('recharge_electricity')?.inputSchema as {
      properties?: Record<string, { enum?: unknown }>;
    };
    expect(schema.properties?.['action']?.enum).toEqual([
      'query_balance',
      'recharge',
      'get_areas',
      'get_buildings',
      'get_rooms',
    ]);
  });

  it('recharge_electricity 的描述明确写了会产生真实订单与两阶段确认', () => {
    const description = byName.get('recharge_electricity')?.description ?? '';
    expect(description).toContain('真实订单');
    expect(description).toContain('扣款');
    expect(description).toContain('两阶段确认');
  });

  it('电费工具声明了 confirmationToken 字段用于二次确认', () => {
    const schema = byName.get('recharge_electricity')?.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties?.['confirmationToken']).toBeDefined();
  });

  it('流水工具的 tradeType 枚举与 Dart 的 select 一致', () => {
    const schema = byName.get('query_card_transactions')?.inputSchema as {
      properties?: Record<string, { enum?: unknown }>;
    };
    expect(schema.properties?.['tradeType']?.enum).toEqual([
      '全部',
      '消费',
      '充值',
      '补助',
      '转账',
    ]);
  });

  it('5 个工具都能无冲突地注册进 ToolRegistry（注册是父任务负责的）', () => {
    const registry = new ToolRegistry();
    for (const tool of tools) expect(() => registry.register(tool)).not.toThrow();
    expect(registry.size).toBe(5);
    for (const name of [
      'query_campus_card_balance',
      'recharge_electricity',
      'query_electricity',
      'query_card_transactions',
      'query_bill',
    ]) {
      expect(registry.get(name), name).toBeDefined();
    }
  });
});

// ===========================================================================
// CPU：解析与加解密都在 10ms 预算内（数量级回归护栏）
// ===========================================================================

/**
 * 注意：workerd 里 `performance.now()` 的分辨率是 **1ms**（已实测：背靠背两次
 * 调用差恒为 0.0000），而单次 HTML 解析的真实成本远低于这个刻度。
 * 所以这里只做「循环 N 次的总耗时」断言 —— 和 `cpu-budget.test.ts` 的取向一致，
 * 目的不是精确计量，而是「某次改动把 CPU 放大一个数量级」时能被抓住。
 */
describe('CPU 预算', () => {
  /** 真实页面：openVirtualcard 5276 字节、openCardPay 6987 字节。这里取 7KB 量级。 */
  function realisticPage(): string {
    const filler = Array.from(
      { length: 100 },
      (_, i) => `<div class="condition"><label>字段${i}</label><p>${i}.00元</p></div>`,
    ).join('\n');
    return `<html><body>${filler}${VIRTUALCARD_FRAGMENT}</body></html>`;
  }

  it('反复解析 7KB 页面：总耗时远低于 100 次 × 10ms 的预算', async () => {
    const html = realisticPage();
    expect(html.length).toBeGreaterThan(6_000);

    const iterations = 100;
    for (let i = 0; i < 5; i++) await parseCardHtml(html); // 预热，避开首次 transform 的一次性开销
    const started = performance.now();
    for (let i = 0; i < iterations; i++) await parseCardHtml(html);
    const total = performance.now() - started;

    console.log(
      `  HTMLRewriter 解析（${html.length} 字节 × ${iterations} 次）  ${total.toFixed(1)} ms 总计  ` +
        `（≤ ${(total / iterations).toFixed(4)} ms/次，计时器刻度 1ms）`,
    );
    expect(total).toBeLessThan(100);
  });

  it('反复做 datajson 加解密往返：摊薄后远低于 10ms', () => {
    const payload = {
      payamt: '10',
      openid: HAR_VECTORS.requestPlain.openid,
      idserial: '202300010001',
      factorycode: 'E013',
    };
    const roundTrip = (): void => {
      decryptPayload(encryptPayload(payload));
    };
    for (let i = 0; i < 20; i++) roundTrip(); // 预热 JIT
    const iterations = 100;
    const started = performance.now();
    for (let i = 0; i < iterations; i++) roundTrip();
    const perCall = (performance.now() - started) / iterations;

    console.log(
      `  datajson 加解密往返（含随机密钥生成）  ${perCall.toFixed(4)} ms/次  ` +
        `(占 10ms 预算 ${((perCall / 10) * 100).toFixed(2)}%)`,
    );
    expect(perCall).toBeLessThan(2);
  });
});
