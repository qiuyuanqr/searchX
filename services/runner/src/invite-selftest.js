// services/runner/src/invite-selftest.js
// 新专属链接自检的纯逻辑：找出新增授权 + 维护「已见」集合 + 拼通知邮件。
// 副作用（取列表 / 打 /verify / 发信 / 读写状态文件）在 invite-watch-cli.js。
// 流程：作者在 admin 页新增/换钥授权 → 下个 runner tick 发现新 token → 自动验证 →
// 邮件告诉作者「✅ 可发」或「❌ 先别发」。作者不用再人肉验链接。

// 纯函数：从当前授权列表里挑出「没见过的 token」（新增或换钥都会产生新 token）。
export function splitInvites(seenTokens, current) {
  const seen = new Set(seenTokens || []);
  return { fresh: (current || []).filter((p) => p.token && !seen.has(p.token)) };
}

// 纯函数：算下一份「已见」集合 = 当前列表中（之前已见 ∪ 本次已成功通知）的 token。
// 被撤销的授权自然掉出；通知失败的不进集合 → 下个 tick 自动重试。
export function nextSeenTokens(current, notifiedTokens, seenTokens) {
  const keep = new Set([...(seenTokens || []), ...(notifiedTokens || [])]);
  return (current || []).map((p) => p.token).filter((t) => keep.has(t));
}

// 纯函数：拼自检结果邮件。判定=主端点 verify 通过且站点首页可达（备用域只作参考——
// workers.dev 在墙内间歇被断是已知常态，不影响主链路）。只含打码邮箱与运维信息。
export function composeInviteReport({ person, link, primaryOk, fallbackOk, siteOk, authorEmail, fromEmail }) {
  const pass = !!(primaryOk && siteOk);
  const subject = pass
    ? `【searchX 链接自检 ✅】${person.email} 的专属链接可用`
    : `【searchX 链接自检 ❌】${person.email} 的专属链接未通过，先别发`;
  const lines = [
    `检测到新增/换钥授权：${person.email}，已自动验证：`,
    "",
    `· 主端点 /verify：${primaryOk ? "通过" : "未通过"}`,
    `· 站点首页：${siteOk ? "可达" : "不可达"}`,
    `· 备用端点（workers.dev，仅参考）：${fallbackOk ? "通过" : "未通过（墙内间歇阻断属常态）"}`,
    "",
    ...(pass
      ? ["链接可以发给朋友了，直接转发：", link]
      : ["请先排查（Worker 部署/KV/站点部署），修好后无需手动重试——通知失败的授权下个 tick 会自动复检重发。"]),
    "",
    "说明：自检证明服务端与链路（本机视角）正常，不能代表对方手机网络必然可达；",
    "前端已带 10 秒超时 + 备用域自动回退，对方打不开时页面会明确报错而非无限等待。",
    "",
    "—— searchX 自检",
  ];
  return { from: fromEmail, to: authorEmail, subject, text: lines.join("\n"), pass };
}
