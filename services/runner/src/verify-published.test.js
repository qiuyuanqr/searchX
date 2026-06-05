// services/runner/src/verify-published.test.js
import { test, expect } from "bun:test";
import { pollUntilOk } from "./verify-published.js";

test("首次探测即 200 → 立刻返回 true", async () => {
  let calls = 0;
  const ok = await pollUntilOk("http://x", {
    fetchImpl: async () => { calls++; return { ok: true }; },
    sleep: async () => {},
  });
  expect(ok).toBe(true);
  expect(calls).toBe(1);
});

test("一直非 200：到总时限返回 false，不会无限循环", async () => {
  let calls = 0;
  let t = 0;
  const ok = await pollUntilOk("http://x", {
    fetchImpl: async () => { calls++; return { ok: false, status: 404 }; },
    sleep: async () => {},
    intervalMs: 1,
    deadlineMs: 8 * 60_000,
    now: () => { t += 60_000; return t; }, // 每次调用推进 1 分钟 → 约 8 次后越过总时限
  });
  expect(ok).toBe(false);
  expect(calls).toBeGreaterThan(0);
  expect(calls).toBeLessThan(20); // 确实终止了（不是死循环）
});

test("单次 fetch 卡死（抛错/超时）被吞掉，后续探测成功仍返回 true", async () => {
  let calls = 0;
  const ok = await pollUntilOk("http://x", {
    fetchImpl: async () => { calls++; if (calls === 1) throw new Error("simulated timeout"); return { ok: true }; },
    sleep: async () => {},
  });
  expect(ok).toBe(true);
  expect(calls).toBe(2); // 第一次超时被吞，第二次成功
});

test("每次 fetch 都带单次超时信号（AbortSignal）", async () => {
  let sawSignal = false;
  await pollUntilOk("http://x", {
    fetchImpl: async (_url, opts) => { sawSignal = !!(opts && opts.signal); return { ok: true }; },
    sleep: async () => {},
  });
  expect(sawSignal).toBe(true);
});
