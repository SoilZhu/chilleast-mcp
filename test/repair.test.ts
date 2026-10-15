/**
 * 报修平台（bxpt）纯逻辑单元测试，覆盖移植时最容易出错的几处：JSON-RPC 响应的「纯 JSON /
 * base64 包裹 JSON / 批量数组」三种形态；日期与时间戳换算（接口给毫秒，表单要中国墙上时间）；
 * 工单 JSON 字段归一（分类、状态、处理人、部门…）；提交前字段清洗（日期字段、`{id}` 选择器）；
 * 图片入参（base64 / URL 安全校验）；工具名与别名。这些都是**没有真实账号也能验证**的部分，真正的网络链路见文件末尾。
 */

import { describe, expect, it } from 'vitest';
import { bytesToB64 } from '../src/util/bytes';
import {
  REPAIR_CATALOGS,
  canCancelRepairOrder,
  decodeImageBase64,
  decodeRpcResponse,
  extractRpcResult,
  formatChinaDate,
  formatChinaIso,
  isChoiceField,
  isDateField,
  isFetchableImageUrl,
  isUploadField,
  parseDateToTimestamp,
  parseRepairTime,
  resolveCatalogName,
  resolveRepairCatalog,
  sanitizeSubmitValues,
  toRepairOrder,
  type RepairField,
  type RepairForm,
} from '../src/school/hunau/bxpt';
import { createRepairTools } from '../src/tools/repair';

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

function b64(text: string): string {
  return bytesToB64(new TextEncoder().encode(text));
}

function field(partial: Partial<RepairField> & { name: string }): RepairField {
  return {
    label: partial.name,
    editor: 'input',
    required: false,
    hidden: false,
    readonly: false,
    referenceType: null,
    reference: null,
    dataType: '',
    ...partial,
  };
}

describe('decodeRpcResponse（JSON / base64 包裹 JSON）', () => {
  it('解析普通 JSON 响应', () => {
    const decoded = decodeRpcResponse('{"id":"1","jsonrpc":"2.0","result":{"ok":true}}');
    expect(decoded).toEqual({ id: '1', jsonrpc: '2.0', result: { ok: true } });
  });

  it('解析 base64 包裹的 JSON（HAR 里 /v2/workorder/data/getById 就是这种）', () => {
    const payload = { id: '1', jsonrpc: '2.0', result: { chljg: '已处理', scwttp: '1' } };
    const decoded = decodeRpcResponse(b64(JSON.stringify(payload)));
    expect(decoded).toEqual(payload);
  });

  it('base64 分支按 UTF-8 解码（中文不乱码）', () => {
    const payload = { result: { wtmsh: '宿舍水管漏水' } };
    const decoded = decodeRpcResponse(b64(JSON.stringify(payload)));
    expect(decoded).toEqual(payload);
  });

  it('空响应与 HTML 登录页都当作「暂时不可用」', () => {
    expect(() => decodeRpcResponse('   ')).toThrow('报修平台返回了空响应');
    expect(() => decodeRpcResponse('<!DOCTYPE html><html>登录</html>')).toThrow(
      '报修平台暂时不可用',
    );
  });
});

describe('extractRpcResult（result / error / 批量）', () => {
  it('取 result 字段', () => {
    expect(extractRpcResult({ id: '1', result: { data: [] } })).toEqual({ data: [] });
  });

  it('批量请求（数组）逐项取 result', () => {
    const batch = [
      { id: '1', result: { data: [1] } },
      { id: '2', result: { data: [2] } },
    ];
    expect(extractRpcResult(batch)).toEqual([{ data: [1] }, { data: [2] }]);
  });

  it('error 字段抛出业务错误（带服务端 message）', () => {
    expect(() => extractRpcResult({ error: { message: '工单不存在' } })).toThrow(
      '报修服务异常: 工单不存在',
    );
    expect(() => extractRpcResult({ error: '内部错误' })).toThrow('报修服务异常: 内部错误');
  });

  it('非对象结构一律拒绝', () => {
    expect(() => extractRpcResult('not-an-object')).toThrow('报修平台暂时不可用');
  });
});

