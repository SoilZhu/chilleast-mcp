/**
 * `/authorize` 的登录页 —— 用户浏览器里唯一能看到的一页。
 *
 * 布局与样式在 `ui.ts` 里（左品牌区 + 右 Material 表单列），本文件只负责内容：
 * 账号/密码、验证码、同意勾选，以及下面那段必须读的声明。
 */

import { escapeHtml, pageShell, turnstileWidget } from './ui';

/**
 * 渲染登录页。
 *
 * @param params  OAuth 参数（原样放进 hidden，POST 回来时不能丢）
 * @param oaId    上次填的账号（登录失败重填时不用再输一遍）
 * @param error   错误信息；非 null 时显示 Material 的 error container
 * @param siteKey 验证码 sitekey；为空时不渲染 widget（服务端仍会 fail closed）
 */
export function renderAuthorizePage(
  params: Array<[string, string]>,
  oaId: string,
  error: string | null,
  siteKey = '',
): string {
  const hidden = params
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${escapeHtml(value)}">`)
    .join('\n        ');

  const errorBlock =
    error === null
      ? ''
      : `
        <div class="error" role="alert">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 1 21h22L12 2zm0 6 6.5 11h-13L12 8zm-1 3v4h2v-4h-2zm0 5v2h2v-2h-2z"/></svg>
          <span>${escapeHtml(error)}</span>
        </div>`;

  const body = `      <div class="main">
      <h1 class="title">登录「自在东湖」MCP 服务</h1>
      <form method="POST" action="/authorize" onsubmit="var b=this.querySelector('button[type=submit]');if(b){b.classList.add('is-submitting');setTimeout(function(){b.disabled=true;},0);}">
        ${hidden}
        <div class="field">
          <input id="oa_id" name="oa_id" type="text" inputmode="numeric" autocomplete="username"
                 value="${escapeHtml(oaId)}" required>
          <label for="oa_id">账号</label>
        </div>
        <div class="field">
          <input id="oa_key" name="oa_key" type="password" autocomplete="current-password" required>
          <label for="oa_key">密码</label>
        </div>${errorBlock}
${turnstileWidget(siteKey)}
        <label class="consent">
          <input type="checkbox" name="consent" value="on" required>
          <span>我已阅读并同意下方的隐私与数据处理说明。</span>
        </label>
        <div class="actions"><button type="submit">登录</button></div>
      </form>

      <details class="accordion">
        <summary>
          <span>隐私与数据处理说明</span>
          <span class="acc-hint"><span class="when-closed">展开</span><span class="when-open">收起</span></span>
          <span class="chev">&#9662;</span>
        </summary>
        <div class="acc-body">
          本服务不以任何方式持久化记录或储存您的用户名与密码；授权后，凭据将令牌加密后由客户端储存。如需解除授权，在客户端中删除连接器即可。
        </div>
      </details>
      </div>`;

  return pageShell({ title: '登录 · 自在东湖 MCP 服务', body, panelClass: 'panel--centered' });
}
