/**
 * CIMS 统一认证登录页解析（对齐 ChillEast `cims_login.dart`）。
 *
 * 安全约束：只解析页面里的字符串字面量，绝不执行页面提供的 JavaScript。
 */

export interface CimsBootstrap {
  /** CAS 登录页自身（iframe 的 parent 参数就是它） */
  parentUri: string;
  /** CAS 表单 POST 目标 */
  postUri: string;
  /** 认证 SDK 的 iframe 地址 */
  iframeUri: string;
  /** 认证接口 base，如 https://sso.hunau.edu.cn/authn/ */
  authBase: string;
  /** CAS 表单里的 hidden 字段（含 execution） */
  fields: Array<[string, string]>;
  /** 承载 usersign 的字段名（本项目实测为 signedCimsResponse） */
  signatureField: string;
  /** 服务端下发的应用侧签名 */
  appSignature: string;
  /** 服务端下发的请求签名 */
  sign: string;
  /** 认证完成后的回跳地址（service 参数） */
  appUrl: string;
}

export class CimsLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CimsLoginError';
  }
}

/**
 * CIMS 用的是 JavaScript 的 decodeURI，不是 decodeURIComponent，也不是表单解码。
 * 特别注意 base64 的 %3D %2B %2F 必须保持百分号编码状态。
 */
export function decodeCimsUri(value: string): string {
  const reserved = /%(?:3B|2F|3F|3A|40|26|3D|2B|24|2C|23)/gi;
  let result = '';
  let start = 0;
  let match: RegExpExecArray | null;
  reserved.lastIndex = 0;
  while ((match = reserved.exec(value)) !== null) {
    result += safeDecode(value.slice(start, match.index));
    result += match[0];
    start = match.index + match[0].length;
  }
  result += safeDecode(value.slice(start));
  return result;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const STRING_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\u000b',
  '0': '\u0000',
  '\\': '\\',
  '/': '/',
  "'": "'",
  '"': '"',
};

/** 把 JS 字符串字面量（含引号）还原成实际字符串。 */
function unescapeLiteral(literal: string, optionName: string): string {
  let output = '';
  for (let i = 1; i < literal.length - 1; i++) {
    const char = literal[i];
    if (char !== '\\') {
      output += char;
      continue;
    }
    const escaped = literal[++i];
    if (escaped === undefined) throw new CimsLoginError(`无法解析登录页配置：${optionName}`);
    const simple = STRING_ESCAPES[escaped];
    if (simple !== undefined) {
      output += simple;
    } else if (escaped === 'u' || escaped === 'x') {
      const count = escaped === 'u' ? 4 : 2;
      if (i + count >= literal.length - 1) {
        throw new CimsLoginError(`无法解析登录页配置：${optionName}`);
      }
      const hex = literal.slice(i + 1, i + count + 1);
      if (!/^[0-9a-f]+$/i.test(hex)) {
        throw new CimsLoginError(`无法解析登录页配置：${optionName}`);
      }
      output += String.fromCharCode(Number.parseInt(hex, 16));
      i += count;
    } else {
      throw new CimsLoginError(`无法解析登录页配置：${optionName}`);
    }
  }
  return output;
}