describe('日期与时间戳', () => {
  it('parseDateToTimestamp 认毫秒数与数字字符串', () => {
    expect(parseDateToTimestamp(1790137000000)).toBe(1790137000000);
    expect(parseDateToTimestamp('1790137000000')).toBe(1790137000000);
    expect(parseDateToTimestamp(null)).toBeNull();
    expect(parseDateToTimestamp('   ')).toBeNull();
  });

  it('parseDateToTimestamp 把墙上时间按中国时区换算', () => {
    expect(parseDateToTimestamp('2026/09/23')).toBe(Date.UTC(2026, 8, 23) - CHINA_OFFSET_MS);
    // 带 T 的 ISO 串走 ISO 分支，时分秒保留
    expect(parseDateToTimestamp('2026-09-23T14:30:00')).toBe(
      Date.UTC(2026, 8, 23, 14, 30, 0) - CHINA_OFFSET_MS,
    );
  });

  it('空格分隔且带时分的串会丢掉时分 —— 与 Dart 行为一致（int.tryParse("14:30:00") 为 null）', () => {
    expect(parseDateToTimestamp('2026-09-23 14:30:00')).toBe(
      Date.UTC(2026, 8, 23, 0, 0, 0) - CHINA_OFFSET_MS,
    );
    expect(parseDateToTimestamp('2026/09/23 14:30:00')).toBe(
      Date.UTC(2026, 8, 23, 0, 0, 0) - CHINA_OFFSET_MS,
    );
  });

  it('parseDateToTimestamp 对带时区的 ISO 串不做偏移', () => {
    expect(parseDateToTimestamp('2026-09-23T06:00:00Z')).toBe(Date.UTC(2026, 8, 23, 6, 0, 0));
  });

  it('parseDateToTimestamp 解析不了就返回 null', () => {
    expect(parseDateToTimestamp('abc')).toBeNull();
    expect(parseDateToTimestamp('2026年9月')).toBeNull();
  });

  it('parseRepairTime 处理接口返回的毫秒与字符串时间', () => {
    expect(parseRepairTime(1790137000000)).toBe(1790137000000);
    expect(parseRepairTime('1790137000000')).toBe(1790137000000);
    expect(parseRepairTime('2026-09-23 01:35:00')).toBe(
      Date.UTC(2026, 8, 23, 1, 35, 0) - CHINA_OFFSET_MS,
    );
    expect(parseRepairTime('2026-09-23T01:35:00.000')).toBe(
      Date.UTC(2026, 8, 23, 1, 35, 0) - CHINA_OFFSET_MS,
    );
    expect(parseRepairTime(null)).toBeNull();
    expect(parseRepairTime({})).toBeNull();
  });

  it('格式化输出固定在中国时区', () => {
    // 2026-09-22T16:00:00Z == 中国时间 2026-09-23 00:00
    expect(formatChinaDate(Date.UTC(2026, 8, 22, 16, 0, 0))).toBe('2026/09/23');
    expect(formatChinaIso(Date.UTC(2026, 8, 22, 16, 30, 0))).toBe('2026-09-23T00:30:00+08:00');
  });
});

