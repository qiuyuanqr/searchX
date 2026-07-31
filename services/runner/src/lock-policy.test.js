// services/runner/src/lock-policy.test.js
// 把单实例锁的判定钉死。两轮审查里这段逻辑各出过一次问题，而它此前零测试：
//   第一轮：超龄上限按「单次任务」估，合法多任务长批次必然被判超龄、锁被抢走 → 两个 claude 并发
//   第二轮：加了「运行期间定期更新锁时间戳」之后，「进程活着但卡死」永远不超龄 → 锁永久占死、每 tick 静默跳过
import { test, expect } from "bun:test";
import { evaluateLock, formatLockFile, parseLockFile, STALE_MS, DEAD_PID_GRACE_MS } from "./lock-policy.js";

const NOW = 1_800_000_000_000;
const LIMITS = { maxAliveAgeMs: 210 * 60_000, hardCapMs: 8 * 3600_000 }; // research runner 的实际取值

const at = (o) => evaluateLock({ now: NOW, ...o }, LIMITS);

test("持有者活着、锁龄没到上限 → 让路（正常情况）", () => {
  const r = at({ pid: 111, startedAt: NOW - 30 * 60_000, mtimeMs: NOW - 1000, alive: true });
  expect(r.takeover).toBe(false);
  expect(r.reason).toBe("alive");
});

test("锁的时间戳在被定期更新，但持有已超硬上限 → 强制接管（唯一能兜住「活着但卡死」的一条）", () => {
  // 锁的时间戳每 60 秒被更新一次，所以 ageMs 永远很小；只有 startedAt 能表达真实持有时长
  const r = at({ pid: 111, startedAt: NOW - 9 * 3600_000, mtimeMs: NOW - 5_000, alive: true });
  expect(r.takeover).toBe(true);
  expect(r.reason).toBe("hard-cap");
});

test("合法长批次（3.5 小时、时间戳更新正常）不被误杀 —— 第一轮的回归", () => {
  const r = at({ pid: 111, startedAt: NOW - 3.5 * 3600_000, mtimeMs: NOW - 10_000, alive: true });
  expect(r.takeover).toBe(false);
});

test("老格式锁（没有 startedAt 那一行）：退回只按锁龄判，不误伤", () => {
  const fresh = at({ pid: 111, startedAt: NaN, mtimeMs: NOW - 60_000, alive: true });
  expect(fresh.takeover).toBe(false);
  const stale = at({ pid: 111, startedAt: NaN, mtimeMs: NOW - 4 * 3600_000, alive: true });
  expect(stale.takeover).toBe(true);
  expect(stale.reason).toBe("alive-but-stale");
});

test("pid 确证已死且过了短窗口 → 立刻接管（不必等满一小时，否则管线白停一小时）", () => {
  const r = at({ pid: 222, startedAt: NOW - 10 * 60_000, mtimeMs: NOW - 5 * 60_000, alive: false });
  expect(r.takeover).toBe(true);
  expect(r.reason).toBe("dead");
});

test("pid 已死但锁刚建出来 → 先让路（防和「另一进程刚建锁、pid 还没落盘」撞车）", () => {
  const r = at({ pid: 222, startedAt: NOW - 1000, mtimeMs: NOW - 1000, alive: false });
  expect(r.takeover).toBe(false);
  expect(r.reason).toBe("dead-but-fresh");
  // 边界：恰好到宽限窗口即可接管
  expect(at({ pid: 222, mtimeMs: NOW - DEAD_PID_GRACE_MS, startedAt: NaN, alive: false }).takeover).toBe(true);
});

test("pid 读不出来（写坏/半写）：锁新时保守让路，超 STALE_MS 才回收", () => {
  expect(at({ pid: NaN, startedAt: NaN, mtimeMs: NOW - 10 * 60_000, alive: false }).takeover).toBe(false);
  expect(at({ pid: NaN, startedAt: NaN, mtimeMs: NOW - STALE_MS, alive: false }).takeover).toBe(true);
});

test("锁文件格式：写出去能原样读回来；坏内容降级成 NaN 而不是抛", () => {
  expect(parseLockFile(formatLockFile(4242, NOW))).toEqual({ pid: 4242, startedAt: NOW });
  expect(parseLockFile("4242")).toEqual({ pid: 4242, startedAt: NaN });     // 老格式
  expect(parseLockFile("")).toEqual({ pid: NaN, startedAt: NaN });
  expect(parseLockFile(null)).toEqual({ pid: NaN, startedAt: NaN });
  expect(parseLockFile("垃圾\n数据")).toEqual({ pid: NaN, startedAt: NaN });
});

test("check-runner 的取值（更短的上限）同样成立", () => {
  const limits = { maxAliveAgeMs: 60 * 60_000, hardCapMs: 4 * 3600_000 };
  // 一批 3 条各 25 分钟的合法任务：锁的时间戳一直在更新，不该被抢
  expect(evaluateLock({ pid: 1, startedAt: NOW - 75 * 60_000, mtimeMs: NOW - 5_000, alive: true, now: NOW }, limits).takeover).toBe(false);
  // 卡死 5 小时：硬上限接管
  expect(evaluateLock({ pid: 1, startedAt: NOW - 5 * 3600_000, mtimeMs: NOW - 5_000, alive: true, now: NOW }, limits).reason).toBe("hard-cap");
});
