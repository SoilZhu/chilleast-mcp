/**
 * 学工系统（xgxt）工具：三个问卷工具（query_questionnaires /
 * query_questionnaire_detail / submit_questionnaire）与三个请假工具
 * （query_leaves / query_leave_detail / submit_leave）。
 *
 * 会话：用 SSO 的 TGC 换一次 CAS 票据拿到 xgxt 的 JSESSIONID 后复用；被踢回
 * 登录页就重新换一次票（最多一次）。
 *
 * 两个写操作都要 confirmed=true，且都不循环重试（避免重复投递）。差别：
 * submit_leave 换票后会重投一次；submit_questionnaire 在提交瞬间若会话失效
 * 也如实报错，不自动补投。
 */

import { textResult } from '../mcp/protocol';
import type { ToolContext, ToolDefinition } from '../mcp/registry';
import { SessionExpiredError, runWithSession, type SessionContext } from '../auth/session-manager';
import { encodeForm } from '../auth/http';
import { exchangeCasTicket, looksLikeLoginPage } from '../school/hunau/cas';
import { HOSTS, MOBILE_UA, URLS } from '../school/hunau/constants';
import { b64ToBytes } from '../util/bytes';

const XGXT_HOST = new URL(HOSTS.xgxt).hostname;

const API_HEADERS = {
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
  Referer: `${HOSTS.xgxt}/wap/menu/fwk/wjdc/stu/xs_wjdc`,
  'User-Agent': MOBILE_UA,
};

/**
 * 请假接口的请求头：Accept / Referer 与问卷不同（照 Dart `LeaveService._headers`），
 * 其余复用 API_HEADERS。
 */
const LEAVE_HEADERS = {
  ...API_HEADERS,
  Accept: '*/*',
  Referer: `${HOSTS.xgxt}/wap/menu/student/leave/qjsq`,
};

/**
 * 附件大小上限。
 *
 * base64 -> bytes 是逐字节的 JS 循环（Workers 没有 Node Buffer），实测约 4ms CPU/MB，
 * 而免费版每次调用只有 10ms CPU 预算（登录 + JSON 解析也要用），所以只收 1MB。
 * 需要更大附件时请先压缩，或由用户在 App 内自行上传。
 */
const MAX_ATTACHMENT_BYTES = 1024 * 1024;

/** multipart 里文件 part 的 Content-Type（Dio MultipartFile.fromFile 的默认值）。 */
const ATTACHMENT_CONTENT_TYPE = 'application/octet-stream';

/** 写请求的超时（与 CookieSession 默认值保持一致）。 */
const WRITE_TIMEOUT_MS = 20_000;

async function ensureXgxtSession(context: SessionContext): Promise<void> {
  await exchangeCasTicket(context.session, {
    serviceUrl: URLS.xgxtCas,
    expectedHost: XGXT_HOST,
    sessionCookieName: 'JSESSIONID',
    upgradeInsecureHosts: [XGXT_HOST],
  });
}

/** 请求 xgxt 接口；被踢回登录页时重新换票再试一次。 */
async function withXgxt<T>(
  context: SessionContext,
  call: () => Promise<T>,
  isExpired: (value: T) => boolean,
): Promise<T> {
  await ensureXgxtSession(context);
  const first = await call();
  if (!isExpired(first)) return first;

  await exchangeCasTicket(context.session, {
    serviceUrl: URLS.xgxtCas,
    expectedHost: XGXT_HOST,
    sessionCookieName: 'JSESSIONID',
    upgradeInsecureHosts: [XGXT_HOST],
  });
  const second = await call();
  if (isExpired(second)) {
    throw new SessionExpiredError('学工系统会话未建立');
  }
  return second;
}

/** 解析 JSON（不限制顶层形状）；拿到 HTML / 302 时视为会话失效。 */
function parseXgxtAny(status: number, body: string): unknown {
  if ([301, 302, 303, 307, 308].includes(status)) {
    throw new SessionExpiredError('学工系统会话已失效');
  }
  const trimmed = body.trim();
  if (trimmed.startsWith('<')) {
    throw new SessionExpiredError('学工系统返回了登录页');
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new SessionExpiredError('学工系统返回了无法解析的内容');
  }
}

/** 解析 JSON；拿到 HTML / 302 时视为会话失效。 */
function parseXgxtJson(status: number, body: string): Record<string, unknown> {
  const parsed = parseXgxtAny(status, body);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SessionExpiredError('学工系统返回了无法解析的内容');
  }
  return parsed as Record<string, unknown>;
}

/** 解析顶层 JSON 数组（请假类别 / 省市县接口返回数组，不能用 parseXgxtJson）。 */
function parseXgxtArray(status: number, body: string): unknown[] {
  const parsed = parseXgxtAny(status, body);
  if (!Array.isArray(parsed)) {
    throw new SessionExpiredError('学工系统返回了非预期的数据结构');
  }
  return parsed;
}

function normalizeItem(row: Record<string, unknown>): Record<string, unknown> {
  const value = (key: string): string => {
    const raw = row[key];
    return raw === undefined || raw === null ? '' : String(raw);
  };
  return {
    dm: value('DM'),
    title: value('MC'),
    startTime: value('KSSJ'),
    endTime: value('JSSJ'),
    taskTimeM: value('TASK_TIME_M'),
    done: value('DONE_IND'),
    flag: value('FLAG'),
    status: value('ZT'),
    auditStatus: value('SHZT'),
  };
}

// ---- 通用小工具 ----

