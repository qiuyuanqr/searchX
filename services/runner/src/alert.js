// services/runner/src/alert.js
// 报警的纯逻辑：限频判定 + 邮件拼装 + 探活结果归纳。发送与文件读写在 alert-cli.js / probe-cli.js。
// 原则：流水线的失败必须到达作者邮箱（否则就是又一处「坏了不吭声」），
// 但 runner 每 5 分钟一个 tick，同一故障不能每 tick 轰一封——同 key 两封之间至少隔 MIN_INTERVAL_MS。

export const MIN_INTERVAL_MS = 6 * 3600_000; // 同类报警最短间隔：6 小时

// 纯函数：这次要不要发？prevMs = 上次发出的时间戳；无记录（NaN/undefined）→ 发。
export function shouldAlert(prevMs, nowMs, minIntervalMs = MIN_INTERVAL_MS) {
  if (!Number.isFinite(prevMs)) return true;
  return nowMs - prevMs >= minIntervalMs;
}

// 纯函数：拼报警邮件。只含运维信息（哪坏了、何时、去哪看日志），绝不含用户私人信息。
export function composeAlert({ key, detail, authorEmail, fromEmail, when }) {
  const subject = `【searchX 报警·${key}】流水线出问题了`;
  const lines = [
    `searchX 半自动流水线自检发现故障（${when} 北京时间）：`,
    "",
    detail,
    "",
    "同类报警至少间隔 6 小时才会再发一封；未收到「恢复」不代表已恢复，请以排查结果为准。",
    "",
    "—— searchX 自检",
  ];
  return { from: fromEmail, to: authorEmail, subject, text: lines.join("\n") };
}

// 探活报警的连续失败确认阈值：同一目标连续断满这么多个 tick（每 tick 5 分钟，约 20 分钟）
// 才算真故障。为什么不单次即报：墙内到 Cloudflare / GitHub 的链路存在分钟级瞬时抖动
// （2026-07-06~09 实测：一周十余次「断 1~3 个 tick 即自愈」，每次都发了邮件但无一可行动）；
// 真故障（如 2026-07-03 workers.dev 全天 SNI 阻断）远超此阈值，20 分钟报警延迟无实际损失。
export const PROBE_CONFIRM_TICKS = 4;

// 纯函数：推进「连续失败 tick 数」。通 → 清零；断 → +1。历史缺失/损坏一律从零起算。
// 跨 tick 的落盘读写由 probe-cli.js 负责（每个 tick 是独立进程，状态必须落盘才能延续）。
export function nextStreaks(prev, { siteOk, primaryOk }) {
  const base = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
  const p = prev && typeof prev === "object" ? prev : {};
  return {
    site: siteOk ? 0 : base(p.site) + 1,
    primary: primaryOk ? 0 : base(p.primary) + 1,
  };
}

// —— runner 主体「拉 approved 队列」的网络防抖 ——
// 与探活同理：Mac mini（墙内）到 api.github.com 的链路存在分钟级瞬时抖动（2026-07-15、07-17
// 实测：断几分钟即自愈）。拉队列失败若每 tick 都 exit 1 报警就是又一轮误报轰炸——连续断满
// QUEUE_FETCH_CONFIRM_TICKS 个 tick 才判真故障报警，与 PROBE_CONFIRM_TICKS 同量级（约 20 分钟）。
export const QUEUE_FETCH_CONFIRM_TICKS = 4;

// 纯函数：拉队列的错误是否属「外部瞬时故障」（该防抖，而非立即报警）。
// - fetch 自身抛错（连接/TLS/超时）：无 HTTP 响应、无 status → 瞬时（如 07-15 的 TimeoutError）。
// - 拿到响应但 5xx（GitHub 服务端错，如 07-17 返回的错误页 HTML）→ 瞬时。
// - 4xx（401 PAT 失效 / 403 限流 / 404 仓库错配）：配置问题，防抖会掩盖 6 小时 → 立即报警。
export function isTransientQueueError(err) {
  const status = err?.status;
  if (!Number.isFinite(status)) return true;
  return status >= 500;
}

// 纯函数：推进拉队列的「连续失败 tick 数」。失败 +1、成功清零；历史缺失/损坏一律从零起算。
// 跨 tick 的落盘读写由 index.js 负责（每个 tick 是独立进程，状态必须落盘才能延续）。
export function nextQueueStreak(prev, failed) {
  const base = Number.isInteger(prev) && prev > 0 ? prev : 0;
  return failed ? base + 1 : 0;
}

// 纯函数：把一轮墙内探活结果归纳成「要不要报警 + 文案」。
// 规则：站点 / Worker 主端点连续断满 PROBE_CONFIRM_TICKS 个 tick → 报警（主备全挂时额外
// 注明链路已完全断）；未达阈值 → 不报警只留痕（瞬时抖动，见上）。
// 仅备用端点（workers.dev）挂 → 不报警：主链路仍通，且 workers.dev 在墙内间歇被 SNI 阻断
// 是已知常态（2026-07-03 实测），报了也不可行动，只在日志留痕。
// streaks 缺失（旧调用方 / 状态文件读失败）→ 视为已达阈值：报警路径宁多报不静默。
export function evaluateProbe(
  { siteOk, primaryOk, fallbackOk, site, primary, fallback, streaks },
  confirmTicks = PROBE_CONFIRM_TICKS
) {
  const siteStreak = streaks?.site ?? confirmTicks;
  const primaryStreak = streaks?.primary ?? confirmTicks;
  const broken = [];   // 达连续阈值，要报警
  const watching = []; // 断了但未达阈值，只留痕
  if (!siteOk) {
    (siteStreak >= confirmTicks ? broken : watching).push(
      siteStreak >= confirmTicks
        ? `站点首页不可达：${site}（已连续 ${siteStreak} 次探活失败）`
        : `站点首页不可达（连续第 ${siteStreak} 次，连续 ${confirmTicks} 次才报警）：${site}`
    );
  }
  if (!primaryOk) {
    const fullBreak = !fallbackOk ? `；备用端点也不可达：${fallback}（提交链路已完全断）` : "";
    (primaryStreak >= confirmTicks ? broken : watching).push(
      primaryStreak >= confirmTicks
        ? `Worker 主端点不可达：${primary}（已连续 ${primaryStreak} 次探活失败）${fullBreak}`
        : `Worker 主端点不可达（连续第 ${primaryStreak} 次，连续 ${confirmTicks} 次才报警）：${primary}${fullBreak}`
    );
  }
  if (broken.length) return { alert: true, detail: broken.concat(watching).join("\n") };
  if (watching.length) return { alert: false, detail: watching.join("\n") };
  if (!fallbackOk) return { alert: false, detail: `仅备用端点不可达（主链路正常，不报警只留痕）：${fallback}` };
  return { alert: false, detail: "全部可达" };
}
