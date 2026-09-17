// services/check-runner/src/bark.js
// Bark（iOS 推送 App）通知：核查完成 / 失败时给手机推一条。纯函数拼请求，发送经注入 fetch，离线可测。
//
// 隐私取舍：推送内容会经 Bark 服务器与苹果 APNs 中转，不在作者自己的私密通道里。所以默认正文只说
// 「有一条核查完成」；`CHECK_RUNNER_BARK_DETAIL=1` 才把内容标题与一行结论带进推送（作者自己的
// 设备、自己的选择）。用户提交的原文（text / link）任何模式下都不进推送。
//
// Bark 服务端接口：POST <barkUrl> JSON { title, body, url?, group?, level? }（barkUrl 形如
// https://api.day.app/<device_key>，或自建 https://bark.example.com/<device_key>）。

export const BARK_TIMEOUT_MS = 15_000;

function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

const clip = (s, n) => { const t = String(s == null ? "" : s).trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

// 纯函数：拼一条推送。outcome: "done" | "failed"；detail=true 才带 title / summary。
// 返回 { url, init }（可直接喂 fetch），barkUrl 为空返回 null（未配置即不发）。
export function buildBarkRequest({ barkUrl, outcome, title = "", summary = "", detail = false, checkPageUrl = "" }) {
  const base = String(barkUrl || "").trim().replace(/\/+$/, "");
  if (!base) return null;
  const failed = outcome === "failed";
  const payload = {
    title: failed ? "searchX 核查失败" : "searchX 核查完成",
    body: failed
      ? (detail && title ? `「${clip(title, 40)}」连续失败，已停止重试，可在核查页一键重试` : "有一条核查连续失败，已停止重试，可在核查页一键重试")
      : (detail && (title || summary) ? [clip(title, 40), clip(summary, 120)].filter(Boolean).join("\n") : "有一条核查已完成，打开核查页查看结论"),
    group: "searchx-check",
  };
  if (checkPageUrl) payload.url = String(checkPageUrl).trim();   // 点推送直达核查页
  return {
    url: base,
    init: {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    },
  };
}

// 发送：非 2xx 抛错（调用方按 best-effort 记日志，绝不影响核查主流程）。
export async function sendBark(req, fetchImpl = fetch) {
  if (!req) return;
  const r = await fetchImpl(req.url, { ...req.init, signal: timeoutSignal(BARK_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`bark ${r.status}`);
}
