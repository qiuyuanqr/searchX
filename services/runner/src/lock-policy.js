// services/runner/src/lock-policy.js
// 单实例锁的**判定逻辑**（纯函数，两个 runner 共用）。
//
// 为什么抽出来：这段判定是整条流水线的地基——判错一次的后果要么是「两个 claude 并发写同一
// 工作树」，要么是「锁永久占死、每 tick 静默跳过、管线停摆且零报警」。2026-07-31 两轮审查
// 里它出过两次问题（第一轮误杀合法长批次、第二轮心跳把死锁兜底拆了），而它当时零测试、
// 连覆盖率分母都不进。副作用（建锁/删锁/读 mtime）留在 index.js，判定搬到这里以便钉死。
//
// 四种回收情形，对应四条真实故障：
//   ①持有者活着且没超龄        → 让路（正常情况）
//   ②持有者活着但持有超硬上限  → 强制回收（进程卡死时心跳会一直刷新 mtime，只有这条兜得住）
//   ③pid 读得出来且确证已死    → 短窗口后回收（崩溃/断电残锁，没理由等满一小时）
//   ④pid 读不出来/损坏         → 等够 STALE_MS 才敢回收（拿不准，保守）

export const STALE_MS = 3600_000; // 1h：pid 损坏/没写好的锁，超此年龄才敢回收
export const DEAD_PID_GRACE_MS = 60_000; // 确证已死的 pid，留 1 分钟防和「刚建锁、pid 还没落盘」撞车

/**
 * 判断一把已存在的锁能不能被接管。
 * @param {object} state
 *  - pid       锁文件第一行解析出的 pid（NaN = 读不出来/损坏）
 *  - startedAt 锁文件第二行的建锁时刻毫秒（NaN = 老格式锁，没有这一行）
 *  - mtimeMs   锁文件当前 mtime（心跳会刷新它）
 *  - alive     该 pid 是否还活着
 *  - now       当前时刻毫秒
 * @param {object} limits
 *  - maxAliveAgeMs 持有者活着时允许的最大「锁龄」（＝单次任务超时 + 余量）
 *  - hardCapMs     绝对持有上限，与心跳无关，按 startedAt 算
 * @returns {{ takeover: boolean, reason: string }}
 */
export function evaluateLock({ pid, startedAt, mtimeMs, alive, now }, { maxAliveAgeMs, hardCapMs }) {
  const ageMs = Number.isFinite(mtimeMs) ? now - mtimeMs : 0;
  const hasStart = Number.isInteger(startedAt);
  const heldMs = hasStart ? now - startedAt : 0;
  const overHardCap = hasStart && heldMs >= hardCapMs;

  if (Number.isInteger(pid) && alive) {
    if (overHardCap) return { takeover: true, reason: "hard-cap" };      // ②
    if (ageMs < maxAliveAgeMs) return { takeover: false, reason: "alive" }; // ①
    return { takeover: true, reason: "alive-but-stale" };
  }
  if (Number.isInteger(pid)) {
    // ③ 确证已死
    return ageMs < DEAD_PID_GRACE_MS
      ? { takeover: false, reason: "dead-but-fresh" }
      : { takeover: true, reason: "dead" };
  }
  // ④ pid 读不出来
  return ageMs < STALE_MS
    ? { takeover: false, reason: "unreadable-pid-fresh" }
    : { takeover: true, reason: "unreadable-pid-stale" };
}

/** 锁文件内容：第一行 pid，第二行建锁时刻。 */
export function formatLockFile(pid, now) {
  return `${pid}\n${now}`;
}

/** 解析锁文件内容，坏数据一律降级成 NaN，绝不抛。 */
export function parseLockFile(text) {
  const [a, b] = String(text ?? "").split("\n");
  return {
    pid: parseInt(String(a ?? "").trim(), 10),
    startedAt: parseInt(String(b ?? "").trim(), 10),
  };
}
