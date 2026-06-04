// services/intake-worker/src/ratelimit.js
// 每 IP / 每邮箱 每日提交上限。KV 最终一致 → 近似限频即可
// （真正的闸是作者人工审批；这里只挡批量灌水）。

export function dayKey(date) {
  // 北京时间分日（CLAUDE.md：所有时点用北京时间），与 runner 的当日计数口径一致。
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(date).replace(/-/g, "");
}

export async function checkRateLimit(
  kv,
  { ip, email, dayKeyStr, limits = { ip: 8, email: 4 }, ttl = 172800 }
) {
  // 对 ip/email 做编码再入键：邮箱可含 `:`、IPv6 地址本身就含 `:`，不编码会污染以 `:` 分隔的
  // KV 键、造成不同主体计数碰撞或被构造绕过限频。
  const checks = [
    { key: `rl:ip:${encodeURIComponent(ip)}:${dayKeyStr}`, max: limits.ip, reason: "ip_rate_limited" },
    { key: `rl:email:${encodeURIComponent(email)}:${dayKeyStr}`, max: limits.email, reason: "email_rate_limited" },
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
