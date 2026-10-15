/**
 * 阳光服务（sun）纯逻辑单元测试，覆盖移植时最容易出错的几处：**GBK 解码**（老 ASP.NET
 * 站声明 utf-8 却输出 GBK，只按声明解会乱码）；`h_CardCode` / `UserName` 等身份字段抽取
 * （HTMLRewriter）；类别归一、受理单位匹配、默认期望时间、提交返回值；工具名与 schema。
 * 这些都是**没有真实账号也能验证**的部分；真正的 OAuth2 换票与投递链路未实测。
 */

import { describe, expect, it } from 'vitest';
import { decodeBody } from '../src/auth/http';
import {
  SUNSHINE_TYPE_NAMES,
  decodeSunshineText,
  defaultSunshineFinishTime,
  findSunshineDepartment,
  normalizeSunshineType,
  parseSunshineIdentity,
  parseSunshineSubmitResult,
} from '../src/school/hunau/sun';
import { createSunshineTools } from '../src/tools/sunshine';

/** '阳光服务' 的 GBK 字节（阳 D1F4 光 B9E2 服 B7FE 务 CEF1）。 */
const GBK_SUNSHINE = new Uint8Array([0xd1, 0xf4, 0xb9, 0xe2, 0xb7, 0xfe, 0xce, 0xf1]);
/** '校园网' 的 GBK 字节。 */
const GBK_CAMPUS_NET = new Uint8Array([0xd0, 0xa3, 0xd4, 0xb0, 0xcd, 0xf8]);
/** `{"rows":[{"Company_name":"后勤保卫部"}]}` 的 GBK 字节。 */
const GBK_ROWS = new Uint8Array([
  0x7b, 0x22, 0x72, 0x6f, 0x77, 0x73, 0x22, 0x3a, 0x5b, 0x7b, 0x22, 0x43, 0x6f, 0x6d, 0x70, 0x61,
  0x6e, 0x79, 0x5f, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0x22, 0xba, 0xf3, 0xc7, 0xda, 0xb1, 0xa3,
  0xce, 0xc0, 0xb2, 0xbf, 0x22, 0x7d, 0x5d, 0x7d,
]);

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('GBK 解码（阳光服务的响应全是 GBK）', () => {
  it('workerd 原生支持 gb18030 —— 不需要 GBK 映射表', () => {
    expect(new TextDecoder('gb18030').decode(GBK_SUNSHINE)).toBe('阳光服务');
    expect(new TextDecoder('gbk').decode(GBK_CAMPUS_NET)).toBe('校园网');
  });

  it('声明 gb2312 / gbk / gb18030 时按 GB18030 解', () => {
    expect(decodeSunshineText(GBK_SUNSHINE, 'text/html; charset=gb2312')).toBe('阳光服务');
    expect(decodeSunshineText(GBK_SUNSHINE, 'text/html; charset=GBK')).toBe('阳光服务');
    expect(decodeSunshineText(GBK_SUNSHINE, 'application/json; charset=gb18030')).toBe('阳光服务');
  });

  it('没有声明 charset 时按 GBK 解（老站最常见的形态）', () => {
    expect(decodeSunshineText(GBK_SUNSHINE, null)).toBe('阳光服务');
    expect(decodeSunshineText(GBK_SUNSHINE, 'text/html')).toBe('阳光服务');
  });

  it('声明 utf-8 但字节其实是 GBK 时回退 GB18030（否则中文全乱码）', () => {
    expect(decodeSunshineText(GBK_SUNSHINE, 'application/json; charset=utf-8')).toBe('阳光服务');
    expect(decodeSunshineText(GBK_ROWS, 'application/json; charset=utf-8')).toBe(
      '{"rows":[{"Company_name":"后勤保卫部"}]}',
    );
  });

  it('真的是 UTF-8 时不会被 GBK 带偏', () => {
    expect(decodeSunshineText(utf8('阳光服务'), 'application/json; charset=utf-8')).toBe('阳光服务');
  });

  it('纯 ASCII 响应两种解码一致', () => {
    expect(decodeSunshineText(utf8('{"rows":[]}'), 'application/json')).toBe('{"rows":[]}');
  });

  it('CookieSession 的通用解码路径同样认 GBK（对照，说明设施层已经支持）', () => {
    expect(decodeBody(GBK_SUNSHINE, 'text/html; charset=gb2312')).toBe('阳光服务');
  });
});

