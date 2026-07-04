// services/runner/src/net-retry.test.js
import { test, expect } from "bun:test";
import { withNetRetry } from "./net-retry.js";

const noSleep = async () => {};

test("首次成功：原样返回响应，只调一次", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, status: 200 }; };
  const f = withNetRetry(fetchImpl, { sleep: noSleep });
  const res = await f("https://api.github.com/x");
  expect(res.status).toBe(200);
  expect(calls).toBe(1);
});

test("瞬时抛错后恢复：重试成功，退避间隔线性递增", async () => {
  let calls = 0;
  const delays = [];
  const err = Object.assign(new Error("unknown certificate verification error"), {
    code: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
  });
  const fetchImpl = async () => {
    calls++;
    if (calls < 3) throw err;
    return { ok: true, status: 200 };
  };
  const f = withNetRetry(fetchImpl, { sleep: async (ms) => delays.push(ms) });
  const res = await f("https://api.github.com/x");
  expect(res.status).toBe(200);
  expect(calls).toBe(3);
  expect(delays).toEqual([2000, 4000]);
});

test("次数用尽仍失败：原样抛最后一个错误", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("boom"); };
  const f = withNetRetry(fetchImpl, { attempts: 3, sleep: noSleep });
  await expect(f("https://api.github.com/x")).rejects.toThrow("boom");
  expect(calls).toBe(3);
});

test("HTTP 非 2xx 不重试：原样返回，由调用方判定（避免盲目重放写操作）", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: false, status: 502 }; };
  const f = withNetRetry(fetchImpl, { sleep: noSleep });
  const res = await f("https://api.github.com/x");
  expect(res.status).toBe(502);
  expect(calls).toBe(1);
});

test("url 与 init 原样透传，并补单次硬超时 signal", async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true }; };
  const f = withNetRetry(fetchImpl, { sleep: noSleep });
  await f("https://w.dev/sub/7", { method: "POST", headers: { "x-sub-secret": "S" } });
  expect(seen.url).toBe("https://w.dev/sub/7");
  expect(seen.init.method).toBe("POST");
  expect(seen.init.headers["x-sub-secret"]).toBe("S");
  expect(seen.init.signal).toBeInstanceOf(AbortSignal);
});

test("调用方自带 signal 时尊重之，不覆盖", async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = init; return { ok: true }; };
  const f = withNetRetry(fetchImpl, { sleep: noSleep });
  const ctrl = new AbortController();
  await f("https://w.dev/x", { signal: ctrl.signal });
  expect(seen.signal).toBe(ctrl.signal);
});

test("重试时输出日志（含次数与原因）", async () => {
  const logs = [];
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("x"), { code: "ECONNRESET" });
    return { ok: true };
  };
  const f = withNetRetry(fetchImpl, { sleep: noSleep, log: (m) => logs.push(m) });
  await f("https://api.github.com/x");
  expect(logs.length).toBe(1);
  expect(logs[0]).toContain("1/3");
  expect(logs[0]).toContain("ECONNRESET");
});
