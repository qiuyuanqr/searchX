// 探活的失败分类与历史统计。
// 为什么要分类而不是只记「断」：2026-08-31 排查「站点时快时慢」时发现，墙内对
// qiuyuanqr.github.io 的干扰有两种完全不同的表现——TCP 连不上（等满 10s 超时）与
// TLS 握手被重置（几秒即断，SNI 阻断的典型特征）。只记布尔值，这两者和「真的挂了」
// 长得一模一样，攒再多天数据也判断不了要不要迁站。
//
// 这一层只做记录，**不参与报警判定**——报警仍走 alert.js 的连续失败计数。
// 监测不能改变现有报警行为，否则就成了「加一层保护顺手拆掉另一层」（CLAUDE.md）。

// 保留上限：runner 每 5 分钟一 tick，一天约 288 行，5000 行 ≈ 17 天。
// 攒够判断迁站所需的样本即可，不做无限增长的日志。
export const PROBE_LOG_MAX_LINES = 5000;

// 把 fetch 抛出的异常归成稳定的短标签。
//
// ⚠️ 标签必须按**运行时真实抛出的形态**定，不能照 Node 的错误码想当然
// （2026-08-31 第一版就是这么错的：夹具里构造 `code: "ECONNREFUSED"` 全绿，
// 真跑一次却记成了 other——Bun 用的是自己的一套 code 名）。下面这些是实测值：
//   拒绝连接 / DNS 不存在 → code "ConnectionRefused"（**Bun 把两者合并了**）
//   自签证书 → "DEPTH_ZERO_SELF_SIGNED_CERT"；过期证书 → "CERT_HAS_EXPIRED"
//   超时（AbortSignal.timeout）→ name "TimeoutError"
//
// **已知的弱点**：因为上面那条合并，`refused` 实际含义是「连不上（含 DNS 解析失败）」，
// 分不出是域名没解析出来还是端口拒绝。判读迁站时这不影响结论（两者都不是链路干扰），
// 但真要查 DNS 污染，得另外拿 dig 单独验，别指望这个标签。
//
// 认不出来的**兜底保留原始 code**而不是笼统记 other——运行时升级会带来新形态，
// 记成 other 等于把新信息扔掉，而这份历史的全部用途就是事后判读。
export function classifyFetchError(e) {
  if (!e) return "unknown";
  const name = e.name || "";
  const code = e.code || e.cause?.code || "";
  const msg = `${e.message || ""} ${e.cause?.message || ""}`;

  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  if (code === "ETIMEDOUT" || /timed out/i.test(msg)) return "timeout";
  // 证书类：code 形如 CERT_HAS_EXPIRED / DEPTH_ZERO_SELF_SIGNED_CERT / UNABLE_TO_VERIFY_*
  if (/CERT|SSL|TLS/i.test(code) || /SSL|TLS|certificate|handshake/i.test(msg)) return "tls";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (code === "ConnectionRefused" || code === "ECONNREFUSED") return "refused";
  // 连接建立后被对端断开——墙内 SNI 阻断打断 TLS 握手就是这个形态（curl 侧报 SSL_ERROR_SYSCALL）。
  if (code === "ConnectionClosed" || code === "ECONNRESET" || /reset by peer/i.test(msg)) return "reset";
  return code || "other";
}

// 一行历史记录。ok 用 "ok" 而不是 true——落盘后人眼直接可读，且与失败标签同一个值域。
export function probeLogLine({ at, results }) {
  return JSON.stringify({ t: at, ...results });
}

// 滚动截断：只保留最近 max 行。**先截断再返回**，让调用方一次性覆盖写，
// 避免「追加 + 定期清理」两条路径各自出错（清理漏跑就无限长，清理错跑就丢历史）。
export function rollLines(existing, line, max = PROBE_LOG_MAX_LINES) {
  const lines = existing.split("\n").filter(Boolean);
  lines.push(line);
  return lines.slice(-max).join("\n") + "\n";
}

// 聚合统计：每个目标的成功率与失败类型分布。
// 只认能解析的行——历史文件可能被人手改过或写盘中途断电截断，坏行直接跳过，
// 不能让一行坏数据把整份统计变成异常退出。
export function summarizeProbeLog(text, { since = null } = {}) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (!r || typeof r.t !== "string") continue;
      if (since && r.t < since) continue;
      rows.push(r);
    } catch { /* 坏行跳过 */ }
  }
  const targets = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (k === "t" || typeof v !== "string") continue;
      const t = (targets[k] ||= { total: 0, ok: 0, reasons: {} });
      t.total++;
      if (v === "ok") t.ok++;
      else t.reasons[v] = (t.reasons[v] || 0) + 1;
    }
  }
  for (const t of Object.values(targets)) {
    t.failRate = t.total ? (t.total - t.ok) / t.total : 0;
  }
  return { rows: rows.length, from: rows[0]?.t || null, to: rows.at(-1)?.t || null, targets };
}
