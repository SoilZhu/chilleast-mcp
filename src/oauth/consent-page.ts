/**
 * `/authorize` 的两步式授权确认页（Consent Screen）。
 *
 * 参考 Google OAuth 2.0 授权确认规范设计，采用全左对齐布局，
 * 明确告知权限范围、回调域名与安全风险提示，防范钓鱼攻击并赋予用户最终知情确认权。
 */

import { escapeHtml, pageShell } from './ui';

export interface ConsentPageOptions {
  clientName: string;
  redirectUri: string;
  oaId: string;
  consentTicket: string;
}

export function renderConsentPage(options: ConsentPageOptions): string {
  let domain = '';
  try {
    domain = new URL(options.redirectUri).hostname;
  } catch {
    domain = options.redirectUri;
  }

  const clientTitle = options.clientName.trim() !== '' ? options.clientName : domain;

  const body = `      <div class="main">
      <h1 class="consent-title"><strong>${escapeHtml(clientTitle)}</strong> 想要访问您的校园账号</h1>

      <div class="consent-lead">这将允许 <strong>${escapeHtml(clientTitle)}</strong> 执行以下操作：</div>

      <div class="scope-list">
        <div class="scope-item">
          <svg class="scope-icon" viewBox="0 0 24 24" fill="none" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          <span>查看您的课表日程、考试安排、作业、通知与各学期成绩绩点，并添加作业</span>
        </div>
        <div class="scope-item">
          <svg class="scope-icon" viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          <span>检索图书馆藏书目与借阅状态，并进行阅览室座位预约</span>
        </div>
        <div class="scope-item">
          <svg class="scope-icon" viewBox="0 0 24 24" fill="none" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
          <span>查询校园卡账户可用余额与近期消费流水明细，并进行电费充值</span>
        </div>
        <div class="scope-item">
          <svg class="scope-icon" viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M9 14l2 2 4-4"/></svg>
          <span>读取您的报修平台、阳光服务与学工系统，并填写与提交工单或问卷</span>
        </div>
      </div>

      <div class="trust-card">
        <h3>请确保您信任 ${escapeHtml(clientTitle)}</h3>
        <p>您可能会与此应用共享校园个人信息。请务必核对回调目标域名：<span class="client-domain">${escapeHtml(domain)}</span>。</p>
      </div>

      <form method="POST" action="/authorize">
        <input type="hidden" name="action" value="consent">
        <input type="hidden" name="consent_ticket" value="${escapeHtml(options.consentTicket)}">
        <div class="actions">
          <button type="submit" name="decision" value="cancel" class="btn-secondary">取消</button>
          <button type="submit" name="decision" value="approve">允许</button>
        </div>
      </form>
      </div>`;

  return pageShell({ title: '授权应用接入 · 自在东湖 MCP 服务', body, panelClass: 'panel--centered' });
}
