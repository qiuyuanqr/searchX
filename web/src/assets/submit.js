// 提交表单的纯逻辑：拼载荷 + 把响应映射成中文。
// DOM 引导（打开/关闭弹窗、提交、Turnstile 渲染）统一由 feed.js 负责，feed.js 从这里 import 这两个纯函数。
// 纯函数：从表单字段值 + turnstile token 拼 POST 载荷。
export function buildPayload(fields, turnstileToken) {
  const s = (v) => (v == null ? "" : String(v)).trim();
  return {
    title: s(fields.title),
    focus: s(fields.focus),
    email: s(fields.email),
    message: s(fields.message),
    turnstile: turnstileToken || "",
  };
}

// 纯函数：HTML 转义（覆盖元素内容与双引号属性两种场景）。
export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 纯函数：把 Pagefind 命中项渲染成搜索结果列表 HTML。
// title 与 url 来自被检索的报告内容，直接拼进 innerHTML 会有 DOM-XSS，必须先转义；
// excerpt 是 Pagefind 生成的高亮片段（含 <mark>），按其约定原样保留。
export function renderSearchResultsHTML(items) {
  return items
    .map((d) => {
      const url = escapeHtml(d.url);
      const title = escapeHtml(d.meta && d.meta.title) || "(无标题)";
      const ex = d.excerpt == null ? "" : String(d.excerpt);
      return `<div class="result"><a href="${url}"><h3>${title}</h3><p class="ex">${ex}</p></a></div>`;
    })
    .join("");
}

// 纯函数：把服务端响应（或异常）映射成给用户看的中文。
export function describeResult(res) {
  if (res && res.ok) {
    return {
      kind: "success",
      text: "已提交，作者会尽快审核。审核通过后研究结果会发到你的邮箱。",
    };
  }
  const map = {
    invalid: "请检查：题目和邮箱必填，且长度别超限。",
    bad_json: "提交格式有误，请重试。",
    turnstile_failed: "人机验证未通过，请重试。",
    ip_rate_limited: "今天提交太多次了，请明天再来。",
    email_rate_limited: "这个邮箱今天提交太多次了，请明天再来。",
    issue_create_failed: "服务器开小差了，请稍后重试。",
  };
  const code = res && res.error;
  return { kind: "error", text: map[code] || "提交失败，请稍后重试。" };
}
