// services/intake-worker/src/ratelimit.test.js
import { test, expect } from "bun:test";
import { checkRateLimit, peekRateLimit, commitRateLimit, dayKey } from "./ratelimit.js";

// 假 KV：Map 实现 get/put
function fakeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    store: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
  };
}

test("dayKey 按北京时间输出 YYYYMMDD（UTC 20:00 起已是次日北京）", () => {
  expect(dayKey(new Date("2026-06-03T15:00:00Z"))).toBe("20260603"); // 北京 23:00，仍同日
  expect(dayKey(new Date("2026-06-03T20:00:00Z"))).toBe("20260604"); // 北京次日 04:00 —— 证明用北京时间
});

test("初次提交放行并把两个计数器置 1（键内 email 已编码）", async () => {
  const kv = fakeKV();
  const r = await checkRateLimit(kv, { ip: "1.1.1.1", email: "a@b.com", dayKeyStr: "20260603" });
  expect(r.allowed).toBe(true);
  expect(kv.store.get("rl:ip:1.1.1.1:20260603")).toBe("1");
  expect(kv.store.get("rl:email:a%40b.com:20260603")).toBe("1"); // @ 被 encodeURIComponent 编码
});

test("IP 达上限拒绝（reason=ip_rate_limited），不再自增", async () => {
  const kv = fakeKV({ "rl:ip:1.1.1.1:20260603": "8" });
  const r = await checkRateLimit(kv, {
    ip: "1.1.1.1", email: "a@b.com", dayKeyStr: "20260603", limits: { ip: 8, email: 4 },
  });
  expect(r.allowed).toBe(false);
  expect(r.reason).toBe("ip_rate_limited");
  expect(kv.store.get("rl:ip:1.1.1.1:20260603")).toBe("8");
});

test("邮箱达上限拒绝（reason=email_rate_limited）", async () => {
  const kv = fakeKV({ "rl:email:a%40b.com:20260603": "4" });
  const r = await checkRateLimit(kv, {
    ip: "9.9.9.9", email: "a@b.com", dayKeyStr: "20260603", limits: { ip: 8, email: 4 },
  });
  expect(r.allowed).toBe(false);
  expect(r.reason).toBe("email_rate_limited");
});

test("peekRateLimit 只读检查、不自增计数", async () => {
  const kv = fakeKV();
  const r = await peekRateLimit(kv, { ip: "1.1.1.1", email: "a@b.com", dayKeyStr: "20260603" });
  expect(r.allowed).toBe(true);
  expect(kv.store.size).toBe(0); // 没有任何写入
});

test("peekRateLimit 达上限拒绝、仍不自增", async () => {
  const kv = fakeKV({ "rl:email:a%40b.com:20260603": "4" });
  const r = await peekRateLimit(kv, { ip: "9.9.9.9", email: "a@b.com", dayKeyStr: "20260603" });
  expect(r.allowed).toBe(false);
  expect(r.reason).toBe("email_rate_limited");
  expect(kv.store.get("rl:email:a%40b.com:20260603")).toBe("4"); // 未变动
});

test("commitRateLimit 把两个计数器各 +1", async () => {
  const kv = fakeKV();
  await commitRateLimit(kv, { ip: "1.1.1.1", email: "a@b.com", dayKeyStr: "20260603" });
  expect(kv.store.get("rl:ip:1.1.1.1:20260603")).toBe("1");
  expect(kv.store.get("rl:email:a%40b.com:20260603")).toBe("1");
});
