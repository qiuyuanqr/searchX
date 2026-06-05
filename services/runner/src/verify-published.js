// services/runner/src/verify-published.js
// 部署探活：Step6 push 后 GitHub Actions 才 build+deploy（约 1–2 分钟），且 Pages 偶发 5xx 会打掉
// 部署 → 报告子页 404。轮询报告 URL 直到返回 200（新路径 200 即代表已上线）或超过总时限。
//
// 关键：每次 fetch 都带「单次硬超时」（AbortSignal.timeout）。否则某次连接被对端接受却迟迟不回包时，
// 这次 fetch 会无限等待 → 总时限永远到不了 → verifyPublished 永不返回 → 永久占着 runner 的全局单实例锁、
// 堵死整个队列。单次超时抛错会被下面的 catch 吞掉，再由总时限决定继续重试还是放弃。
//
// 依赖（fetch / 计时 / 睡眠）全部可注入，离线可测。
export async function pollUntilOk(url, {
  fetchImpl = fetch,
  deadlineMs = 8 * 60_000,   // 总时限：超过即放弃（返回 false）
  intervalMs = 15_000,       // 两次探测的间隔
  perTryMs = 10_000,         // 单次 fetch 的硬超时
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const deadline = now() + deadlineMs;
  for (let n = 1; ; n++) {
    try {
      const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(perTryMs) });
      if (res.ok) { log(`✓ 已确认上线（第 ${n} 次探测 200）`); return true; }
    } catch { /* 单次超时 / 网络错误 / 连接卡死：吞掉，由下面的总时限决定是否继续 */ }
    if (now() >= deadline) { log("✗ 超时未确认上线（疑似 Pages 部署故障）"); return false; }
    await sleep(intervalMs);
  }
}
