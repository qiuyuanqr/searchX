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

// 纯函数：把服务端状态码映射成给用户看的中文。
// 注：401（密钥失效）在 check-page.js 提前专门处理（清密钥、退回密钥闸），不会走到这里。
export function describeCheckResult(ok) {
  if (ok) return { kind: "success", text: "已提交，稍后在 Obsidian 查看核查结果。" };
  return { kind: "error", text: "提交失败，请稍后重试。" };
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