describe('分类解析', () => {
  it('resolveRepairCatalog 支持名称、关键词与兜底', () => {
    expect(resolveRepairCatalog('校园网络报修').title).toBe('校园网络报修');
    expect(resolveRepairCatalog('校园网').title).toBe('校园网络报修');
    expect(resolveRepairCatalog('wifi').title).toBe('校园网络报修');
    expect(resolveRepairCatalog('一卡通').title).toBe('一校通报修');
    expect(resolveRepairCatalog('业务系统报修').title).toBe('业务系统报修');
    expect(resolveRepairCatalog('随便什么').title).toBe('后勤报修');
  });

  it('resolveCatalogName 先认 UUID、再认关键词', () => {
    expect(
      resolveCatalogName({ service_catalog: { id: 'b4435ca0-99f6-11ec-bf7a-177427586306' } }),
    ).toBe('校园网络报修');
    expect(
      resolveCatalogName({ process: { id: '4e2cc26d-08b4-4cab-a3a7-fba23a23e11d' } }),
    ).toBe('后勤报修');
    expect(resolveCatalogName({ dynamic_title: '一校通刷卡异常' })).toBe('一校通报修');
    expect(resolveCatalogName({ dynamic_title: '教务业务系统登录不了' })).toBe('业务系统报修');
    expect(resolveCatalogName({ dynamic_title: '宿舍楼网络断了' })).toBe('校园网络报修');
    // 关键词都对不上时保留服务端给的名字（这里是空串），与 Dart 一致
    expect(resolveCatalogName({ dynamic_title: '教务系统登录不了' })).toBe('');
  });

  it('四大分类的 id / processId 与 Dart 常量一致', () => {
    expect(REPAIR_CATALOGS.map((catalog) => catalog.title)).toEqual([
      '后勤报修',
      '校园网络报修',
      '一校通报修',
      '业务系统报修',
    ]);
    expect(REPAIR_CATALOGS[0].id).toBe('5bbbaf0a-b7b7-11eb-b305-4bcc6b2984af');
    expect(REPAIR_CATALOGS[3].processId).toBe('f83a50f6-95f9-41d9-bf27-851f340035a4');
  });
});

describe('工单归一（RepairOrder.fromJson）', () => {
  const sample: Record<string, unknown> = {
    id: '427104e8-b705-11f1-97d1-d710569de0d5',
    code: 'WX202609230001',
    dynamic_title: '智慧湘农体育场馆预约异常',
    wtmsh: '取消预约失败，显示未查询到订单。',
    create_time: 1790137000000,
    start_time: 1790137000000,
    flow_status: { id: 'CLOSED', display_name: '已办结' },
    node_name: '结束',
    node_id: '718f69d5-819f-4921-9dfa-604ba3e2efee',
    service_catalog: { id: 'ffa62964-9539-11ec-a409-0f7763ad71f7', display_name: '业务系统报修' },
    process: { id: 'f83a50f6-95f9-41d9-bf27-851f340035a4', display_name: '业务系统报修流程' },
    actual_handler_department: { display_name: '信息与网络中心' },
    apply_user: { display_name: '张三' },
    lxfs: '13800000000',
    actual_handler: { display_name: '李工' },
    chljg: '已处理',
    bchshm: '补充说明',
    priority_group: { name: '2', display_name: '普通' },
    type: { id: 'ce75fee6-952f-11ec-a62b-c71d06e6a54f', name_path: '基础类.工单' },
    xgh: '202300010001',
  };

  it('逐字段映射正确', () => {
    const order = toRepairOrder(sample);
    expect(order.id).toBe('427104e8-b705-11f1-97d1-d710569de0d5');
    expect(order.code).toBe('WX202609230001');
    expect(order.title).toBe('智慧湘农体育场馆预约异常');
    expect(order.description).toBe('取消预约失败，显示未查询到订单。');
    expect(order.catalog).toBe('业务系统报修');
    expect(order.status).toBe('已办结');
    expect(order.statusId).toBe('CLOSED');
    expect(order.createdAtMs).toBe(1790137000000);
    expect(order.department).toBe('信息与网络中心');
    expect(order.applicant).toBe('张三');
    expect(order.phone).toBe('13800000000');
    expect(order.handler).toBe('李工');
    expect(order.handleResult).toBe('已处理');
    expect(order.supplement).toBe('补充说明');
    expect(order.priority).toBe('普通');
    expect(order.currentNode).toBe('结束');
    expect(order.raw).toBe(sample);
  });

  it('flow_status 缺失时退到 node_name / node_id', () => {
    const order = toRepairOrder({
      id: 'x',
      node_name: '受理中',
      node_id: 'node-1',
      apply_description: '水管漏水',
    });
    expect(order.status).toBe('受理中');
    expect(order.statusId).toBe('node-1');
    expect(order.description).toBe('水管漏水');
    // 分类认不出来时保留服务端给的名字（这里是空串）
    expect(order.catalog).toBe('');
  });

  it('描述优先取 wtmsh，其次 apply_description / description', () => {
    expect(toRepairOrder({ wtmsh: 'a', apply_description: 'b', description: 'c' }).description).toBe('a');
    expect(toRepairOrder({ apply_description: 'b', description: 'c' }).description).toBe('b');
    expect(toRepairOrder({ description: 'c' }).description).toBe('c');
  });

  it('canCancelRepairOrder 只看当前节点有没有「取消」动作', () => {
    const order = toRepairOrder({ id: 'x' }, {
      actions: [
        { id: 'a1', name: 'submit', displayName: '提交', possessorNode: 'n1' },
        { id: 'a2', name: 'cancel', displayName: '取消报修', possessorNode: 'n2' },
      ],
    });
    expect(canCancelRepairOrder(order)).toBe(true);
    expect(
      canCancelRepairOrder(
        toRepairOrder({ id: 'x' }, {
          actions: [{ id: 'a1', name: 'submit', displayName: '提交', possessorNode: 'n1' }],
        }),
      ),
    ).toBe(false);
  });
});

