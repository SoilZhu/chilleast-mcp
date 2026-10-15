/**
 * 报修平台（bxpt.hunau.edu.cn）客户端：CAS 换会话后走 JSON-RPC 报修接口。
 *
 * - 会话：先打 `/v2/login/isAuthenticated`，无会话则用 SSO 的 TGC 经 `exchangeCasTicket`
 *   换 CAS 票据。⚠️ 回跳是 `http://bxpt.hunau.edu.cn/...`，浏览器靠 HSTS 升级，fetch 不会。
 * - 业务调用都是 `POST /relax/mobile/rpc?p=<method>&t=<毫秒>`，body 是 JSON-RPC 2.0：
 *   `{jsonrpc, method, id:'1', params}`；响应可能是纯 JSON，也可能是 base64 包裹的 JSON
 *   （如 `content.encoding=base64`），批量请求返回数组、要逐项取 `result` —— 照抄 Dart。
 * - 与 Dart 的差异：附件不读本地文件，改由工具层传字节；multipart 用 Workers `FormData`。
 * - 未经真实账号验证：仅登录链与 `getById` 在 HAR 里出现过，其余业务方法未线上实测。
 */

import { decodeBody } from '../../auth/http';
import type { CookieSession } from '../../auth/http';
import { SessionExpiredError } from '../../auth/session-manager';
import { b64ToBytes } from '../../util/bytes';
import { exchangeCasTicket, looksLikeLoginPage } from './cas';
import { HOSTS, URLS } from './constants';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const BXPT_HOST = new URL(HOSTS.bxpt).hostname;

/** CAS 子系统入口：从 `URLS.bxptSso` 的 service 参数里取，保证与常量同源。 */
const BXPT_SERVICE_URL =
  new URL(URLS.bxptSso).searchParams.get('service') ?? `${HOSTS.bxpt}/relax/sso/cas/login`;

/** 各接口共用的头部（Dart `_rpcRaw` / `uploadAttachment`）。 */
const RPC_HEADERS = {
  Origin: HOSTS.bxpt,
  Referer: URLS.bxptIndex,
  'X-Requested-With': 'XMLHttpRequest',
  'X-User-Lang': 'zh-CN',
  Accept: '*/*',
};

/** 工单列表接口第一个固定参数（Dart 里写死的租户/应用 id）。 */
const WORKORDER_APP_ID = '37ea4a70-af77-4c1a-9422-7582afc0de41';

/** 流转日志 CI 类型与关系类型（Dart `uploadAttachment` / `fetchOrderDetail`）。 */
const ACTIVITY_LOG_CI_TYPE = '737fb2a0-a9a5-41fd-b36f-d32d604e2128';
const ACTIVITY_LOG_RELATION_TYPE = '42e2bb1d-2d74-4cc7-a53b-ba5413b14792';

/** 单张图片上限（Workers 内存 128MB，这里留足余量）。 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 20_000;

/** 中国标准时间偏移：接口里的墙上时间、以及 Dart 设备时区都按这个解释。 */
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface RepairCatalog {
  id: string;
  title: string;
  subtitle: string;
  department: string;
  processId: string;
}

