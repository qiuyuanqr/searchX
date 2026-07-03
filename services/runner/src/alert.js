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

// 纯函数：把一轮墙内探活结果归纳成「要不要报警 + 文案」。
// 规则：站点挂 / Worker 主端点挂 → 报警（主备全挂时额外注明链路已完全断）；
// 仅备用端点（workers.dev）挂 → 不报警：主链路仍通，且 workers.dev 在墙内间歇被 SNI 阻断
// 是已知常态（2026-07-03 实测），报了也不可行动，只在日志留痕。
export function evaluateProbe({ siteOk, primaryOk, fallbackOk, site, primary, fallback }) {
  const broken = [];
  if (!siteOk) broken.push(`站点首页不可达：${site}`);
  if (!primaryOk) broken.push(`Worker 主端点不可达：${primary}`);
  if (!primaryOk && !fallbackOk) broken.push(`Worker 备用端点也不可达：${fallback}（提交链路已完全断）`);
  if (broken.length) return { alert: true, detail: broken.join("\n") };
  if (!fallbackOk) return { alert: false, detail: `仅备用端点不可达（主链路正常，不报警只留痕）：${fallback}` };
  return { alert: false, detail: "全部可达" };
}