describe('身份抽取（HTMLRewriter）', () => {
  const page = `<!DOCTYPE html><html><head><meta charset="gb2312"><title>阳光服务</title></head>
<body><form id="form1">
  <input type="hidden" id="h_CardCode" value="202300010001" />
  <input type="hidden" id="UserName" value="李四" />
  <input type="hidden" id="telPhone" value="13800000000" />
  <input type="hidden" id="email" value="me@example.com" />
  <input type="text" id="title" value="无关字段" />
</form></body></html>`;

  it('抽出 h_CardCode / UserName / telPhone / email', async () => {
    const identity = await parseSunshineIdentity(page);
    expect(identity).toEqual({
      cardCode: '202300010001',
      name: '李四',
      phone: '13800000000',
      email: 'me@example.com',
    });
  });

  it('属性顺序、单引号、多余空白都能处理', async () => {
    const html =
      `<div><input value=' 202300010002 ' id='h_CardCode'>` +
      `<input id="UserName" value="张三" ></div>`;
    const identity = await parseSunshineIdentity(html);
    expect(identity?.cardCode).toBe('202300010002');
    expect(identity?.name).toBe('张三');
    expect(identity?.phone).toBe('');
  });

  it('缺少关键字段（登录页/失效页）返回 null', async () => {
    expect(await parseSunshineIdentity('<html><body>请登录</body></html>')).toBeNull();
    expect(
      await parseSunshineIdentity('<input id="h_CardCode" value="123" />'),
    ).toBeNull();
    expect(await parseSunshineIdentity('')).toBeNull();
  });

  it('id 相同但元素不是 input/textarea（如 script 变量）不误采', async () => {
    const html = `<script>var h_CardCode = "999";</script><input id="UserName" value="李四">`;
    expect(await parseSunshineIdentity(html)).toBeNull();
  });
});

describe('类别归一', () => {
  it('数字与汉字都能认，认不出按咨询', () => {
    expect(normalizeSunshineType('1')).toBe('1');
    expect(normalizeSunshineType('投诉')).toBe('1');
    expect(normalizeSunshineType('3')).toBe('3');
    expect(normalizeSunshineType('建议')).toBe('3');
    expect(normalizeSunshineType('4')).toBe('4');
    expect(normalizeSunshineType('表扬')).toBe('4');
    expect(normalizeSunshineType('2')).toBe('2');
    expect(normalizeSunshineType('咨询')).toBe('2');
    expect(normalizeSunshineType('')).toBe('2');
    expect(normalizeSunshineType('不知道')).toBe('2');
  });

  it('typeNames 与 Dart 一致', () => {
    expect(SUNSHINE_TYPE_NAMES).toEqual({ '1': '投诉', '2': '咨询', '3': '建议', '4': '表扬' });
  });
});

describe('受理单位匹配', () => {
  const departments = [
    { code: '01', name: '后勤保卫部' },
    { code: '02', name: '教务处' },
    { code: '03', name: '图书馆' },
  ];

  it('先精确匹配名称或 code', () => {
    expect(findSunshineDepartment(departments, '教务处')?.code).toBe('02');
    expect(findSunshineDepartment(departments, '03')?.name).toBe('图书馆');
  });

  it('再按包含关系匹配（双向）', () => {
    expect(findSunshineDepartment(departments, '后勤')?.name).toBe('后勤保卫部');
    expect(findSunshineDepartment(departments, '后勤保卫部（保卫处）')?.name).toBe('后勤保卫部');
  });

  it('匹配不到或空输入返回 null', () => {
    expect(findSunshineDepartment(departments, '校医院')).toBeNull();
    expect(findSunshineDepartment(departments, '   ')).toBeNull();
  });
});

describe('默认期望解决时间与提交返回值', () => {
  it('默认 7 天后，按中国时区的日期', () => {
    expect(defaultSunshineFinishTime(new Date('2026-09-23T00:00:00Z'))).toBe('2026-09-30');
    // 中国时间 2026-09-23 00:30（UTC 前一天 16:30）也要算作 23 号
    expect(defaultSunshineFinishTime(new Date('2026-09-22T16:30:00Z'))).toBe('2026-09-30');
    // 跨月
    expect(defaultSunshineFinishTime(new Date('2026-12-28T02:00:00Z'))).toBe('2027-01-04');
  });

  it('提交返回值只认 1 / 2 / errer', () => {
    expect(parseSunshineSubmitResult('1')).toBe('1');
    expect(parseSunshineSubmitResult(' 2 ')).toBe('2');
    expect(parseSunshineSubmitResult('errer')).toBe('errer');
    expect(parseSunshineSubmitResult('0')).toBe('unknown');
    expect(parseSunshineSubmitResult('<html>登录页</html>')).toBe('unknown');
    expect(parseSunshineSubmitResult('')).toBe('unknown');
  });
});

describe('工具定义', () => {
  const tools = createSunshineTools();

  it('工具名与 ChillEast 完全一致', () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      'query_sunshine_departments',
      'submit_sunshine_letter',
    ]);
  });

  it('schema 合法：object + additionalProperties:false', () => {
    for (const tool of tools) {
      const schema = tool.inputSchema as {
        type?: string;
        additionalProperties?: boolean;
      };
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(typeof tool.handler).toBe('function');
    }
    const submit = tools.find((tool) => tool.name === 'submit_sunshine_letter');
    expect(submit?.inputSchema['required']).toEqual(['department', 'title', 'content']);
    expect(Object.keys(submit?.inputSchema['properties'] as object)).toContain('finishTime');
  });
});