describe('表单字段判定（RepairField 的 getter）', () => {
  it('上传字段', () => {
    expect(isUploadField(field({ name: 'scwttp' }))).toBe(true);
    expect(isUploadField(field({ name: 'zjsmj' }))).toBe(true);
    expect(isUploadField(field({ name: 'f1', editor: 'upload' }))).toBe(true);
    expect(isUploadField(field({ name: 'f1', editor: 'input' }))).toBe(false);
  });

  it('选择器字段', () => {
    expect(isChoiceField(field({ name: 'f1', editor: 'lookup' }))).toBe(true);
    expect(isChoiceField(field({ name: 'f1', editor: 'reference' }))).toBe(true);
    expect(isChoiceField(field({ name: 'f1', editor: 'radiogroup' }))).toBe(true);
    expect(isChoiceField(field({ name: 'f1', editor: 'input' }))).toBe(false);
  });

  it('日期字段（编辑器 / dataType / 标签），但选择器优先排除', () => {
    expect(isDateField(field({ name: 'f1', editor: 'datepicker' }))).toBe(true);
    expect(isDateField(field({ name: 'f1', dataType: 'DATE' }))).toBe(true);
    expect(isDateField(field({ name: 'f1', label: '预约日期' }))).toBe(true);
    expect(isDateField(field({ name: 'applyDate' }))).toBe(true);
    expect(isDateField(field({ name: 'f1', label: '日期选择', editor: 'lookup' }))).toBe(false);
    expect(isDateField(field({ name: 'wtmsh', label: '问题描述' }))).toBe(false);
  });
});

describe('提交字段清洗（sanitizeSubmitValues）', () => {
  const form = {
    catalog: REPAIR_CATALOGS[0],
    instanceId: 'inst-1',
    ciType: 'type-1',
    nodeId: 'node-1',
    submitActionId: 'act-1',
    saveDraftActionId: null,
    formRuleId: null,
    fields: [
      field({ name: 'yyrq', editor: 'datepicker' }),
      field({ name: 'wtmsh', editor: 'textarea' }),
      field({ name: 'qy', editor: 'lookup' }),
    ],
    initialValues: {},
  } as RepairForm;

  it('日期字段转毫秒时间戳，空值保持 null', () => {
    const out = sanitizeSubmitValues(form, { yyrq: '2026/09/23', wtmsh: '漏水', empty: null });
    expect(out['yyrq']).toBe(Date.UTC(2026, 8, 23) - CHINA_OFFSET_MS);
    expect(sanitizeSubmitValues(form, { yyrq: '' })['yyrq']).toBeNull();
    expect(sanitizeSubmitValues(form, { yyrq: null })['yyrq']).toBeNull();
  });

  it('键名里带 date 的一律按日期处理', () => {
    const out = sanitizeSubmitValues(form, { some_date_field: '2026-09-23T14:30:00' });
    expect(out['some_date_field']).toBe(Date.UTC(2026, 8, 23, 14, 30, 0) - CHINA_OFFSET_MS);
  });

  it('选择器对象取 id', () => {
    const out = sanitizeSubmitValues(form, { qy: { id: 'qy-1', display_name: '东湖校区' } });
    expect(out['qy']).toBe('qy-1');
  });

  it('普通值原样保留', () => {
    const out = sanitizeSubmitValues(form, { wtmsh: '漏水', scwttp: 1, flag: true });
    expect(out).toMatchObject({ wtmsh: '漏水', scwttp: 1, flag: true });
  });
});

