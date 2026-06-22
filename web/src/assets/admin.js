// web/src/assets/admin.js — 授权管理页的纯逻辑（拼链接 / 渲染列表 / 文案）。
// DOM 引导内联在 admin.template.html 的 <script type="module"> 里 import 这些函数。
export function escapeHtml(s){
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 按站点 base 拼专属提交链接（base = admin.html 所在站点根，submit 表单也在该根的首页弹窗）。
export function inviteLink(base, token){
  return new URL("?k=" + encodeURIComponent(token), base).href;
}

// 把授权人列表渲染成表格行。email/链接拼进 innerHTML 前必须转义防 DOM-XSS。
export function renderPeopleRows(people, base){
  return (people || []).map((p) => {
    const email = escapeHtml(p.email);
    const link = escapeHtml(inviteLink(base, p.token));
    return `<tr><td>${email}</td>`
      + `<td><input class="search" readonly value="${link}"></td>`
      + `<td><button class="linklike" data-act="copy" data-link="${link}">复制</button> `
      + `<button class="linklike" data-act="revoke" data-email="${email}">撤销</button></td></tr>`;
  }).join("");
}

export function describeAdminError(status){
  if (status === 401) return "密钥不对，请重输管理密钥。";
  if (status === 429) return "尝试过多已临时锁定，请稍后再试。";
  if (status === 400) return "邮箱格式不对。";
  return "操作失败，请重试。";
}
