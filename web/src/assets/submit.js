// 提交表单的纯逻辑：拼载荷 + 把响应映射成中文。
// DOM 引导（打开/关闭弹窗、提交、Turnstile 渲染）统一由 feed.js 负责，feed.js 从这里 import 这两个纯函数。
// 纯函数：从表单字段值 + 专属链接里的 token 拼 POST 载荷。
// 邮箱不再由用户输入——由 token 在 Worker 端反查得到，故载荷不含 email。
export function buildPayload(fields, token) {
  const s = (v) => (v == null ? "" : String(v)).trim();
  return {
    k: token || "",
    title: s(fields.title),
    focus: s(fields.focus),
    message: s(fields.message),
  };
}

// 纯函数：从 location.search 取专属链接里的 token（?k=…）；无则空串。
export function tokenFromQuery(search) {
  try {
    return new URLSearchParams(search || "").get("k") || "";
  } catch {
    return "";
  }
}

// 本机持久化 token 的键。token 永不过期、是提交的唯一凭证，存 localStorage 让授权能跨整页跳转
// （点开报告→返回首页）、刷新、以及从手机主屏图标冷启动后恢复——这些导航都不带 ?k=。
export const TOKEN_STORAGE_KEY = "searchx_invite_token";

// 纯函数：解析当前可用的 token。优先用 URL 里的 ?k=（并落盘覆盖旧值，支持换人/换链接）；
// URL 没有就回退到 storage。storage 不可用（隐私模式、被禁用、为 null）时静默降级，绝不抛出。
export function resolveToken(search, storage) {
  const fromUrl = tokenFromQuery(search);
  if (fromUrl) {
    try { storage && storage.setItem(TOKEN_STORAGE_KEY, fromUrl); } catch {}
    return fromUrl;
  }
  try { return (storage && storage.getItem(TOKEN_STORAGE_KEY)) || ""; } catch { return ""; }
}

// 纯函数：清掉本机存的 token（服务端判定其无效/已撤销时调用，避免失效凭证赖在设备上）。
export function clearStoredToken(storage) {
  try { storage && storage.removeItem(TOKEN_STORAGE_KEY); } catch {}
}

// 纯函数：把 /verify 响应映射成授权态。authorized=true 时回显打码邮箱。
export function describeVerify(res) {
  if (res && res.ok) {
    return { authorized: true, email: (res.email || ""), text: `已授权：${res.email || ""}，可直接提交。` };
  }
  return { authorized: false, email: "", text: "需要专属链接才能提交。请联系作者获取你的专属链接，用它打开本页再提交。" };
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

// 纯函数：把"已有报告"命中渲染成提示 HTML。title/href 来自报告数据，拼进 innerHTML 前必须转义防 DOM-XSS。
// match = findFreshReport 的返回 { entry, ageDays, matchedBy }；无命中返回空串。
export function describeExistingReport(match) {
  if (!match || !match.entry) return "";
  const title = escapeHtml(match.entry.title) || "这个标的";
  const href = escapeHtml(match.entry.href || "#");
  const age = Number.isFinite(match.ageDays) ? match.ageDays : null;
  const when = age === 0 ? "今天刚调研过" : age != null ? `${age} 天内已调研过` : "已经调研过";
  return `📄 ${when}：「${title}」。<a href="${href}" target="_blank" rel="noopener">点此查看报告 →</a> 不用重复提交啦；如确需基于最新情况重做，可邮件联系作者。`;
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
    invalid: "请检查：题目必填，且各项长度别超限。",
    bad_json: "提交格式有误，请重试。",
    unauthorized: "需要专属链接才能提交。请用作者给你的专属链接打开本页再提交。",
    ip_rate_limited: "今天提交太多次了，请明天再来。",
    email_rate_limited: "你今天提交太多次了，请明天再来。",
    issue_create_failed: "服务器开小差了，请稍后重试。",
  };
  const code = res && res.error;
  return { kind: "error", text: map[code] || "提交失败，请稍后重试。" };
}