/** 四大报修分类，与 Dart `RepairService.catalogs` 逐字段一致。 */
export const REPAIR_CATALOGS: readonly RepairCatalog[] = [
  {
    id: '5bbbaf0a-b7b7-11eb-b305-4bcc6b2984af',
    title: '后勤报修',
    subtitle: '宿舍、公共设施与生活服务',
    department: '后勤保障中心',
    processId: '4e2cc26d-08b4-4cab-a3a7-fba23a23e11d',
  },
  {
    id: 'b4435ca0-99f6-11ec-bf7a-177427586306',
    title: '校园网络报修',
    subtitle: '无线网络、网线与校园网故障',
    department: '信息与网络中心',
    processId: 'd86a31ef-6e54-4da5-8c8f-a881986ec422',
  },
  {
    id: 'f11e3e78-9ace-11ec-9f07-f7b2f4ca88d7',
    title: '一校通报修',
    subtitle: '一卡通、数字校园与信息化设备',
    department: '信息与网络中心',
    processId: 'aa21a42a-a2f7-48a7-aae6-fc374e4ebc44',
  },
  {
    id: 'ffa62964-9539-11ec-a409-0f7763ad71f7',
    title: '业务系统报修',
    subtitle: '教务、门户及其他业务系统',
    department: '信息与网络中心',
    processId: 'f83a50f6-95f9-41d9-bf27-851f340035a4',
  },
];

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** Dart 的 `pickString`：Map 取 display_name/name/name_path，其余 toString().trim()。 */
function pickDisplay(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (isRecord(value)) return str(value['display_name'] ?? value['name'] ?? value['name_path']);
  return String(value).trim();
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

/** epoch 毫秒 -> 中国时区的 `YYYY/MM/DD`（Dart 用设备本地时间格式化）。 */
export function formatChinaDate(epochMs: number): string {
  const date = new Date(epochMs + CHINA_OFFSET_MS);
  return `${date.getUTCFullYear()}/${pad2(date.getUTCMonth() + 1)}/${pad2(date.getUTCDate())}`;
}

/** epoch 毫秒 -> 中国时区的 ISO 8601（带 +08:00，避免服务端 UTC 造成歧义）。 */
export function formatChinaIso(epochMs: number): string {
  const date = new Date(epochMs + CHINA_OFFSET_MS);
  return (
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}` +
    `T${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}+08:00`
  );
}

/** 严格整数解析（对应 Dart `int.tryParse`，`23T10:00` 这种必须判负）。 */
function strictInt(text: string): number | null {
  const trimmed = text.trim();
  return /^-?\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
}

/** 解析带/不带时区的 ISO 字符串；不带时区的按中国墙上时间。 */
function parseIsoChina(text: string): number | null {
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized);
  const parsed = Date.parse(hasZone ? normalized : `${normalized}Z`);
  if (Number.isNaN(parsed)) return null;
  return hasZone ? parsed : parsed - CHINA_OFFSET_MS;
}

/**
 * 提交表单时的日期归一（Dart `RepairService.parseDateToTimestamp`）。
 * 支持毫秒数、`YYYY/MM/DD`、`YYYY-MM-DD`、ISO 串。
 * 不带时区的按中国墙上时间换算成 epoch —— 与 Dart 设备在 UTC+8 的行为一致。
 *
 * ⚠️ 照抄 Dart 的一个怪癖：它按 `[/ -]` 切分，所以「空格分隔且带时分」的
 * `2026-09-23 14:30:00` 里 `14:30:00` 会整块留给 `int.tryParse` 并失败，
 * 最终时分被丢弃（只取到当天 0 点）。带 `T` 的 ISO 串不受影响。
 * 报修表单的预约字段本来就是日期粒度，这里保持与 Dart 一致而不"顺手修好"。
 */
export function parseDateToTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  const text = String(value).trim();
  if (text === '') return null;

  const asInt = strictInt(text);
  if (asInt !== null) return asInt;

  const parts = text.split(/[/ -]/);
  if (parts.length >= 3) {
    const year = strictInt(parts[0]);
    const month = strictInt(parts[1]);
    const day = strictInt(parts[2]);
    if (year !== null && month !== null && day !== null) {
      const hour = parts.length >= 4 ? (strictInt(parts[3]) ?? 0) : 0;
      const minute = parts.length >= 5 ? (strictInt(parts[4]) ?? 0) : 0;
      const second = parts.length >= 6 ? (strictInt(parts[5]) ?? 0) : 0;
      const epoch = Date.UTC(year, month - 1, day, hour, minute, second);
      return Number.isNaN(epoch) ? null : epoch - CHINA_OFFSET_MS;
    }
  }
  return parseIsoChina(text.replace(/\//g, '-'));
}

/** 接口返回的时间字段（Dart `RepairOrder.fromJson` 里的局部 `date()`）。 */
export function parseRepairTime(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  const asInt = strictInt(text);
  if (asInt !== null) return asInt;
  return parseIsoChina(text);
}

// ---------------------------------------------------------------------------
// JSON-RPC 传输层
// ---------------------------------------------------------------------------

/**
 * 解开 RPC 响应体：先当 JSON 解，失败再当 **base64 包裹的 JSON** 解。
 * 两种情况 Dart 都遇到过（HAR 里 `/v2/workorder/data/getById` 就是 base64）。
 */
export function decodeRpcResponse(body: string): unknown {
  const trimmed = body.trim();
  if (trimmed === '') throw new Error('报修平台返回了空响应，请稍后重试');

  try {
    return JSON.parse(trimmed);
  } catch {
    // 落到 base64 分支
  }
  try {
    return JSON.parse(new TextDecoder('utf-8').decode(b64ToBytes(trimmed)));
  } catch {
    throw new Error('报修平台暂时不可用，请稍后重试');
  }
}

/**
 * 从解开的响应里取 `result`（Dart `_rpcRaw` 的后半段）：
 *  - 数组（批量请求）-> 逐项取 `result`
 *  - 对象含 `error` -> 抛业务错误
 *  - 其它 -> 抛「暂时不可用」
 */
export function extractRpcResult(decoded: unknown): unknown {
  if (Array.isArray(decoded)) {
    return decoded.map((item) => (isRecord(item) ? item['result'] : item));
  }
  if (!isRecord(decoded)) throw new Error('报修平台暂时不可用，请稍后重试');

  const error = decoded['error'];
  if (error !== undefined && error !== null) {
    const message = isRecord(error)
      ? str(error['message'] ?? error['data'] ?? '')
      : String(error);
    throw new Error(
      message !== '' ? `报修服务异常: ${message}` : '报修平台暂时不可用，请稍后重试',
    );
  }
  return decoded['result'];
}

/** 发一次 RPC（模块级，便于建会话阶段复用）。 */
async function rpcCall(
  session: CookieSession,
  path: string,
  params: unknown,
): Promise<unknown> {
  // 路径全部来自本文件的常量，不含需要转义的字符；照抄 HAR 里 `p=/v2/...` 的原始形式
  const url = `${URLS.bxptRpc}?p=${path}&t=${Date.now()}`;
  const response = await session.postJson(
    url,
    { jsonrpc: '2.0', method: path, id: '1', params },
    { headers: RPC_HEADERS, referer: URLS.bxptIndex },
  );

  // 被踢回统一认证页 = 会话失效（交给 runWithSession 重登）
  if (response.status >= 400 || looksLikeLoginPage(response)) {
    throw new SessionExpiredError('报修平台会话已失效');
  }
  return extractRpcResult(decodeRpcResponse(response.body));
}

/** 取 bxpt 自己的用户 id（`/v2/login/isAuthenticated` 的 `id`）；未登录返回 ''。 */
async function fetchBxptUserId(session: CookieSession): Promise<string> {
  const result = await rpcCall(session, '/v2/login/isAuthenticated', null);
  if (!isRecord(result) || result['id'] === null || result['id'] === undefined) return '';
  return str(result['id']);
}

// ---------------------------------------------------------------------------
// 数据模型（对应 repair_models.dart）
// ---------------------------------------------------------------------------

export interface RepairField {
  name: string;
  label: string;
  editor: string;
  required: boolean;
  hidden: boolean;
  readonly: boolean;
  referenceType: string | null;
  reference: string | null;
  /** `raw['dataType']`，用于识别 DATE 字段 */
  dataType: string;
}

export interface RepairAction {
  id: string;
  name: string;
  displayName: string;
  possessorNode: string;
}

/** 选择器候选项（Dart `RepairChoice`）。 */
export interface RepairChoice {
  id: string;
  label: string;
}

export interface RepairAttachment {
  id: string;
  fileName: string;
  downloadUrl: string;
  thumbnailUrl: string | null;
  createTimeMs: number | null;
}

export interface RepairActivityLog {
  id: string;
  description: string;
  userName: string;
  timeMs: number | null;
}

export interface RepairOrder {
  id: string;
  code: string;
  title: string;
  description: string;
  catalog: string;
  status: string;
  statusId: string;
  createdAtMs: number | null;
  closedAtMs: number | null;
  department: string;
  applicant: string;
  applicantDepartment: string;
  phone: string;
  handler: string;
  handlerDepartment: string;
  handleResult: string;
  userResponse: string;
  score: number | null;
  supplement: string;
  priority: string;
  currentNode: string;
  logs: RepairActivityLog[];
  attachments: RepairAttachment[];
  actions: RepairAction[];
  raw: Record<string, unknown>;
}

export interface RepairForm {
  catalog: RepairCatalog;
  instanceId: string;
  ciType: string;
  nodeId: string;
  submitActionId: string;
  saveDraftActionId: string | null;
  formRuleId: string | null;
  fields: RepairField[];
  initialValues: Record<string, unknown>;
}

/** 待上传的图片（服务端没有本地文件，改为内存字节）。 */
export interface RepairImage {
  bytes: Uint8Array;
  fileName: string;
  contentType: string;
}

export function isUploadField(field: RepairField): boolean {
  return (
    field.editor === 'upload' ||
    field.editor === 'image' ||
    field.editor === 'file' ||
    field.name === 'scwttp' ||
    field.name === 'uploadimage' ||
    field.name === 'zjsmj'
  );
}

export function isChoiceField(field: RepairField): boolean {
  return (
    field.editor === 'lookup' ||
    field.editor === 'reference' ||
    field.editor === 'radiogroup' ||
    field.editor === 'priority'
  );
}

export function isDateField(field: RepairField): boolean {
  if (
    field.editor === 'datepicker' ||
    field.editor === 'datetimepicker' ||
    field.editor === 'date' ||
    field.dataType === 'DATE'
  ) {
    return true;
  }
  if (isChoiceField(field)) return false;
  return field.label.includes('日期') || field.name.toLowerCase().includes('date');
}

function toAction(value: Record<string, unknown>): RepairAction {
  return {
    id: str(value['id']),
    name: str(value['name']),
    displayName: str(value['display_name'] ?? value['name']),
    possessorNode: str(value['possessor']),
  };
}

function isCancelAction(action: RepairAction): boolean {
  return action.displayName.includes('取消') || action.name.includes('取消');
}

function toAttachment(value: Record<string, unknown>): RepairAttachment {
  const id = str(value['id']);
  const thumb = value['thumbnail'] === null || value['thumbnail'] === undefined
    ? ''
    : String(value['thumbnail']);
  const name = str(value['upload_file_name'] ?? value['display_name'] ?? '附件');
  return {
    id,
    fileName: name === '' ? '附件' : name,
    downloadUrl: `${HOSTS.bxpt}/relax/mobile/rpc?method=/v2/file/download&id=${id}`,
    thumbnailUrl:
      thumb === ''
        ? null
        : thumb.startsWith('http')
          ? thumb
          : `${HOSTS.bxpt}/relax/mobile/${thumb}`,
    createTimeMs: parseRepairTime(value['create_time']),
  };
}

function toActivityLog(value: Record<string, unknown>): RepairActivityLog {
  const user = value['create_user'] ?? value['modify_user'];
  const userName = isRecord(user)
    ? str(user['display_name'] ?? user['name'])
    : str(user);
  return {
    id: str(value['id']),
    description: str(value['description']),
    userName,
    timeMs: parseRepairTime(value['create_time'] ?? value['modify_time']),
  };
}

/**
 * 分类名归一（Dart `RepairOrder.fromJson` 里那串 if/else）：
 * 先认 catalogId / processId 两个 UUID，再退化成关键词匹配。
 */
export function resolveCatalogName(json: Record<string, unknown>): string {
  const catalogRaw = json['service_catalog'];
  const catalogId = isRecord(catalogRaw) ? str(catalogRaw['id']) : '';
  const catalogName = pickDisplay(catalogRaw);

  const processRaw = json['process'];
  const processId = isRecord(processRaw) ? str(processRaw['id']) : '';
  const typeRaw = json['type'];
  const typeName = isRecord(typeRaw)
    ? str(typeRaw['name_path'] ?? typeRaw['display_name'])
    : str(typeRaw);
  const dynamicTitle = str(json['dynamic_title'] ?? json['title']);
  const candidate = `${catalogName} ${catalogId} ${processId} ${typeName} ${dynamicTitle}`;

  for (const catalog of REPAIR_CATALOGS) {
    if (catalogId === catalog.id || processId === catalog.processId) return catalog.title;
  }
  if (candidate.includes('后勤')) return '后勤报修';
  if (candidate.includes('网络') || candidate.includes('校园网')) return '校园网络报修';
  if (candidate.includes('一校通') || candidate.includes('一卡通')) return '一校通报修';
  if (candidate.includes('业务') || candidate.includes('信息系统')) return '业务系统报修';
  return catalogName;
}

function pickDescription(json: Record<string, unknown>): string {
  for (const key of ['wtmsh', 'apply_description', 'description']) {
    const value = json[key];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text !== '') return text;
  }
  return '';
}

/** `RepairOrder.fromJson` 的移植。 */
export function toRepairOrder(
  json: Record<string, unknown>,
  extras: {
    logs?: RepairActivityLog[];
    attachments?: RepairAttachment[];
    actions?: RepairAction[];
  } = {},
): RepairOrder {
  const flow = json['flow_status'];
  const process = json['process'];
  const handlerDept = json['actual_handler_department'];
  const applyUser = json['apply_user'];
  const applyDept = json['apply_department'];
  const actualHandler = json['actual_handler'];
  const priority = json['priority_group'];

  const flowLabel = pickDisplay(flow);
  const score = json['score'];

  return {
    id: str(json['id']),
    code: str(json['code']),
    title: str(json['dynamic_title'] ?? json['title']),
    description: pickDescription(json),
    catalog: resolveCatalogName(json),
    status: flowLabel !== '' ? flowLabel : str(json['node_name']),
    statusId: isRecord(flow)
      ? str(flow['id'] ?? flow['name'])
      : str(json['node_id']),
    createdAtMs: parseRepairTime(json['create_time'] ?? json['start_time']),
    closedAtMs: parseRepairTime(json['close_time'] ?? json['complete_time']),
    department:
      pickDisplay(handlerDept) !== '' ? pickDisplay(handlerDept) : pickDisplay(process),
    applicant:
      pickDisplay(applyUser) !== '' ? pickDisplay(applyUser) : str(json['xm']),
    applicantDepartment: pickDisplay(applyDept),
    phone: str(json['lxfs'] ?? json['phone']),
    handler: pickDisplay(actualHandler),
    handlerDepartment: pickDisplay(handlerDept),
    handleResult: str(json['chljg']),
    userResponse: str(json['user_response']),
    score: typeof score === 'number' ? score : null,
    supplement: str(json['bchshm']),
    priority: pickDisplay(priority),
    currentNode: str(json['node_name']),
    logs: extras.logs ?? [],
    attachments: extras.attachments ?? [],
    actions: extras.actions ?? [],
    raw: json,
  };
}

export function repairOrderCatalogId(order: RepairOrder): string {
  return isRecord(order.raw['service_catalog']) ? str(order.raw['service_catalog']['id']) : '';
}

/** 工单的 CI 类型 id：`type.id`，其次 `type` 本身，再退到 `workorder_type`。 */
function repairOrderTypeId(order: RepairOrder): string {
  const typeRaw = order.raw['type'];
  if (isRecord(typeRaw)) return str(typeRaw['id']);
  return str(typeRaw ?? order.raw['workorder_type']);
}

export function canCancelRepairOrder(order: RepairOrder): boolean {
  return order.actions.some(isCancelAction);
}

/** 分类模糊匹配（Dart `RepairSubmitTool` 里的 firstWhere + orElse）。 */
export function resolveRepairCatalog(input: string): RepairCatalog {
  const text = input.trim();
  const exact = REPAIR_CATALOGS.find(
    (catalog) =>
      catalog.title === text || text.includes(catalog.title) || catalog.title.includes(text),
  );
  if (exact !== undefined) return exact;

  if (text.includes('网') || text.toLowerCase().includes('wifi')) {
    return REPAIR_CATALOGS[1];
  }
  if (text.includes('卡') || text.includes('一校通')) {
    return REPAIR_CATALOGS[2];
  }
  if (text.includes('系统') || text.includes('软件')) {
    return REPAIR_CATALOGS[3];
  }
  return REPAIR_CATALOGS[0];
}

// ---------------------------------------------------------------------------
// 图片入参（替代 Dart 的设备文件路径）
// ---------------------------------------------------------------------------

/** 只允许 http/https，且拒绝回环与内网地址（URL 由模型给出，避免被当成 SSRF 跳板）。 */
export function isFetchableImageUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host === '[::1]' || host === '::1') return false;
  if (/^(127|10|169\.254|0)\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

/** 解析 base64（可带 `data:image/png;base64,` 前缀）。 */
export function decodeImageBase64(input: string, fallbackName: string): RepairImage {
  const match = /^data:([\w./+-]+);base64,(.*)$/s.exec(input.trim());
  const contentType = match === null ? 'image/jpeg' : match[1];
  const payload = match === null ? input.trim() : match[2];
  if (payload === '') throw new Error('imageBase64 为空');

  let bytes: Uint8Array;
  try {
    bytes = b64ToBytes(payload);
  } catch {
    throw new Error('imageBase64 不是合法的 base64 内容');
  }
  if (bytes.byteLength === 0) throw new Error('imageBase64 解码后为空');
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('现场图片过大（上限 6MB）');

  const fromDataUrl = match === null ? '' : extensionOf(contentType);
  return {
    bytes,
    fileName: fromDataUrl === '' ? fallbackName : `${fallbackName}${fromDataUrl}`,
    contentType,
  };
}

function extensionOf(contentType: string): string {
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('gif')) return '.gif';
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('heic')) return '.heic';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg';
  return '';
}

/** 下载图片（工具层 `imageUrl` 入参）。 */
export async function downloadImage(url: string, fileName: string): Promise<RepairImage> {
  if (!isFetchableImageUrl(url)) {
    throw new Error('imageUrl 必须是可公开访问的 http/https 图片地址');
  }
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`下载现场图片失败：${reason}`);
  }
  if (!response.ok) {
    throw new Error(`下载现场图片失败（HTTP ${response.status}）`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) throw new Error('imageUrl 指向的内容为空');
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error('现场图片过大（上限 6MB）');

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
  const extension = extensionOf(contentType);
  return {
    bytes: new Uint8Array(buffer),
    fileName: extension === '' || fileName.includes('.') ? fileName : `${fileName}${extension}`,
    contentType: contentType === '' ? 'image/jpeg' : contentType,
  };
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export interface RepairAccount {
  /** 报修平台自己的用户 id（工单过滤条件用它） */
  userId: string;
  /** 姓名（`xm` / 附件日志用） */
  realName: string;
  /** 学工号（`xgh` 用） */
  username: string;
}

export interface FetchOrdersOptions {
  /** true=处理中，false=已完成/草稿（配合 isDraft） */
  ongoing: boolean;
  isDraft?: boolean;
  pageIndex?: number;
  pageSize?: number;
}

export class RepairClient {
  constructor(
    private readonly session: CookieSession,
    readonly account: RepairAccount,
  ) {}

  /** 原始 RPC（业务调用）。 */
  async rpc(path: string, params: unknown): Promise<unknown> {
    return await rpcCall(this.session, path, params);
  }

  /** 工单列表（Dart `fetchOrders`，三种过滤条件逐字段对应）。 */
  async fetchOrders(options: FetchOrdersOptions): Promise<RepairOrder[]> {
    const { ongoing, isDraft = false } = options;
    const pageIndex = options.pageIndex ?? 1;
    const pageSize = options.pageSize ?? 10;
    const userId = this.account.userId;

    let method: string;
    let attributes: string[];
    let filter: Record<string, unknown>;
    let orders: Array<Record<string, string>>;

    if (isDraft) {
      method = '/v2/workorder/data/officePage';
      attributes = [
        'id', 'type', 'code', 'service_catalog', 'apply_user', 'apply_description',
        'flow_status', 'create_time', 'classify', 'dynamic_title', 'start_time', 'modify_time',
      ];
      filter = {
        attribute: {
          and: [
            { simple: { name: 'flow_status', operator: 'eq', value: 'NEW' } },
            { simple: { name: 'create_user', operator: 'eq', value: userId } },
          ],
        },
        query: '',
      };
      orders = [{ name: 'create_time', type: 'desc' }];
    } else if (ongoing) {
      method = '/v2/service/portal/workorderData/ongoingPage';
      attributes = [
        'id', 'type', 'code', 'service_catalog', 'apply_user', 'apply_description',
        'flow_status', 'create_time', 'start_time', 'process', 'process_instance_id',
        'classify', 'dynamic_title',
      ];
      filter = {
        attribute: {
          and: [
            { simple: { name: 'id', operator: 'in-lookup', value: ['0', '1'] } },
            {
              or: [
                { simple: { name: 'apply_user', operator: 'eq', value: userId } },
                { simple: { name: 'create_user', operator: 'eq', value: userId } },
              ],
            },
          ],
        },
        query: '',
      };
      orders = [{ name: 'start_time', type: 'desc' }];
    } else {
      method = '/v2/service/portal/workorderData/finishPage';
      attributes = [
        'id', 'type', 'code', 'node_id', 'node_name', 'service_catalog', 'apply_description',
        'flow_status', 'start_time', 'create_time', 'close_time', 'process',
        'process_instance_id', 'classify', 'dynamic_title',
      ];
      filter = {
        attribute: {
          and: [
            {
              and: [
                {
                  or: [
                    { simple: { name: 'flow_status', operator: 'ne', value: 'NEW' } },
                    { simple: { name: 'flow_status', operator: 'isnull' } },
                  ],
                },
                { simple: { name: 'apply_user', operator: 'eq', value: userId } },
              ],
            },
            { simple: { name: 'close_time', operator: 'isnotnull' } },
          ],
        },
        query: '',
      };
      orders = [{ name: 'start_time', type: 'desc' }];
    }

    const result = await this.rpc(method, [
      WORKORDER_APP_ID,
      {
        attributes,
        filter,
        orders,
        pageSize: String(pageSize),
        pageIndex: String(pageIndex),
      },
    ]);
    const data = isRecord(result) ? result['data'] : null;
    if (!Array.isArray(data)) return [];
    return data.filter(isRecord).map((item) => toRepairOrder(item));
  }

  /** CI 引用候选（Dart `references`）：page 接口不支持的旧环境回落到 list。 */
  async references(type: string, query = ''): Promise<RepairChoice[]> {
    let result: unknown;
    try {
      result = await this.rpc('/v2/cmdb/ci/page', [
        type,
        {
          pageSize: 100,
          pageIndex: 1,
          orders: [{ name: 'display_name', type: 'asc' }],
          filter: { query },
        },
      ]);
    } catch {
      try {
        result = await this.rpc('/v2/cmdb/ci/list', [
          type,
          {
            attributes: ['id', 'display_name', 'name'],
            orders: [{ name: 'display_name', type: 'asc' }],
            filter: {},
          },
        ]);
      } catch {
        return [];
      }
    }

    const list = isRecord(result) && Array.isArray(result['data'])
      ? result['data']
      : Array.isArray(result)
        ? result
        : [];

    return list
      .filter(isRecord)
      .map((item) => ({
        id: str(item['id']),
        label: str(item['display_name'] ?? item['name']),
      }))
      .filter((choice) => choice.id !== '' && choice.label !== '')
      .slice(0, 100);
  }

  /** 字典项候选（Dart `lookup`）。 */
  async lookup(lookupType: string, notInNames?: readonly string[]): Promise<RepairChoice[]> {
    try {
      const andList: Array<Record<string, unknown>> = [
        { simple: { name: 'lookup_type', operator: 'eq', value: lookupType } },
      ];
      if (notInNames !== undefined && notInNames.length > 0) {
        andList.push({
          simple: { name: 'name', operator: 'notin', value: [...notInNames] },
        });
      }

      const result = await this.rpc('/v2/cmdb/meta/lookup/page', [
        {
          orders: [{ name: 'index', type: 'asc' }],
          filter: { attribute: { and: andList }, query: '' },
          pageSize: 20,
          pageIndex: 1,
        },
      ]);
      const data = isRecord(result) ? result['data'] : null;
      if (!Array.isArray(data)) return [];
      return data
        .filter(isRecord)
        .map((item) => ({
          id: str(item['name'] ?? item['id']),
          label: str(item['display_name'] ?? item['name']),
        }))
        .filter((choice) => choice.id !== '');
    } catch {
      return [];
    }
  }

  /** 按字段配置取候选项（reference 优先，其次 lookup 字典）。 */
  async choicesForField(field: RepairField): Promise<RepairChoice[]> {
    if (field.reference !== null) return await this.references(field.reference);
    if (field.referenceType !== null) return await this.lookup(field.referenceType);
    return [];
  }

  /** 载入填报表单（Dart `loadForm`）。 */
  async loadForm(catalog: RepairCatalog): Promise<RepairForm> {
    const instanceId = await this.rpc('/v2/cmdb/ci/id', []);
    const detail = await this.rpc('/v2/workorder/serviceitem/card/getMobileCatalogById', [
      catalog.id,
    ]);
    const formResult = await this.rpc('/v2/workorder/view/form/getNotRelationOrderForm', [
      catalog.id,
      'apply',
      { create_user: null, id: str(instanceId), service_catalog: catalog.id },
    ]);
    const nodeId = await this.rpc('/v2/workorder/orderConfig/getNodeByServiceCatalog', [
      catalog.id,
    ]);
    const actions = await this.rpc('/v2/workorder/action/list', [str(nodeId), '']);

    const form =
      Array.isArray(formResult) && formResult.length > 0 && isRecord(formResult[0])
        ? formResult[0]
        : null;
    // Dart 直接 jsonDecode(constructData)，字段异常时会整条链失败；这里降级成 {}
    const construct = form === null ? {} : parseConstructData(form['constructData']);

    const detailType =
      isRecord(detail) && isRecord(detail['type']) ? str(detail['type']['id']) : '';
    const ciType = str(construct['ciType'] ?? detailType);
    const components = Array.isArray(construct['components']) ? construct['components'] : [];

    const fields: RepairField[] = [];
    for (const component of components) {
      const field = toField(component);
      if (field !== null) fields.push(field);
    }

    const actionList = Array.isArray(actions) ? actions.filter(isRecord) : [];
    const submit = actionList.find(
      (action) => str(action['name']) === '提交' || str(action['display_name']) === '提交',
    );
    const draft = actionList.find(
      (action) =>
        str(action['name']).includes('草稿') || str(action['display_name']).includes('草稿'),
    );
    const rules = construct['rules'];
    const rule =
      Array.isArray(rules) && rules.length > 0 && isRecord(rules[0])
        ? str(rules[0]['rule_id'])
        : '';

    return {
      catalog,
      instanceId: str(instanceId),
      ciType,
      nodeId: str(nodeId),
      submitActionId: submit === undefined ? '' : str(submit['id']),
      saveDraftActionId:
        draft === undefined || str(draft['id']) === '' ? null : str(draft['id']),
      formRuleId: rule === '' ? null : rule,
      fields,
      initialValues: {
        id: str(instanceId),
        type: ciType,
        source: 'mobile',
        priority_group: '2',
        apply_user: this.account.userId,
        xm: this.account.realName,
        xgh: this.account.username,
      },
    };
  }

  /** 提交/存草稿（Dart `submit`）。 */
  async submit(form: RepairForm, values: Record<string, unknown>, isDraft = false): Promise<void> {
    const actionId = isDraft
      ? (form.saveDraftActionId ?? form.submitActionId)
      : form.submitActionId;

    const data: Record<string, unknown> = { ...form.initialValues };
    for (const field of form.fields) {
      if (!(field.name in data)) {
        data[field.name] = isUploadField(field) ? 0 : null;
      }
    }
    Object.assign(data, values);
    const sanitized = sanitizeSubmitValues(form, data);

    const params: unknown[] = [
      actionId,
      [
        { id: form.instanceId, type: form.ciType, node: form.nodeId },
        sanitized,
        { service_catalog: form.catalog.id },
      ],
    ];
    if (form.formRuleId !== null) params.push([form.formRuleId]);

    const result = await this.rpc('/v2/workorder/action/executeWithValidate', params);
    if (isRecord(result) && result['state'] === true) return;
    throw new Error(isDraft ? '保存草稿失败，请稍后重试' : '提交失败，请检查必填项后重试');
  }

  /**
   * 上传附件并写流转日志（Dart `uploadAttachment`）。
   * 服务端没有文件系统，字节由工具层给出。
   */
  async uploadAttachment(
    form: RepairForm,
    fieldName: string,
    image: RepairImage,
  ): Promise<RepairAttachment> {
    // Dart: `?tm=<ms>&method=/v2/file/upload`（注意这个端点用 method 而不是 p）
    const url = `${URLS.bxptRpc}?tm=${Date.now()}&method=/v2/file/upload`;
    const body = new FormData();
    body.append(
      'uploadFile',
      new File([image.bytes], image.fileName, { type: image.contentType }),
      image.fileName,
    );
    body.append('fileName', 'uploadFile');
    body.append('subsystem', 'eui');
    body.append('instance', `${form.instanceId}-${fieldName}`);

    const headers = new Headers({
      Origin: HOSTS.bxpt,
      Referer: URLS.bxptIndex,
      'X-Requested-With': 'XMLHttpRequest',
      'X-User-Lang': 'zh-CN',
    });
    // 这里不走 CookieSession（它只接受字符串 body，multipart 需要 FormData），
    // 直接把罐子里的 Cookie 附上；目标地址是本文件的常量，不存在外泄路径。
    const cookie = this.session.jar.getCookieHeader(url);
    if (cookie !== null) headers.set('Cookie', cookie);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`上传附件失败：${reason}`);
    }
    if (!response.ok) {
      throw new Error(`上传附件失败（HTTP ${response.status}）`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const decoded = decodeRpcResponse(decodeBody(bytes, response.headers.get('content-type')));
    // 接口正常直接返回附件对象；若被包了一层 result 也认
    const payload =
      isRecord(decoded) && isRecord(decoded['result']) ? decoded['result'] : decoded;
    if (!isRecord(payload)) throw new Error('上传附件失败，服务器未返回有效数据');
    const attachment = toAttachment(payload);

    // 记录节点上传附件活动日志并建立关联（HAR Entry 12 & 13）。
    // 服务端靠这条 CI 日志在流转记录里展示附件，失败不影响主流程。
    try {
      const user = this.account.realName === '' ? '用户' : this.account.realName;
      const logResult = await this.rpc('/v2/cmdb/ci/create', [
        {
          type: ACTIVITY_LOG_CI_TYPE,
          create_user: this.account.userId,
          description:
            `${user}在“开始“节点，上传附件$$"${attachment.fileName}"$$` +
            `<<rpc?method=/v2/file/download&id=${attachment.id}>>`,
        },
      ]);
      if (logResult !== null && logResult !== undefined) {
        await this.rpc('/v2/cmdb/relation/create', [
          {
            type: ACTIVITY_LOG_RELATION_TYPE,
            source: form.instanceId,
            destination: str(logResult),
          },
        ]);
      }
    } catch {
      // 忽略：附件本身已经上传成功
    }

    return attachment;
  }

  /** 工单详情（Dart `fetchOrderDetail`，五步各自容错）。 */
  async fetchOrderDetail(order: RepairOrder): Promise<RepairOrder> {
    const typeId = repairOrderTypeId(order);

    let detailMap: Record<string, unknown> = {};
    try {
      const result = await this.rpc('/v2/workorder/data/getById', [typeId, order.id]);
      if (isRecord(result)) detailMap = result;
    } catch {
      // 详情主体拿不到不影响下面几项
    }

    let nodeId: string | null = null;
    try {
      const result = await this.rpc('/v2/workorder/orderConfig/getNodeByOrder', [order.id]);
      if (result !== null && result !== undefined) nodeId = str(result);
    } catch {
      // 同上
    }

    let actions: RepairAction[] = [];
    if (nodeId !== null && nodeId !== '') {
      try {
        const result = await this.rpc('/v2/workorder/action/list', [nodeId, order.id]);
        if (Array.isArray(result)) actions = result.filter(isRecord).map(toAction);
      } catch {
        // 同上
      }
    }

    let logs: RepairActivityLog[] = [];
    try {
      const result = await this.rpc('/v2/cmdb/ci/list', [
        ACTIVITY_LOG_CI_TYPE,
        {
          filter: {
            relation: [
              {
                ids: [order.id],
                relationType: ACTIVITY_LOG_RELATION_TYPE,
                type: 'oneof',
              },
            ],
          },
          orders: [{ name: 'create_time', type: 'desc' }],
        },
      ]);
      if (Array.isArray(result)) logs = result.filter(isRecord).map(toActivityLog);
    } catch {
      // 同上
    }

    let attachments: RepairAttachment[] = [];
    try {
      const result = await this.rpc('/v2/file/list', [
        {
          filter: {
            attribute: {
              simple: { name: 'instance', operator: 'eq', value: `${order.id}-scwttp` },
            },
          },
          orders: [{ name: 'create_time', type: 'desc' }],
        },
      ]);
      if (Array.isArray(result)) attachments = result.filter(isRecord).map(toAttachment);
    } catch {
      // 同上
    }

    const merged: Record<string, unknown> = { ...order.raw, ...detailMap };
    if (nodeId !== null) merged['node_id'] = nodeId;

    return toRepairOrder(merged, { logs, attachments, actions });
  }

  /** 按 id 或工单编号查详情：先在三类列表里找到工单，再拉详情（Dart `fetchOrderDetailById`）。 */
  async fetchOrderDetailById(orderId: string): Promise<RepairOrder> {
    const [ongoing, finished, drafts] = await Promise.all([
      this.fetchOrders({ ongoing: true }),
      this.fetchOrders({ ongoing: false }),
      this.fetchOrders({ ongoing: false, isDraft: true }),
    ]);
    const matched = [...ongoing, ...finished, ...drafts].find(
      (order) => order.id === orderId || order.code === orderId,
    );
    const target: RepairOrder =
      matched ?? toRepairOrder({ id: orderId, code: orderId });
    return await this.fetchOrderDetail(target);
  }

  /** 执行工单动作（Dart `executeAction`）。 */
  async executeAction(
    order: RepairOrder,
    action: RepairAction,
    extraValues: Record<string, unknown> = {},
  ): Promise<boolean> {
    const typeId = repairOrderTypeId(order);
    const catalogId = repairOrderCatalogId(order);
    const priorityRaw = order.raw['priority_group'];

    const dataPayload: Record<string, unknown> = {
      id: order.id,
      type: typeId,
      source: 'mobile',
      priority_group: isRecord(priorityRaw)
        ? str(priorityRaw['name'] ?? '2')
        : str(priorityRaw ?? '2'),
      xm: order.applicant !== '' ? order.applicant : this.account.realName,
      xgh: str(order.raw['xgh'] ?? this.account.username),
      lxfs: order.phone,
      ...(order.description !== '' ? { wtmsh: order.description } : {}),
      ...(order.supplement !== '' ? { bchshm: order.supplement } : {}),
      ...extraValues,
    };

    const node =
      action.possessorNode !== ''
        ? action.possessorNode
        : str(order.raw['node_id'] ?? order.statusId);

    const result = await this.rpc('/v2/workorder/action/executeWithValidate', [
      action.id,
      [{ id: order.id, type: typeId, node }, dataPayload, { service_catalog: catalogId }],
      [],
    ]);
    if (isRecord(result) && result['state'] === true) return true;
    const message = isRecord(result) && result['error'] !== undefined
      ? str(result['error'])
      : '操作执行失败，请稍后重试';
    throw new Error(message);
  }

  /** 取消报修（Dart `cancelOrder`）。 */
  async cancelOrder(order: RepairOrder, action?: RepairAction): Promise<boolean> {
    const target = action ?? order.actions.find(isCancelAction);
    if (target === undefined) throw new Error('当前环节不支持取消报修');
    return await this.executeAction(order, target);
  }
}

/** `constructData` 是「JSON 字符串套 JSON」；解析失败时降级成空对象。 */
function parseConstructData(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toField(value: unknown): RepairField | null {
  if (!isRecord(value)) return null;
  const editor = str(value['editor']);
  const name = str(value['name']);
  if (name === '' || editor === 'group' || editor === 'label') return null;

  const validate = isRecord(value['validate']) ? value['validate'] : {};
  const label = str(value['label'] ?? name);
  const referenceType = str(value['referenceType']);
  const reference = str(value['reference']);

  return {
    name,
    label: label === '' ? name : label,
    editor,
    required: value['required'] === true || validate['required'] === true,
    hidden: value['hidden'] === true,
    readonly: value['readonly'] === true,
    referenceType: referenceType === '' ? null : referenceType,
    reference: reference === '' ? null : reference,
    dataType: str(value['dataType']),
  };
}

/**
 * 提交前的字段清洗（Dart `submit` 里的 sanitizedData 循环）：
 * 日期字段统一转成毫秒时间戳；`{id: '...'}` 这种选择器对象取 id。
 */
export function sanitizeSubmitValues(
  form: RepairForm,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const dateFieldNames = new Set(
    form.fields.filter(isDateField).map((field) => field.name),
  );

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (dateFieldNames.has(key) || key === 'yyrq' || key.toLowerCase().includes('date')) {
      if (value === null || (typeof value === 'string' && value.trim() === '')) {
        sanitized[key] = null;
      } else {
        sanitized[key] = parseDateToTimestamp(value) ?? value;
      }
      continue;
    }
    if (isRecord(value) && typeof value['id'] === 'string') {
      sanitized[key] = value['id'];
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * 建立报修会话。
 *
 * 顺序与 Dart `_establishRepairSession` 一致：先探测 -> CAS 换票 -> 再探测。
 * Dart 第三步失败时会先 `silentLogin()` 再换票一次；在服务端这一步由
 * `runWithSession` 负责 —— 我们抛 `SessionExpiredError`，外层会清会话重登后重跑。
 */
export async function connectRepair(
  session: CookieSession,
  identity: { realName?: string; username?: string; userId?: string },
): Promise<RepairClient> {
  const base = {
    realName: identity.realName ?? '',
    username: identity.username ?? '',
  };

  try {
    const userId = await fetchBxptUserId(session);
    if (userId !== '') {
      return new RepairClient(session, { ...base, userId });
    }
  } catch {
    // 还没有 bxpt 会话：继续走换票
  }

  await exchangeCasTicket(session, {
    serviceUrl: BXPT_SERVICE_URL,
    expectedHost: BXPT_HOST,
    upgradeInsecureHosts: [BXPT_HOST],
  });

  let userId = '';
  try {
    userId = await fetchBxptUserId(session);
  } catch {
    userId = '';
  }
  if (userId === '') {
    throw new SessionExpiredError('报修平台登录凭证交换失败，请重试');
  }
  return new RepairClient(session, { ...base, userId });
}