describe('图片入参', () => {
  it('isFetchableImageUrl 只放行公网 http/https', () => {
    expect(isFetchableImageUrl('https://example.com/a.jpg')).toBe(true);
    expect(isFetchableImageUrl('http://cdn.example.com/a.png')).toBe(true);
    expect(isFetchableImageUrl('ftp://example.com/a.png')).toBe(false);
    expect(isFetchableImageUrl('file:///etc/passwd')).toBe(false);
    expect(isFetchableImageUrl('not a url')).toBe(false);
    expect(isFetchableImageUrl('http://localhost/a.png')).toBe(false);
    expect(isFetchableImageUrl('http://127.0.0.1/a.png')).toBe(false);
    expect(isFetchableImageUrl('http://192.168.1.10/a.png')).toBe(false);
    expect(isFetchableImageUrl('http://10.0.0.8/a.png')).toBe(false);
    expect(isFetchableImageUrl('http://172.16.5.4/a.png')).toBe(false);
    expect(isFetchableImageUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
  });

  it('decodeImageBase64 支持 data URL 前缀', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const image = decodeImageBase64(`data:image/png;base64,${bytesToB64(png)}`, 'repair-1');
    expect(image.bytes).toEqual(png);
    expect(image.contentType).toBe('image/png');
    expect(image.fileName).toBe('repair-1.png');
  });

  it('decodeImageBase64 无前缀时按 jpeg 处理', () => {
    const raw = new Uint8Array([1, 2, 3, 4, 5]);
    const image = decodeImageBase64(bytesToB64(raw), 'repair-2');
    expect(image.bytes).toEqual(raw);
    expect(image.contentType).toBe('image/jpeg');
    expect(image.fileName).toBe('repair-2');
  });

  it('空值与非法 base64 报错', () => {
    expect(() => decodeImageBase64('', 'x')).toThrow('imageBase64 为空');
    expect(() => decodeImageBase64('!!!not-base64!!!', 'x')).toThrow('不是合法的 base64');
  });
});

describe('工具定义', () => {
  const tools = createRepairTools();

  it('工具名与 ChillEast 完全一致，且包含 query_repairs 的别名', () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      'query_repairs',
      'query_repair_orders',
      'query_repair_detail',
      'submit_repair_order',
      'cancel_repair_order',
    ]);
  });

  it('别名与 query_repairs 是同一个实现', () => {
    const primary = tools.find((tool) => tool.name === 'query_repairs');
    const alias = tools.find((tool) => tool.name === 'query_repair_orders');
    expect(alias?.handler).toBe(primary?.handler);
    expect(alias?.inputSchema).toBe(primary?.inputSchema);
  });

  it('schema 合法：object + additionalProperties:false + 中文描述', () => {
    for (const tool of tools) {
      const schema = tool.inputSchema as {
        type?: string;
        additionalProperties?: boolean;
        properties?: Record<string, unknown>;
      };
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(typeof tool.handler).toBe('function');
    }
    const submit = tools.find((tool) => tool.name === 'submit_repair_order');
    expect(Object.keys(submit?.inputSchema['properties'] as object)).toContain('imageBase64');
    expect(Object.keys(submit?.inputSchema['properties'] as object)).toContain('imageUrl');
    // 本地路径入参已被服务端方案取代
    expect(Object.keys(submit?.inputSchema['properties'] as object)).not.toContain('image_path');
    expect(submit?.inputSchema['required']).toEqual(['catalog', 'description']);
    expect(tools.find((tool) => tool.name === 'cancel_repair_order')?.inputSchema['required']).toEqual([
      'order_id',
    ]);
  });
});