/** 校验类函数的返回值：要么拿到值，要么拿到一句给模型看的中文原因。 */
type Validation<T> = { ok: true; value: T } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 宽松取字符串：null / undefined -> ''，其余走 String()。 */
function asText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function toInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const parsed = Number.parseInt(asText(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stampQuery(): URLSearchParams {
  return new URLSearchParams({ _t_s_: String(Date.now()) });
}

/** 写接口的失败原因：服务端放在 errorInfoList（数组）或 msg 里（Dart 同款顺序）。 */
function submitFailureMessage(data: Record<string, unknown>): string {
  const errors = data['errorInfoList'];
  if (Array.isArray(errors) && errors.length > 0) {
    const first = asText(errors[0]).trim();
    if (first !== '') return first;
  }
  const message = asText(data['msg']).trim();
  return message === '' ? '提交失败，请稍后重试' : message;
}

/** xgxt GET + 解析对象；会话失效时由 withXgxt 换票重试一次。 */
async function xgxtGetJson(
  context: SessionContext,
  url: string,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  return await withXgxt(
    context,
    async () => {
      const response = await context.session.get(url, { follow: false, headers });
      return parseXgxtJson(response.status, response.body);
    },
    () => false, // parseXgxtJson 已经会把登录页当成失效抛出
  );
}

/** xgxt GET + 解析顶层数组（请假类别 / 省市县接口）。 */
async function xgxtGetArray(
  context: SessionContext,
  url: string,
  headers: Record<string, string>,
): Promise<unknown[]> {
  return await withXgxt(
    context,
    async () => {
      const response = await context.session.get(url, { follow: false, headers });
      return parseXgxtArray(response.status, response.body);
    },
    () => false,
  );
}

// ---- 请假（leave）纯逻辑 ----

export interface LeaveAttachment {
  name: string;
  bytes: Uint8Array;
}

export interface LeaveSubmitInput {
  type: string;
  startTime: string;
  endTime: string;
  reason: string;
  contact: string;
  phone: string;
  companions: string;
  leaveSchool: boolean;
  province: string;
  city: string;
  county: string;
  address: string;
  backDorm: boolean;
  remark: string;
  outCity: boolean;
  outProvince: boolean;
  confirmed: boolean;
  attachment: LeaveAttachment | null;
}

export interface LeaveDictItem {
  id: string;
  name: string;
}

export interface LeaveRegionNode {
  id: string;
  name: string;
  children: LeaveRegionNode[];
}

export interface LeaveDuration {
  days: number;
  hours: number;
}

/** 解析 `YYYY-MM-DD HH:mm`，返回可直接比较的时间戳；非法返回 null。 */
export function parseMinuteStamp(text: string): number | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text.trim());
  if (matched === null) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const hour = Number(matched[4]);
  const minute = Number(matched[5]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const stamp = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(stamp);
  // 2026-02-30 这类「格式对但日期不存在」的输入会被 Date 进位，这里挡掉
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return stamp;
}

/** 去掉文件名里会破坏 multipart 头的字符（换行 / 引号 / 路径分隔符）。 */
export function sanitizeAttachmentName(name: string): string {
  // 先截断再跑正则，避免超长文件名把 CPU 花在替换上
  const cleaned = name.slice(0, 256).replace(/[\u0000-\u001f\u007f"\\/]/g, '').trim();
  if (cleaned === '') return 'attachment';
  return cleaned.slice(0, 128);
}

/**
 * base64 -> bytes。服务端没有设备文件系统（Dart 用 `MultipartFile.fromFile`），
 * 附件只能由调用方以 base64 带进来；给了内容就必须给文件名。
 */
export function decodeLeaveAttachment(
  base64: unknown,
  name: unknown,
): Validation<LeaveAttachment | null> {
  const content = typeof base64 === 'string' ? base64.trim() : '';
  if (content === '') return { ok: true, value: null };

  let bytes: Uint8Array;
  try {
    bytes = b64ToBytes(content);
  } catch {
    return { ok: false, message: 'attachmentBase64 不是合法的 base64 内容。' };
  }
  if (bytes.length === 0) {
    return { ok: false, message: 'attachmentBase64 解码后为空。' };
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    const limit = MAX_ATTACHMENT_BYTES / 1024 / 1024;
    const actual = (bytes.length / 1024 / 1024).toFixed(1);
    return { ok: false, message: `附件 ${actual}MB 超过上限 ${limit}MB。` };
  }

  const fileName = typeof name === 'string' ? name.trim() : '';
  if (fileName === '') {
    return { ok: false, message: '带附件时必须同时提供 attachmentName（含扩展名，如 病历.jpg）。' };
  }
  return { ok: true, value: { name: sanitizeAttachmentName(fileName), bytes } };
}

/**
 * 请假参数校验。规则与 Dart 一致（`leave_apply_screen._validate`）：
 * 类别/事由/联系人必填、手机号 11 位、结束晚于开始、离校时省份+详细地址+备注必填。
 */
export function validateLeaveInput(args: Record<string, unknown>): Validation<LeaveSubmitInput> {
  const text = (key: string): string => {
    const raw = args[key];
    return typeof raw === 'string' ? raw.trim() : '';
  };
  const flag = (key: string): boolean => args[key] === true;

  const type = text('type');
  if (type === '') {
    return { ok: false, message: '请假类别（type）不能为空，可传“事假”“病假”等关键词。' };
  }

  const startTime = text('startTime');
  const endTime = text('endTime');
  const startStamp = parseMinuteStamp(startTime);
  if (startStamp === null) {
    return { ok: false, message: '开始时间（startTime）须为 YYYY-MM-DD HH:mm，如 2026-09-22 10:00。' };
  }
  const endStamp = parseMinuteStamp(endTime);
  if (endStamp === null) {
    return { ok: false, message: '结束时间（endTime）须为 YYYY-MM-DD HH:mm，如 2026-09-22 18:00。' };
  }
  if (endStamp <= startStamp) {
    return { ok: false, message: '结束时间必须晚于开始时间。' };
  }

  const reason = text('reason');
  if (reason === '') return { ok: false, message: '请假事由（reason）不能为空。' };

  const contact = text('contact');
  if (contact === '') return { ok: false, message: '紧急联系人（contact）不能为空。' };

  const phone = text('phone');
  if (!/^1\d{10}$/.test(phone)) {
    return { ok: false, message: '紧急联系人电话（phone）须为 11 位手机号。' };
  }

  const leaveSchool = flag('leaveSchool');
  const province = text('province');
  const address = text('address');
  const remark = text('remark');
  if (leaveSchool) {
    if (province === '') {
      return { ok: false, message: '离校（leaveSchool=true）必须提供去向省份 province。' };
    }
    if (address === '') {
      return { ok: false, message: '离校（leaveSchool=true）必须提供详细地址 address。' };
    }
    if (remark === '') {
      return { ok: false, message: '离校（leaveSchool=true）必须提供备注 remark。' };
    }
  }

  const attachment = decodeLeaveAttachment(args['attachmentBase64'], args['attachmentName']);
  if (!attachment.ok) return { ok: false, message: attachment.message };

  return {
    ok: true,
    value: {
      type,
      startTime,
      endTime,
      reason,
      contact,
      phone,
      companions: text('companions'),
      leaveSchool,
      province,
      city: text('city'),
      county: text('county'),
      address,
      backDorm: flag('backDorm'),
      remark,
      outCity: flag('outCity'),
      outProvince: flag('outProvince'),
      confirmed: flag('confirmed'),
      attachment: attachment.value,
    },
  };
}

/** `content/json/selects` 返回顶层数组：`[{id, text}]`。 */
export function parseLeaveDict(data: unknown): LeaveDictItem[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter(isRecord)
    .map((item) => ({ id: asText(item['id']), name: asText(item['text']) }))
    .filter((item) => item.id !== '' || item.name !== '');
}

/** 类别匹配：先精确（id 或名称），再双向包含 —— 与 Dart leave_tool 同款策略。 */
export function matchLeaveDict(
  items: readonly LeaveDictItem[],
  keyword: string,
): LeaveDictItem | null {
  const wanted = keyword.trim();
  if (wanted === '') return null;
  for (const item of items) {
    if (item.id === wanted || item.name === wanted) return item;
  }
  for (const item of items) {
    if (item.name !== '' && (item.name.includes(wanted) || wanted.includes(item.name))) return item;
  }
  return null;
}

/** `content/json/selects/wap/ssx` 返回省市县三层树：`[{id, text, children}]`。 */
export function parseRegionNodes(data: unknown): LeaveRegionNode[] {
  if (!Array.isArray(data)) return [];
  return data.filter(isRecord).map((node) => ({
    id: asText(node['id']),
    name: asText(node['text']),
    children: parseRegionNodes(node['children']),
  }));
}

/** 地区匹配：先精确（id 或名称），再双向包含 —— 与 Dart `_matchRegion` 一致。 */
export function matchRegionNode(
  nodes: readonly LeaveRegionNode[],
  keyword: string,
): LeaveRegionNode | null {
  const wanted = keyword.trim();
  if (wanted === '') return null;
  for (const node of nodes) {
    if (node.id === wanted || node.name === wanted) return node;
  }
  for (const node of nodes) {
    if (node.name !== '' && (node.name.includes(wanted) || wanted.includes(node.name))) return node;
  }
  return null;
}

/** `content/student/leave/calculate` 返回 `{day, hour}`。 */
export function parseLeaveDuration(data: Record<string, unknown>): LeaveDuration {
  return {
    days: Math.max(toInt(data['day']), 0),
    hours: Math.max(toInt(data['hour']), 0),
  };
}

/**
 * 提交字段表。键名与顺序照 Dart `leave_apply_screen._submit` 的 map 字面量，
 * 顺序会影响 urlencoded body 的字节，尽量别改。
 */
export function buildLeaveFields(
  input: LeaveSubmitInput,
  type: LeaveDictItem,
  region: { id: string; name: string },
  duration: LeaveDuration,
): Record<string, string> {
  return {
    'qjlxM.dm': type.id,
    qjlx: type.name,
    kssj: input.startTime,
    jssj: input.endTime,
    ts: String(duration.days),
    jsTs: String(duration.days),
    hour: String(duration.hours),
    jsHour: String(duration.hours),
    qjsy: input.reason,
    lxr: input.contact,
    lxrdh: input.phone,
    txry: input.companions,
    lxInd: input.leaveSchool ? '1' : '0',
    'lxqx.dm': region.id,
    lxqx1: region.name,
    lxMdd: input.address,
    huisusheInd: input.backDorm ? '1' : '0',
    lxBz: input.remark,
    chushiInd: input.outCity ? '1' : '0',
    chushengInd: input.outProvince ? '1' : '0',
    pathFile: '',
    qjLocation: '',
    qjLocationZb: '',
    operationType: 'Create',
    id: '',
  };
}

/**
 * 有附件时构造 multipart 表单：文本字段在前、文件 part 收尾，顺序与 Dart
 * `FormData.fromMap({...fields, pathFile: MultipartFile})` 一致。
 * JS 的 FormData 不像 Dart Map 那样同名前值会被覆盖，所以必须先剔除
 * `pathFile` 的空字符串，否则服务端会收到两个 pathFile part。
 */
export function buildLeaveMultipartForm(
  fields: Readonly<Record<string, string>>,
  attachment: LeaveAttachment,
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'pathFile') continue;
    form.append(key, value);
  }
  form.append(
    'pathFile',
    new Blob([attachment.bytes], { type: ATTACHMENT_CONTENT_TYPE }),
    attachment.name,
  );
  return form;
}

/**
 * 带附件的提交必须走 multipart。直接复用 `CookieSession`：
 * 它本来就会带上 Cookie 罐的 Cookie、并把每一跳的 Set-Cookie 落回罐子，
 * 且 `follow: false` 与 Dart 的 `followRedirects: false` 一致 ——
 * 302 要能被上层识别成"会话失效"而不是被跟着跳进登录页。
 *
 * 导出仅为单测覆盖（见 test/xgxt-leave.test.ts），业务代码只在 submit_leave 里用它。
 */
export async function postMultipartWithJar(
  context: SessionContext,
  url: string,
  form: FormData,
): Promise<{ status: number; body: string }> {
  const response = await context.session.request(url, {
    method: 'POST',
    body: form,
    follow: false,
    headers: LEAVE_HEADERS,
    timeoutMs: WRITE_TIMEOUT_MS,
  });
  return { status: response.status, body: response.body };
}

/** 列表行 -> 对外结构；字段与 Dart `leave_tool._formatRecord` 对齐（多一个 hasFile）。 */
export function formatLeaveRecord(row: Record<string, unknown>): Record<string, unknown> {
  const auditStatus = asText(row['SHZT']);
  const auditStatusName = asText(row['SHZTMC']);
  const auditResultName = asText(row['SHJGMC']);
  let status = auditStatusName;
  if (status === '') {
    if (auditStatus === '0') status = '待审核';
    else if (auditStatus === '8') status = '审核中';
    else if (auditStatus === '9') status = auditResultName === '' ? '已审核' : `已审核·${auditResultName}`;
    else status = '状态未知';
  } else if (auditStatus === '9' && auditResultName !== '') {
    status = `${auditStatusName}·${auditResultName}`;
  }

  const days = toInt(row['TS']);
  const hours = toInt(row['HOUR']);
  const startTime = asText(row['KSSJ']);
  const endTime = asText(row['JSSJ']);
  return {
    id: asText(row['ID']),
    type: asText(row['LXMC']),
    timeRange: startTime === '' || endTime === '' ? '' : `${startTime} ~ ${endTime}`,
    startTime,
    endTime,
    duration: `${days > 0 ? `${days}天` : ''}${hours > 0 ? `${hours}小时` : ''}`,
    reason: asText(row['QJSY']),
    status,
    canDelete: auditStatus === '0',
    hasFile: asText(row['HAS_FILE']) === '1',
  };
}

/** status 过滤：关键词包含即命中（照 Dart leave_tool 的 where 条件）。 */
export function matchesLeaveStatus(auditStatus: string, status: string): boolean {
  if (status.includes('待审核')) return auditStatus === '0';
  if (status.includes('审核中')) return auditStatus === '8';
  if (status.includes('已审')) return auditStatus === '9';
  return true;
}

// ---- 问卷提交纯逻辑 ----

export interface QuestionnaireOption {
  dm: string;
  name: string;
}

export interface QuestionnaireQuestion {
  dm: string;
  title: string;
  desc: string;
  stType: string;
  txType: string;
  required: boolean;
  answer: string;
  options: QuestionnaireOption[];
}

export interface QuestionnaireDetail {
  dm: string;
  title: string;
  jgM: string;
  canSubmit: boolean;
  questions: QuestionnaireQuestion[];
}

export interface QuestionnaireItem {
  dm: string;
  title: string;
  startTime: string;
  endTime: string;
  taskTimeM: string;
  doneInd: string;
  zt: string;
  shzt: string;
}

/** 一题的提交载荷：多选题会有多个值（同一个 dm 在 body 里重复出现）。 */
export interface QuestionnaireAnswerField {
  dm: string;
  values: string[];
}

/** 列表 aaData -> 模型（字段含义见 Dart questionnaire_models.QuestionnaireItem）。 */
export function parseQuestionnaireItems(data: Record<string, unknown>): QuestionnaireItem[] {
  const rows = data['aaData'];
  if (!Array.isArray(rows)) return [];
  return rows.filter(isRecord).map((row) => ({
    dm: asText(row['DM']),
    title: asText(row['MC']),
    startTime: asText(row['KSSJ']),
    endTime: asText(row['JSSJ']),
    taskTimeM: asText(row['TASK_TIME_M']),
    doneInd: asText(row['DONE_IND']),
    zt: asText(row['ZT']),
    shzt: asText(row['SHZT']),
  }));
}

/** 详情 sjvo -> 模型（stList 是题目数组，jgM 是提交时要带的卷子 dm）。 */
export function parseQuestionnaireDetail(data: Record<string, unknown>): QuestionnaireDetail {
  const rows = data['stList'];
  const canSubmitRaw = data['canSubmit'];
  return {
    dm: asText(data['dm']),
    title: asText(data['mc']) !== '' ? asText(data['mc']) : asText(data['sm']),
    jgM: asText(data['jgM']),
    canSubmit: canSubmitRaw === undefined || canSubmitRaw === null ? true : asText(canSubmitRaw) === '1',
    questions: Array.isArray(rows)
      ? rows.filter(isRecord).map((row) => {
          const rawOptions = row['stxxList'];
          return {
            dm: asText(row['dm']),
            title: asText(row['stmc']),
            desc: asText(row['stsm']),
            stType: asText(row['stType']),
            txType: asText(row['txType']),
            required: asText(row['btInd']) === '1',
            answer: asText(row['jg']),
            options: Array.isArray(rawOptions)
              ? rawOptions
                  .filter(isRecord)
                  .map((option) => ({ dm: asText(option['dm']), name: asText(option['mc']) }))
              : [],
          };
        })
      : [],
  };
}

export function isQuestionChoice(question: QuestionnaireQuestion): boolean {
  return question.options.length > 0 || question.stType === '1' || question.stType === '2';
}

/** 是否已提交过（Dart `QuestionnaireItem.isSubmitted`）。 */
export function isQuestionnaireSubmitted(item: QuestionnaireItem): boolean {
  return item.zt === '1' || item.shzt === '1' || item.doneInd === '1';
}

export function isQuestionMultiChoice(question: QuestionnaireQuestion): boolean {
  return question.stType === '2';
}

/** 题型文案，与 Dart `questionnaire_tool._questionKind` 一致。 */
export function questionKind(question: QuestionnaireQuestion): string {
  if (isQuestionMultiChoice(question)) return '多选';
  if (isQuestionChoice(question)) return '单选';
  if (question.stType === '4' && (question.txType === '3' || question.txType === '4')) return '日期';
  if (question.stType === '4' && question.txType === '2') return '电话';
  return '填空';
}

/** 问卷匹配：taskTimeM / dm 精确 -> 标题精确 -> 标题双向包含（Dart 同款）。 */
export function matchQuestionnaire(
  items: readonly QuestionnaireItem[],
  keyword: string,
): QuestionnaireItem | null {
  const wanted = keyword.trim();
  if (wanted === '') return null;
  for (const item of items) {
    if (item.taskTimeM === wanted || item.dm === wanted) return item;
  }
  for (const item of items) {
    if (item.title === wanted) return item;
  }
  for (const item of items) {
    if (item.title !== '' && (item.title.includes(wanted) || wanted.includes(item.title))) {
      return item;
    }
  }
  return null;
}

/** 选项匹配：先 dm / 名称精确，再双向包含。 */
function matchOption(question: QuestionnaireQuestion, input: string): string | null {
  const wanted = input.trim();
  if (wanted === '') return null;
  for (const option of question.options) {
    if (option.dm === wanted || option.name === wanted) return option.dm;
  }
  for (const option of question.options) {
    if (option.name !== '' && (option.name.includes(wanted) || wanted.includes(option.name))) {
      return option.dm;
    }
  }
  return null;
}

/** 在 answers 里按题目 dm 精确、或标题双向包含查找（Dart `_findAnswer`）。 */
function findAnswer(
  question: QuestionnaireQuestion,
  answers: Readonly<Record<string, unknown>>,
): unknown {
  if (question.dm !== '' && Object.hasOwn(answers, question.dm)) return answers[question.dm];
  for (const [key, value] of Object.entries(answers)) {
    const wanted = key.trim();
    if (wanted === '') continue;
    if (question.title !== '' && (question.title.includes(wanted) || wanted.includes(question.title))) {
      return value;
    }
  }
  return null;
}

/**
 * 把用户答案映射为选项 dm 列表。单选只取第一个，多选保留全部；
 * 找不到有效选项返回 null（Dart `_mapChoiceAnswer` 的等价实现）。
 */
function mapChoiceAnswer(question: QuestionnaireQuestion, hit: unknown): string[] | null {
  if (Array.isArray(hit)) {
    const matched: string[] = [];
    for (const item of hit) {
      const dm = matchOption(question, asText(item));
      if (dm !== null) matched.push(dm);
    }
    if (matched.length === 0) return null;
    return isQuestionMultiChoice(question) ? matched : [matched[0]];
  }
  if (typeof hit === 'string') {
    // 多选题也允许逗号/顿号分隔的一串文本
    if (isQuestionMultiChoice(question) && /[,，、;；]/.test(hit)) {
      const matched = hit
        .split(/[,，、;；]/)
        .map((part) => matchOption(question, part))
        .filter((dm): dm is string => dm !== null);
      return matched.length === 0 ? null : matched;
    }
    const dm = matchOption(question, hit);
    return dm === null ? null : [dm];
  }
  return null;
}

/** 预览用的答案文案：选项 dm -> 选项名，多选给数组（与 Dart 预览一致）。 */
function previewAnswer(
  question: QuestionnaireQuestion,
  dms: readonly string[],
): string | string[] {
  const names = dms.map(
    (dm) => question.options.find((option) => option.dm === dm)?.name ?? dm,
  );
  if (isQuestionMultiChoice(question)) return names;
  return names.length === 0 ? '' : names[0];
}

export interface ResolvedQuestionnaire {
  fields: QuestionnaireAnswerField[];
  preview: Array<Record<string, unknown>>;
}

/**
 * 逐题把用户答案映射成提交载荷（key 一律是题目 dm）。
 * 规则照 Dart `questionnaire_tool`：必填题缺有效答案直接失败；非必填缺答案提交空串。
 */
export function resolveQuestionnaireAnswers(
  detail: QuestionnaireDetail,
  answers: Readonly<Record<string, unknown>>,
): Validation<ResolvedQuestionnaire> {
  const fields: QuestionnaireAnswerField[] = [];
  const preview: Array<Record<string, unknown>> = [];

  for (const question of detail.questions) {
    const hit = findAnswer(question, answers);
    if (isQuestionChoice(question)) {
      const mapped = mapChoiceAnswer(question, hit);
      if (mapped === null) {
        if (question.required) {
          const names = question.options.map((option) => option.name).join('、');
          return {
            ok: false,
            message: `必填题“${question.title}”缺少有效答案，可选项：${names}。`,
          };
        }
        fields.push({ dm: question.dm, values: [] });
        preview.push({
          question: question.title,
          required: question.required,
          kind: questionKind(question),
          answer: '',
        });
        continue;
      }
      fields.push({ dm: question.dm, values: mapped });
      preview.push({
        question: question.title,
        required: question.required,
        kind: questionKind(question),
        answer: previewAnswer(question, mapped),
      });
      continue;
    }

    const text = hit === undefined || hit === null ? '' : asText(hit).trim();
    if (text === '' && question.required) {
      return { ok: false, message: `必填题“${question.title}”缺少答案。` };
    }
    fields.push({ dm: question.dm, values: text === '' ? [] : [text] });
    preview.push({
      question: question.title,
      required: question.required,
      kind: questionKind(question),
      answer: text,
    });
  }

  return { ok: true, value: { fields, preview } };
}

/**
 * 手工拼 urlencoded body：多选题同一个题目 dm 会重复出现多次，与浏览器抓包一致。
 * Dart `QuestionnaireService.submit` 就是这么拼的（用 map 会把重复键吃掉）。
 * 编码走 `encodeForm`（encodeURIComponent，与 Dart Uri.encodeQueryComponent 等价）。
 */
export function buildQuestionnaireBody(
  fields: readonly QuestionnaireAnswerField[],
  jgM: string,
): string {
  const entries: Array<[string, string]> = [];
  for (const field of fields) {
    if (field.values.length === 0) {
      entries.push([field.dm, '']);
      continue;
    }
    for (const value of field.values) entries.push([field.dm, value]);
  }
  entries.push(['ks_jgdm', jgM], ['wzDz', ''], ['wzZb', ''], ['wzLy', ''], ['operationType', '']);
  return encodeForm(entries);
}

export function createXgxtTools(): ToolDefinition[] {
  const listTool: ToolDefinition = {
    name: 'query_questionnaires',
    description:
      '查询湖南农大学工系统下发给本人的问卷/调查任务列表（含是否已完成、起止时间）。' +
      '拿到 taskTimeM 后可用 query_questionnaire_detail 查看题目。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: '返回条数上限，默认 50，最大 200。',
          minimum: 1,
          maximum: 200,
        },
      },
      additionalProperties: false,
    },
    async handler(args, toolContext) {
      const limit =
        typeof args['limit'] === 'number' ? Math.min(Math.max(args['limit'], 1), 200) : 50;

      return await runWithSession(toolContext.env, toolContext.credentials, async (context) => {
        const query = new URLSearchParams({
          bSortable_0: 'false',
          bSortable_1: 'false',
          iSortingCols: '1',
          iDisplayStart: '0',
          iDisplayLength: String(limit),
          iSortCol_0: '3',
          sSortDir_0: 'desc',
          _t_s_: String(Date.now()),
        });

        const fetchRows = async (): Promise<Record<string, unknown>> => {
          const response = await context.session.get(
            `${URLS.xgxtQuestionnaireList}?${query}`,
            {
              follow: false,
              headers: API_HEADERS,
            },
          );
          return parseXgxtJson(response.status, response.body);
        };

        const data = await withXgxt(
          context,
          fetchRows,
          () => false, // parseXgxtJson 已经会把登录页当成失效抛出
        );

        const rows = data['aaData'];
        if (!Array.isArray(rows)) {
          return textResult('问卷列表为空或返回结构异常。', { count: 0, items: [] });
        }
        const items = (rows as Array<Record<string, unknown>>).map(normalizeItem);
        if (items.length === 0) {
          return textResult('当前没有问卷任务。', { count: 0, items: [] });
        }
        return textResult(
          `共 ${items.length} 份问卷：\n${JSON.stringify(items, null, 2)}`,
          { count: items.length, items },
        );
      });
    },
  };

  const detailTool: ToolDefinition = {
    name: 'query_questionnaire_detail',
    description: '查询某份问卷的题目与选项，需要先通过 query_questionnaires 拿到 taskTimeM。',
    inputSchema: {
      type: 'object',
      properties: {
        taskTimeM: { type: 'string', description: '问卷的 TASK_TIME_M 字段。' },
      },
      required: ['taskTimeM'],
      additionalProperties: false,
    },
    async handler(args, toolContext) {
      const taskTimeM = typeof args['taskTimeM'] === 'string' ? args['taskTimeM'].trim() : '';
      if (taskTimeM === '') {
        return textResult('必须提供 taskTimeM。');
      }

      return await runWithSession(toolContext.env, toolContext.credentials, async (context) => {
        const query = new URLSearchParams({
          tasktime: taskTimeM,
          busType: '',
          _t_s_: String(Date.now()),
        });
        const data = await withXgxt(
          context,
          async () => {
            const response = await context.session.get(
              `${URLS.xgxtQuestionnaireDetail}?${query}`,
              { follow: false, headers: API_HEADERS },
            );
            return parseXgxtJson(response.status, response.body);
          },
          () => false,
        );
        return textResult(JSON.stringify(data, null, 2), data);
      });
    },
  };

  const leaveListTool: ToolDefinition = {
    name: 'query_leaves',
    description:
      '查询学校学工系统“请假申请”的请假记录。返回每条记录的类别（事假/病假）、起止时间、' +
      '时长、事由与审核状态（待审核/审核中/已审核）。拿到 id 后可用 query_leave_detail 看完整详情。',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: '按状态过滤：待审核、审核中、已审核、全部。默认为全部。',
        },
        limit: {
          type: 'integer',
          description: '返回条数上限，默认 50，最大 200。',
          minimum: 1,
          maximum: 200,
        },
      },
      additionalProperties: false,
    },
    async handler(args: Record<string, unknown>, toolContext: ToolContext) {
      const status = typeof args['status'] === 'string' ? args['status'].trim() : '全部';
      const limit =
        typeof args['limit'] === 'number'
          ? Math.min(Math.max(Math.trunc(args['limit']), 1), 200)
          : 50;

      return await runWithSession(toolContext.env, toolContext.credentials, async (context) => {
        const query = new URLSearchParams({
          bSortable_0: 'false',
          bSortable_1: 'false',
          iSortingCols: '1',
          iDisplayStart: '0',
          iDisplayLength: String(limit),
          iSortCol_0: '3',
          sSortDir_0: 'desc',
          _t_s_: String(Date.now()),
        });
        const data = await xgxtGetJson(context, `${URLS.xgxtLeaveList}?${query}`, LEAVE_HEADERS);

        const rows = data['aaData'];
        if (!Array.isArray(rows)) {
          return textResult('请假记录为空或返回结构异常。', { count: 0, leaves: [] });
        }
        const leaves = rows
          .filter(isRecord)
          .filter((row) => matchesLeaveStatus(asText(row['SHZT']), status))
          .map(formatLeaveRecord);
        if (leaves.length === 0) {
          return textResult(`没有符合条件的请假记录（筛选：${status}）。`, { count: 0, leaves: [] });
        }
        return textResult(`共 ${leaves.length} 条请假记录：\n${JSON.stringify(leaves, null, 2)}`, {
          success: true,
          count: leaves.length,
          leaves,
        });
      });
    },
  };

  const leaveDetailTool: ToolDefinition = {
    name: 'query_leave_detail',
    description:
      '查询某条请假记录的完整详情（事由、紧急联系人、离校去向、备注、出市/出省、附件等）。' +
      'id 取自 query_leaves 返回的 id 字段。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '请假记录 id（query_leaves 返回的 id 字段）。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async handler(args: Record<string, unknown>, toolContext: ToolContext) {
      const id = typeof args['id'] === 'string' ? args['id'].trim() : '';
      if (id === '') return textResult('必须提供请假记录 id（可先用 query_leaves 获取）。');

      return await runWithSession(toolContext.env, toolContext.credentials, async (context) => {
        const url = `${URLS.xgxtLeaveApply}/${encodeURIComponent(id)}?${stampQuery()}`;
        const detail = await xgxtGetJson(context, url, LEAVE_HEADERS);
        return textResult(JSON.stringify(detail, null, 2), { success: true, id, detail });
      });
    },
  };

  const leaveSubmitTool: ToolDefinition = {
    name: 'submit_leave',
    description:
      '代用户提交请假申请。【写操作，有副作用】confirmed=true 时会真实创建一条待审核的请假单，' +
      '请务必先给用户核对预览。请假时长由起止时间自动计算（服务端 calculate 接口），无需传入；' +
      '时间格式均为 YYYY-MM-DD HH:mm（24 小时制）。需要附病假条等材料时，把文件内容 base64 放到 ' +
      'attachmentBase64、文件名放到 attachmentName（含扩展名，解码后最大 1MB）。' +
      '【重要】首次调用保持 confirmed=false，工具返回待确认的申请预览（含算出的时长）；' +
      '向用户逐项核对并取得明确同意后，再传 confirmed=true 真正提交。',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '请假类别：事假或病假（支持关键词）。' },
        startTime: {
          type: 'string',
          description: '开始时间，格式 YYYY-MM-DD HH:mm，如“2026-09-22 10:00”。',
        },
        endTime: {
          type: 'string',
          description: '结束时间，格式 YYYY-MM-DD HH:mm，必须晚于开始时间。',
        },
        reason: { type: 'string', description: '请假事由（必填）。' },
        contact: { type: 'string', description: '紧急联系人（必填）。' },
        phone: { type: 'string', description: '紧急联系人电话（必填，11 位手机号）。' },
        companions: { type: 'string', description: '同行人员（选填）。' },
        leaveSchool: {
          type: 'boolean',
          description: '是否离校。默认为 false；为 true 时 province、address、remark 必填。',
          default: false,
        },
        province: { type: 'string', description: '离校去向省份关键词（如“湖南”，离校时必填）。' },
        city: { type: 'string', description: '离校去向城市关键词（如“长沙”，选填，越细越好）。' },
        county: { type: 'string', description: '离校区县关键词（如“岳麓”，选填）。' },
        address: { type: 'string', description: '离校详细地址（离校时必填）。' },
        backDorm: {
          type: 'boolean',
          description: '是否回宿舍。默认为 false。',
          default: false,
        },
        remark: { type: 'string', description: '备注（离校时必填）。' },
        outCity: { type: 'boolean', description: '是否出市。默认为 false。', default: false },
        outProvince: { type: 'boolean', description: '是否出省。默认为 false。', default: false },
        attachmentBase64: {
          type: 'string',
          description: '附件内容（标准 base64，不要带 data URI 前缀）。选填，解码后最大 1MB。',
        },
        attachmentName: {
          type: 'string',
          description: '附件文件名（含扩展名，如“病历.jpg”）。传了 attachmentBase64 就必填。',
        },
        confirmed: {
          type: 'boolean',
          description:
            '用户是否已对预览中的申请内容做最终确认。默认为 false；仅当用户明确同意提交后才传 true。',
          default: false,
        },
      },
      required: ['type', 'startTime', 'endTime', 'reason', 'contact', 'phone'],
      additionalProperties: false,
    },
    async handler(args: Record<string, unknown>, toolContext: ToolContext) {
      const input = validateLeaveInput(args);
      if (!input.ok) return textResult(input.message);
      const form = input.value;

      return await runWithSession(toolContext.env, toolContext.credentials, async (context) => {
        // 1. 类别字典（事假 / 病假 …）
        const typeQuery = new URLSearchParams({
          name: 'MsDict',
          paramValue: 'DM_SF_QJLX',
          _t_s_: String(Date.now()),
        });
        const types = parseLeaveDict(
          await xgxtGetArray(context, `${URLS.xgxtLeaveDict}?${typeQuery}`, LEAVE_HEADERS),
        );
        const type = matchLeaveDict(types, form.type);
        if (type === null) {
          const options = types.map((item) => item.name).join('、');
          return textResult(
            `未知的请假类别“${form.type}”。可选：${options === '' ? '（未取到类别字典）' : options}。`,
          );
        }

        // 2. 离校去向：省市县逐级匹配，取最深一级（与 Dart 申请页一致）
        let region = { id: '', name: '' };
        if (form.leaveSchool) {
          const regionQuery = new URLSearchParams({
            xian_allow_empty: '0',
            _t_s_: String(Date.now()),
          });
          const regions = parseRegionNodes(
            await xgxtGetArray(context, `${URLS.xgxtLeaveRegion}?${regionQuery}`, LEAVE_HEADERS),
          );
          const province = matchRegionNode(regions, form.province);
          if (province === null) {
            return textResult(`未找到省份“${form.province}”，可传“湖南”这类关键词。`);
          }
          let deepest = province;
          if (form.city !== '') {
            const city = matchRegionNode(province.children, form.city);
            if (city === null) {
              return textResult(`“${province.name}”下未找到城市“${form.city}”。`);
            }
            deepest = city;
            if (form.county !== '') {
              const county = matchRegionNode(city.children, form.county);
              if (county === null) {
                return textResult(`“${city.name}”下未找到区县“${form.county}”。`);
              }
              deepest = county;
            }
          }
          region = { id: deepest.id, name: deepest.name };
        }

        // 3. 时长交给服务端算，并把结果带回预览给用户确认
        const calculateQuery = new URLSearchParams({
          kssj: form.startTime,
          jssj: form.endTime,
          _t_s_: String(Date.now()),
        });
        const duration = parseLeaveDuration(
          await xgxtGetJson(
            context,
            `${URLS.xgxtLeaveCalculate}?${calculateQuery}`,
            LEAVE_HEADERS,
          ),
        );

        const durationText = `${duration.days}天${duration.hours}小时`;
        const attachmentText =
          form.attachment === null
            ? '无'
            : `${form.attachment.name}（${form.attachment.bytes.length} 字节）`;
        const preview: Record<string, unknown> = {
          type: type.name,
          typeId: type.id,
          startTime: form.startTime,
          endTime: form.endTime,
          duration: durationText,
          reason: form.reason,
          contact: form.contact,
          phone: form.phone,
          companions: form.companions,
          leaveSchool: form.leaveSchool ? '是' : '否',
          destination: region.name,
          address: form.address,
          backDorm: form.backDorm ? '是' : '否',
          remark: form.remark,
          outCity: form.outCity ? '是' : '否',
          outProvince: form.outProvince ? '是' : '否',
          attachment: attachmentText,
        };

        // 4. 未确认：只返回预览，绝不写
        if (!form.confirmed) {
          const message =
            '请假申请已就绪，尚未提交。【重要】请把下面 applicationPreview 逐项呈现给用户，' +
            '确认无误并取得明确同意后，再传 confirmed=true 重新调用本工具正式提交（会真实创建请假单）。';
          return textResult(
            JSON.stringify(
              {
                status: 'requires_confirmation',
                needsUserConsent: true,
                message,
                applicationPreview: preview,
              },
              null,
              2,
            ),
            {
              status: 'requires_confirmation',
              needsUserConsent: true,
              message,
              applicationPreview: preview,
            },
          );
        }

        // 5. 已确认：真正提交。无附件 urlencoded、有附件 multipart（与 Dart 一致）。
        //    与 Dart LeaveService.submit 相同，会话失效时由 withXgxt 重登后重投一次。
        const fields = buildLeaveFields(form, type, region, duration);
        const attachment = form.attachment;
        const response = await withXgxt(
          context,
          async (): Promise<{ status: number; body: string }> => {
            const url = `${URLS.xgxtLeaveApply}?${stampQuery()}`;
            if (attachment === null) {
              const posted = await context.session.postForm(url, fields, {
                follow: false,
                headers: LEAVE_HEADERS,
              });
              return { status: posted.status, body: posted.body };
            }
            return await postMultipartWithJar(
              context,
              url,
              buildLeaveMultipartForm(fields, attachment),
            );
          },
          () => false,
        );

        const data = parseXgxtJson(response.status, response.body);
        if (data['result'] !== true) {
          throw new Error(`提交请假申请失败：${submitFailureMessage(data)}`);
        }
        return textResult(
          `请假申请提交成功：${type.name}（${form.startTime} ~ ${form.endTime}，共${durationText}）。` +
            (attachment === null ? '如需补充请假材料，请在 App 内上传。' : '附件已一并提交。'),
          {
            success: true,
            type: type.name,
            startTime: form.startTime,
            endTime: form.endTime,
            duration: durationText,
            attachment: attachment === null ? null : attachment.name,
          },
        );
      });
    },
  };

  const questionnaireSubmitTool: ToolDefinition = {
    name: 'submit_questionnaire',
    description:
      '代用户填写并提交学工问卷。【写操作，有副作用】confirmed=true 时会真实把答卷提交到学工系统。' +
      'answers 以题目标题关键词或题目 dm 为 key：单选题 value 传选项名或选项 dm（支持模糊，如“是”）；' +
      '多选题 value 传选项名数组（也接受顿号/逗号分隔的文本）；填空/电话题传文本；日期题传 YYYY-MM-DD。' +
      '【重要】首次调用保持 confirmed=false，工具返回问卷与答案预览；向用户逐题核对并取得明确同意后，' +
      '再传 confirmed=true 真正提交。已提交过的问卷允许重复提交，新答案将覆盖之前的提交。' +
      '本工具不会自动重试（避免重复投递）：若提示会话已失效，请重新调用一次。',
    inputSchema: {
      type: 'object',
      properties: {
        questionnaire: {
          type: 'string',
          description: '问卷标题关键词（如“国庆”）或问卷 id（query_questionnaires 返回的 taskTimeM/dm）。',
        },
        answers: {
          type: 'object',
          description:
            '答案映射：key 为题目标题关键词或题目 dm，value 为答案（单选传选项名/选项 dm，多选传数组，填空/日期传文本）。',
          additionalProperties: { type: ['string', 'array'], items: { type: 'string' } },
        },
        confirmed: {
          type: 'boolean',
          description:
            '用户是否已对预览中的每道题答案做最终确认。默认为 false；仅当用户明确同意提交后才传 true。',
          default: false,
        },
      },
      required: ['questionnaire', 'answers'],
      additionalProperties: false,
    },
    async handler(args: Record<string, unknown>, toolContext: ToolContext) {
      const keyword = typeof args['questionnaire'] === 'string' ? args['questionnaire'].trim() : '';
      if (keyword === '') {
        return textResult('请指定问卷标题关键词或 id（可先用 query_questionnaires 查看列表）。');
      }
      const rawAnswers = args['answers'];
      if (!isRecord(rawAnswers)) {
        return textResult('answers 须为对象（题目关键词或题目 dm -> 答案）。');
      }
      const confirmed = args['confirmed'] === true;

      return await runWithSession(toolContext.env, toolContext.credentials, async (context) => {
        // 1. 列表 + 详情：都是 GET，会话失效交给 withXgxt 换票重试
        const listQuery = new URLSearchParams({
          bSortable_0: 'false',
          bSortable_1: 'false',
          iSortingCols: '1',
          iDisplayStart: '0',
          iDisplayLength: '200',
          iSortCol_0: '3',
          sSortDir_0: 'desc',
          _t_s_: String(Date.now()),
        });
        const items = parseQuestionnaireItems(
          await xgxtGetJson(context, `${URLS.xgxtQuestionnaireList}?${listQuery}`, API_HEADERS),
        );
        const matched = matchQuestionnaire(items, keyword);
        if (matched === null) {
          return textResult(`未找到问卷“${keyword}”，可先调用 query_questionnaires 查看列表。`);
        }
        if (matched.taskTimeM === '') {
          return textResult('该问卷缺少任务标识（TASK_TIME_M），无法填写。');
        }

        const detailQuery = new URLSearchParams({
          tasktime: matched.taskTimeM,
          busType: '',
          _t_s_: String(Date.now()),
        });
        const detail = parseQuestionnaireDetail(
          await xgxtGetJson(context, `${URLS.xgxtQuestionnaireDetail}?${detailQuery}`, API_HEADERS),
        );
        if (!detail.canSubmit) {
          return textResult(`问卷《${detail.title}》当前不可提交（可能已截止）。`);
        }

        // 2. 逐题把用户答案映射成提交载荷
        const resolved = resolveQuestionnaireAnswers(detail, rawAnswers);
        if (!resolved.ok) return textResult(resolved.message);

        const isResubmit = isQuestionnaireSubmitted(matched);
        if (!confirmed) {
          const message =
            '学工问卷已就绪，尚未提交。【重要】请把下面 answersPreview 逐题呈现给用户，' +
            '确认无误并取得明确同意后，再传 confirmed=true 重新调用本工具正式提交。' +
            (isResubmit ? '注意：该问卷已提交过，本次提交将覆盖之前的答案。' : '');
          return textResult(
            JSON.stringify(
              {
                status: 'requires_confirmation',
                needsUserConsent: true,
                message,
                questionnaire: detail.title,
                isResubmit,
                answersPreview: resolved.value.preview,
              },
              null,
              2,
            ),
            {
              status: 'requires_confirmation',
              needsUserConsent: true,
              message,
              questionnaire: detail.title,
              isResubmit,
              answersPreview: resolved.value.preview,
            },
          );
        }

        // 3. 已确认：手工拼 urlencoded body 提交。
        //    只发一次，不自动重试（避免重复投递）；会话若在提交瞬间失效，直接如实告知用户重来。
        const body = buildQuestionnaireBody(resolved.value.fields, detail.jgM);
        await ensureXgxtSession(context);
        const response = await context.session.request(
          `${URLS.xgxtQuestionnaireSubmit}?${stampQuery()}`,
          {
            method: 'POST',
            headers: {
              ...API_HEADERS,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
            follow: false,
          },
        );

        let data: Record<string, unknown>;
        try {
          data = parseXgxtJson(response.status, response.body);
        } catch (error) {
          if (error instanceof SessionExpiredError) {
            return textResult(
              '提交未完成：提交瞬间学工系统会话已失效（本次未提交成功，也没有自动重试，以免重复投递）。' +
                '请重新调用本工具提交一次。',
            );
          }
          throw error;
        }
        if (data['result'] !== true) {
          throw new Error(`提交问卷失败：${submitFailureMessage(data)}`);
        }
        return textResult(`问卷《${detail.title}》提交成功！`, {
          success: true,
          questionnaire: detail.title,
          isResubmit,
        });
      });
    },
  };

  return [listTool, detailTool, leaveListTool, leaveDetailTool, leaveSubmitTool, questionnaireSubmitTool];
}

export { looksLikeLoginPage };
