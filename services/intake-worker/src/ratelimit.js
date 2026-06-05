// services/intake-worker/src/ratelimit.js
// 每 IP / 每邮箱 每日提交上限。KV 最终一致 → 近似限频即可
// （真正的闸是作者人工审批；这里只挡批量灌水）。

export function dayKey(date) {
  // 北京时间分日（CLAUDE.md：所有时点用北京时间），与 runner 的当日计数口径一致。
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(date).replace(/-/g, "");
}

// 对 ip/email 做编码再入键：邮箱可含 `:`、IPv6 地址本身就含 `:`，不编码会污染以 `:` 分隔的
// KV 键、造成不同主体计数碰撞或被构造绕过限频。
function counterKeys(ip, email, dayKeyStr, limits) {
  return [
    { key: `rl:ip:${encodeURIComponent(ip)}:${dayKeyStr}`, max: limits.ip, reason: "ip_rate_limited" },
    { key: `rl:email:${encodeURIComponent(email)}:${dayKeyStr}`, max: limits.email, reason: "email_rate_limited" },
  ];
}

// 只读检查是否已超限，不改计数。handler 在建 Issue 之前调它——这样失败的请求（建 Issue 报错等）
// 不会白白扣掉提交者的当日额度。
export async function peekRateLimit(kv, { ip, email, dayKeyStr, limits = { ip: 8, email: 4 } }) {
  for (const c of counterKeys(ip, email, dayKeyStr, limits)) {
    const cur = parseInt((await kv.get(c.key)) || "0", 10);
    if (cur >= c.max) return { allowed: false, reason: c.reason };
  }
  return { allowed: true, reason: null };
}

// 把两个计数器各 +1。handler 在 Issue 建成功之后才调它，确保只有真正入队的请求才计入额度。
export async function commitRateLimit(
  kv,
  { ip, email, dayKeyStr, limits = { ip: 8, email: 4 }, ttl = 172800 }
) {
  for (const c of counterKeys(ip, email, dayKeyStr, limits)) {
    const cur = parseInt((await kv.get(c.key)) || "0", 10);
    await kv.put(c.key, String(cur + 1), { expirationTtl: ttl });
  }
}

// 兼容旧接口：检查 + 计数一步完成。handler 已改用 peek/commit 两段式（失败请求不计额度）；
// 此函数保留给可能的其它调用方。
export async function checkRateLimit(kv, opts) {
  const rl = await peekRateLimit(kv, opts);
  if (!rl.allowed) return rl;
  await commitRateLimit(kv, opts);
  return { allowed: true, reason: null };
}
