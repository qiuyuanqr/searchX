// web/src/assets/check.js — 事实核查提交页的纯逻辑（构造载荷 / 密钥读写 / 状态文案）。
// DOM 引导在 check-page.js；本文件只导出纯函数，可直接单测，不依赖 DOM / 全局。

// 纯函数：构造 POST /check 的请求体。
// text 必填（核查内容）；link 可选（留空则不传）。
export function buildCheckPayload(text, link) {
  const t = (text == null ? "" : String(text)).trim();
  const l = (link == null ? "" : String(link)).trim();
  const payload = { text: t };
  if (l) payload.link = l;
  return payload;
}

// 纯函数：校验载荷是否可提交（text 必填）。返回 { ok, reason }。
export function validateCheckPayload(payload) {
  if (!payload || !payload.text) {
    return { ok: false, reason: "核查内容不能为空。" };
  }
  return { ok: true, reason: "" };
}

// 纯函数：从 sessionStorage 读密钥（key 名固定）。
// 传入 storage 对象方便单测注入 fake。
export function readKey(storage) {
  try { return storage.getItem("searchx_check_key") || ""; } catch { return ""; }
}

// 纯函数：把密钥写入 sessionStorage。
export function saveKey(storage, key) {
  try { storage.setItem("searchx_check_key", key); } catch {}
}

// 纯函数：清除密钥。
export function clearKey(storage) {
  try { storage.removeItem("searchx_check_key"); } catch {}
}

// 纯函数：把服务端状态码映射成给用户看的中文。
// 注：401（密钥失效）在 check-page.js 提前专门处理（清密钥、退回密钥闸），不会走到这里。
export function describeCheckResult(status, ok) {
  if (ok) return { kind: "success", text: "已提交，稍后在 Obsidian 查看核查结果。" };
  return { kind: "error", text: "提交失败，请稍后重试。" };
}
