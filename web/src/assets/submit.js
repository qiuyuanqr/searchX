import { seriesBadgeHtml } from "./series-badge.js";

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
// 旧式链接（2026-07-31 之前发出去的）都是这个形态，永久兼容。
export function tokenFromQuery(search) {
  try {
    return new URLSearchParams(search || "").get("k") || "";
  } catch {
    return "";
  }
}

// 纯函数：从 location.hash 取专属链接里的 token（#k=…）；无则空串。
// 新式链接用 fragment：hash 不会随 HTTP 请求发给服务端，因此 token 不会落进 Pages / Worker
// 的访问日志，也不会随 referer 外泄——与同仓库 check.html 的 CHECK_KEY 同一做法。
export function tokenFromHash(hash) {
  try {
    return new URLSearchParams(String(hash || "").replace(/^#/, "")).get("k") || "";
  } catch {
    return "";
  }
}

// 本机持久化 token 的键。token 永不过期、是提交的唯一凭证，存 localStorage 让授权能跨整页跳转
// （点开报告→返回首页）、刷新、以及从手机主屏图标冷启动后恢复——这些导航都不带 ?k=。
export const TOKEN_STORAGE_KEY = "searchx_invite_token";

// 纯函数：解析当前可用的 token。优先级 #k=（新式链接）＞ ?k=（旧式链接，永久兼容）＞ 本机存储。
// 链接里带的一律落盘覆盖旧值，支持换人 / 换链接。
// storage 不可用（隐私模式、被禁用、为 null）时静默降级，绝不抛出。
// 第二个参数兼容两种调用形态：传 location 对象（推荐）或只传 search 字符串（旧调用方）。
export function resolveToken(loc, storage) {
  const { search, hash } = typeof loc === "string" ? { search: loc, hash: "" } : (loc || {});
  const fromUrl = tokenFromHash(hash) || tokenFromQuery(search);
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

// 到 Worker 的 fetch 一律带超时：自定义域 / workers.dev 都可能在部分网络被黑洞（SNI 阻断），
// 连接挂起既不成功也不报错，没超时就永远「提交中…」（2026-07-03 巨轮智能提交静默丢失即此因）。
// AbortSignal.timeout 不存在时手动兜底。与 check-page.js 的 timeoutSignal 同构。
export function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

export const WORKER_TIMEOUT_MS = 10000;

// 依次尝试同一 Worker 的多个入口（自定义域 → workers.dev 回退），谁先给出 HTTP 响应就用谁；
// 空串端点滤掉、重复端点去重。全部失败抛最后一个错误，由调用方映射成失败文案。
// POST 场景的已知取舍：主端点「超时但其实已送达」时改打备用端点会双发——换来的是
// 封锁网络下提交不再静默丢失；重复提交由查重与人工审核兜底，代价可接受。
export async function fetchAny(urls, options, { fetchImpl = fetch, timeoutMs = WORKER_TIMEOUT_MS } = {}) {
  const list = [...new Set((urls || []).filter(Boolean))];
  let lastErr = new Error("no_endpoint");
  for (const url of list) {
    try {
      return await fetchImpl(url, { ...options, signal: timeoutSignal(timeoutMs) });
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
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

// 纯函数：按 Pagefind 命中的 URL 反查 reports.json 里的报告条目（拿日期/类型等元信息）。
// Pagefind 的 URL 是站点根相对（如 /r/2026-07-03_xxx/，子路径部署则带前缀），清单里 href 是
// 相对路径（r/2026-07-03_xxx/）——归一化后按路径后缀匹配；查不到返回 null（结果卡退化为无元信息）。
export function findReportMeta(url, entries) {
  if (!url) return null;
  let u = String(url).split(/[?#]/)[0].replace(/index\.html$/, "");
  if (!u.endsWith("/")) u += "/";
  for (const e of entries || []) {
    if (!e || !e.href) continue;
    let h = String(e.href);
    if (!h.endsWith("/")) h += "/";
    if (u === h || u.endsWith("/" + h)) return e;
  }
  return null;
}

// 纯函数：把 Pagefind 命中项渲染成搜索结果列表 HTML。
// title 与 url 来自被检索的报告内容，直接拼进 innerHTML 会有 DOM-XSS，必须先转义。
// excerpt 同样是不可信内容——它是从报告正文里摘出来的片段，而报告正文由全权限 headless
// Claude 生成。老实现「按 Pagefind 约定原样保留」等于把报告正文直接写进首页的 innerHTML：
// Pagefind 只承诺注入 <mark>，其余一律当文本处理才对。做法是先整段转义，再把被转义的
// &lt;mark&gt; 还原成真标签。
// entries（可选）= reports.json 清单：能反查到条目时，结果卡带「日期 · 类型」元信息，与信息流卡片一致。

// 搜索片段：整段转义后只放行 <mark>（Pagefind 唯一承诺注入的标签）。
export function renderExcerpt(excerpt) {
  if (excerpt == null) return "";
  return escapeHtml(String(excerpt))
    .replace(/&lt;mark&gt;/g, "<mark>")
    .replace(/&lt;\/mark&gt;/g, "</mark>")
    // Pagefind 给的 excerpt 不是裸文本：正文里的 < > 它已经转义过（&lt; / &gt;），只有 & 是裸的。
    // 整段再 escapeHtml 一遍会把这些实体二次转义成 &amp;lt;，页面上直接显示字面「&lt; 46%」。
    // 股票报告里「毛利率 &lt; 46%」「前五客户 &gt;80%」这类写法很常见，把它们还原回来。
    // 只还原 lt/gt：Pagefind 转义的就只有 < 和 >（& 它原样留着），把 &amp; 也还原会把正文里
    // 字面写的「&amp;」错误地渲染成「&」。
    .replace(/&amp;(lt|gt);/g, "&$1;");
}

export function renderSearchResultsHTML(items, entries) {
  return items
    .map((d) => {
      const url = escapeHtml(d.url);
      const title = escapeHtml(d.meta && d.meta.title) || "(无标题)";
      const ex = renderExcerpt(d.excerpt);
      const entry = findReportMeta(d.url, entries);
      const meta = entry
        ? `<div class="rmeta">${escapeHtml(String(entry.date || "").replace(/-/g, "·"))}${entry.type ? " · " + escapeHtml(entry.type) : ""}</div>`
        : "";
      // 系列角标（「第 N 次」）：series 由构建写进 reports.json（web/build/series.js），
      // 与信息流卡片同一份数据。旧篇 2026-08-28 起已从 reports.json 与全文索引剔除，
      // 搜索结果里只会出现最新篇，不再需要压暗与「已有更新版」那套。
      const series = entry && entry.series;
      const badge = seriesBadgeHtml(series);
      return `<div class="result"><a href="${url}"><h3>${title}${badge}</h3><p class="ex">${ex}</p>${meta}</a></div>`;
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
    // degraded：Issue 建成了，但配套的 KV 写（限频计数、issue 号→邮箱映射）失败。
    // 邮箱映射写不进去，runner 跑完就查不到该发给谁——那封「已上线」邮件永远发不出。
    // Worker 特意把这个信号回传给前端，前端却只看 ok、照样承诺「结果会发到你的邮箱」，
    // 于是提交者干等一场、也无从知道出了什么事。这里把它如实说出来。
    if (res.degraded) {
      return {
        kind: "warn",
        text: "已提交，作者会尽快审核。但服务器暂时没能记下你的邮箱，结果可能发不到你邮箱里——请留意站点更新，或直接联系作者。",
      };
    }
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