/** 只读取字符串字面量形式的配置项。 */
function literalOption(config: string, name: string, defaultValue?: string): string {
  const pattern = new RegExp(
    `(?:^|[,\\n])\\s*${escapeRegExp(name)}\\s*:\\s*((?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'))\\s*(?=,|$)`,
  );
  const match = pattern.exec(config);
  if (match === null) {
    // 「存在但不是字面量」和「不存在」不是一回事，不能都当默认值处理
    const present = new RegExp(`\\b${escapeRegExp(name)}\\s*:`).test(config);
    if (defaultValue !== undefined && !present) return defaultValue;
    throw new CimsLoginError(`无法解析登录页配置：${name}`);
  }
  return unescapeLiteral(match[1], name);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从 HTML 中收集 `#cims_form` 的 hidden 字段。用 HTMLRewriter，免手写正则解析属性。 */
async function collectFormFields(html: string): Promise<{
  foundForm: boolean;
  fields: Array<[string, string]>;
}> {
  const fields: Array<[string, string]> = [];
  let foundForm = false;
  let foundFormElement = false;

  // workerd 实测坑：`HTMLRewriter.transform().text()` 对**空响应体**永远不会
  // resolve（会一直挂到超时）。空输入本来也没有可解析的内容，直接短路。

  if (html.trim() === '') return { foundForm: false, fields };

  const rewriter = new HTMLRewriter()
    .on('form#cims_form', {
      element() {
        foundFormElement = true;
      },
    })
    .on('#cims_form input', {
      element(element) {
        foundForm = true;
        const name = element.getAttribute('name');
        if (name === null || name === '') return;
        if ((element.getAttribute('type') ?? '').toLowerCase() !== 'hidden') return;
        if (element.hasAttribute('disabled')) return;
        fields.push([name, element.getAttribute('value') ?? '']);
      },
    });

  await rewriter.transform(new Response(html)).text();
  return { foundForm: foundForm || foundFormElement, fields };
}

/**
 * 解析 CAS 登录页，产出后续认证所需的全部参数。
 * @param html 登录页 HTML
 * @param uri 该页面的最终 URL（会被当作 iframe 的 parent）
 */
export async function parseCimsBootstrap(html: string, uri: string): Promise<CimsBootstrap> {
  const parsedUri = new URL(uri);
  assertTrustedSso(parsedUri);

  const match = /CIMS\.init\s*\(\s*\{(.*?)\}\s*\)/s.exec(html);
  if (match === null) {
    throw new CimsLoginError('未找到 CIMS 登录配置，登录入口可能已变化');
  }
  const config = match[1];

  if (/\bsubmit_callback\s*:/.test(config)) {
    throw new CimsLoginError('登录页使用了尚未支持的自定义提交回调');
  }
  if (literalOption(config, 'username', '') !== '') {
    throw new CimsLoginError('本次登录需要二次认证，请在官方页面完成验证');
  }

  const signatures = literalOption(config, 'sig_request').split(':');
  if (
    signatures.length !== 2 ||
    signatures.some((s) => s === '') ||
    (signatures[0] ?? '').startsWith('ERR|')
  ) {
    throw new CimsLoginError('服务端未返回有效的初始签名');
  }

  const host = literalOption(config, 'host').replace(/\/+$/, '');
  const authBase = assertTrustedSso(new URL(`${host}/`));
  const postUri = assertTrustedSso(new URL(literalOption(config, 'postaction'), parsedUri));

  const formId = literalOption(config, 'formid');
  const signatureField = literalOption(config, 'postArgument', 'sig_response');
  const version = literalOption(config, 'version', 'v2');
  const email = literalOption(config, 'email', '');
  const reAuthError = literalOption(config, 'reAuthError', 'false');

  const { foundForm, fields } = await collectFormFields(html);
  if (!foundForm) {
    throw new CimsLoginError(`未找到 CAS 登录表单：${formId}`);
  }
  if (!fields.some(([key, value]) => key === 'execution' && value !== '')) {
    throw new CimsLoginError('CAS 登录表单缺少 execution');
  }

  const params: Array<[string, string]> = [
    ['view', 'frame'],
    ['type', '0'],
    ['sign', signatures[0]],
    ['parent', parsedUri.toString()],
    ['version', version],
    ['email', email],
    ['reAuthError', reAuthError],
  ];
  const iframeUri =
    new URL('login.html', authBase).toString() +
    '?' +
    params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  // 按 SDK 的 query 解析语义：空值当 'true'，且 parent 会被二次解码
  const query: Record<string, string> = {};
  for (const pair of iframeUri.slice(iframeUri.indexOf('?') + 1).split('&')) {
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const rawValue = eq < 0 ? '' : pair.slice(eq + 1);
    if (key !== '') {
      query[key] = rawValue !== '' ? decodeCimsUri(rawValue) : 'true';
    }
  }
  if (query['sign'] === undefined) {
    throw new CimsLoginError('无法解析登录页配置：sign');
  }
  const parent = safeDecode(query['parent'] ?? '');
  const serviceIndex = parent.indexOf('service=');

  return {
    parentUri: parsedUri.toString(),
    postUri: postUri.toString(),
    iframeUri,
    authBase: authBase.toString(),
    fields,
    signatureField,
    appSignature: signatures[1],
    sign: query['sign'],
    appUrl: serviceIndex < 0 ? '' : parent.slice(serviceIndex + 'service='.length),
  };
}

/**
 * 只允许向预期的 HTTPS SSO 源发送凭据。
 * 返回规范化后的 URL —— 调用方必须使用返回值，避免校验与使用不是同一个 URL。
 */
export function assertTrustedSso(url: URL): URL {
  if (url.protocol !== 'https:' || url.hostname !== 'sso.hunau.edu.cn' || url.port !== '') {
    throw new CimsLoginError(`拒绝向非预期域名发送认证请求：${url.origin}`);
  }
  return url;
}

export const __testing = { literalOption, unescapeLiteral, escapeRegExp };
