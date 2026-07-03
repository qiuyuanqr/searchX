// web/src/assets/check.js — 事实核查提交页的纯逻辑（构造载荷 / 密钥读写 / 状态文案）。
// DOM 引导在 check-page.js；本文件只导出纯函数，可直接单测，不依赖 DOM / 全局。

// 纯函数：从传入的 storage 读密钥（key 名固定）。调用方注入 localStorage（持久免登）或单测 fake。
export function readKey(storage) {
  try { return storage.getItem("searchx_check_key") || ""; } catch { return ""; }
}

// 纯函数：把密钥写入传入的 storage。
export function saveKey(storage, key) {
  try { storage.setItem("searchx_check_key", key); } catch {}
}

// 纯函数：清除密钥。
export function clearKey(storage) {
  try { storage.removeItem("searchx_check_key"); } catch {}
}

// 纯函数：从 URL hash 提取免密专属链接携带的密钥（形如 "#k=<key>"）。非该形式返回空串。
// 密钥放 fragment 而非 query：fragment 永远不随 HTTP 请求发出，不进 Pages 访问日志。
export function keyFromHash(hash) {
  const m = /^#k=(.+)$/.exec(hash || "");
  if (!m) return "";
  let raw = m[1];
  try { raw = decodeURIComponent(raw); } catch {}
  return raw.trim();
}

// 纯函数：把服务端状态码映射成给用户看的中文。
// 注：401（密钥失效）在 check-page.js 提前专门处理（清密钥、退回密钥闸），不会走到这里。
export function describeCheckResult(ok) {
  if (ok) return { kind: "success", text: "已提交，可在下方「最近核查」跟踪进度与结论。" };
  return { kind: "error", text: "提交失败，请稍后重试。" };
}

// 纯函数：提交 fetch 的超时毫秒数。带图片时上传量大（慢网可达数十 MB 分钟级），给更长限时，
// 避免"网络慢但能通"的提交被误杀；纯文字/链接的请求本应秒回，30 秒足够判死。
export function submitTimeoutMs(imageCount) {
  return (imageCount || 0) > 0 ? 120000 : 30000;
}

// 纯函数：把提交阶段抛出的异常映射成给用户看的中文。
// 超时（TimeoutError；AbortError 是旧浏览器超时兜底的中断名）单独给文案——这类多半是
// 当前网络到核查服务不通（如运营商屏蔽），指引换网络比笼统"重试"有用。
export function describeSubmitError(err) {
  const name = (err && err.name) || "";
  if (name === "TimeoutError" || name === "AbortError") {
    return { kind: "error", text: "提交超时：当前网络似乎连不上核查服务，请换个网络（如切流量/开代理）再试。" };
  }
  return { kind: "error", text: "网络错误，请检查连接后重试。" };
}

// 纯函数：最近核查列表加载失败 → 给用户看的一行提示（渲染进列表区，不再静默）。
// status 是 HTTP 状态码；0 / undefined 表示网络层失败（超时、不可达）。
export function describeRecentError(status) {
  if (status === 401) return "密钥已失效，请点「退出」后重新输入。";
  if (status === 429) return "请求过于频繁被暂时限流，请稍后再试。";
  if (status) return `列表加载失败（HTTP ${status}），可点「刷新」重试。`;
  return "连不上核查服务（网络不通或被屏蔽），可点「刷新」重试。";
}

// 纯函数：按长边等比缩放尺寸。长边 ≤ maxEdge 原样返回（不放大），否则缩到长边 = maxEdge。
// 保字迹优先：截图只在确实过大时才缩，给模型读图留余量。退化输入（0）原样返回、不崩。
export function fitDimensions(w, h, maxEdge) {
  const W = Math.max(0, Math.round(w || 0));
  const H = Math.max(0, Math.round(h || 0));
  if (!W || !H) return { width: W, height: H };
  const longest = Math.max(W, H);
  if (longest <= maxEdge) return { width: W, height: H };
  const scale = maxEdge / longest;
  return { width: Math.round(W * scale), height: Math.round(H * scale) };
}

// 纯函数：最近核查列表的状态章文案与配色（kind 对齐 .form-status 的三色约定）。
export function describeTaskStatus(status) {
  if (status === "pending") return { label: "排队中", kind: "pending" };
  if (status === "done") return { label: "已完成", kind: "success" };
  if (status === "failed") return { label: "已失败", kind: "error" };
  return { label: status || "未知", kind: "pending" };
}

// 纯函数：ISO 时间 → 北京时间 "MM-DD HH:mm" 显示；非法输入返回空串。
export function formatTaskTime(iso) {
  const d = new Date(iso || "");
  if (isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || "";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

// 纯函数：列表里还有排队中的任务才继续轮询，全部终态即停。
export function shouldKeepPolling(tasks) {
  return Array.isArray(tasks) && tasks.some((t) => t && t.status === "pending");
}

// 纯函数：校验提交是否可发。图片 / 文字 / 链接至少一项；并各自限长 / 限张。返回 { ok, reason }。
export function validateCheckSubmission({ text, link, imageCount } = {}) {
  const t = (text == null ? "" : String(text)).trim();
  const l = (link == null ? "" : String(link)).trim();
  const n = imageCount || 0;
  if (!t && !l && !n) return { ok: false, reason: "图片、文字、链接至少填一项。" };
  if (t.length > 4000) return { ok: false, reason: "核查内容过长（上限 4000 字）。" };
  if (l.length > 1000) return { ok: false, reason: "链接过长。" };
  if (n > 9) return { ok: false, reason: "最多 9 张图片。" };
  return { ok: true, reason: "" };
}
