// services/intake-worker/src/ratelimit.js
// 每 IP / 每邮箱 每日提交上限。KV 最终一致 → 近似限频即可
// （真正的闸是作者人工审批；这里只挡批量灌水）。

export function dayKey(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

export async function checkRateLimit(
  kv,
  { ip, email, dayKey, limits = { ip: 8, email: 4 }, ttl = 172800 }
) {
  const checks = [
    { key: `rl:ip:${ip}:${dayKey}`, max: limits.ip, reason: "ip_rate_limited" },
    { key: `rl:email:${email}:${dayKey}`, max: limits.email, reason: "email_rate_limited" },
  ];
  for (const c of checks) {
    const cur = parseInt((await kv.get(c.key)) || "0", 10);
    if (cur >= c.max) return { allowed: false, reason: c.reason };
  }
  for (const c of checks) {
    const cur = parseInt((await kv.get(c.key)) || "0", 10);
    await kv.put(c.key, String(cur + 1), { expirationTtl: ttl });
  }
  return { allowed: true, reason: null };
}
