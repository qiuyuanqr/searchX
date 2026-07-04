// services/intake-worker/src/handler.test.js
import { test, expect } from "bun:test";
import { handleIntake } from "./handler.js";
import { mintInvite } from "./invite.js";

function fakeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    store: m,
    async get(k){ return m.has(k) ? m.get(k) : null; },
    async put(k, v, opts){ m.set(k, v); if (this._puts) this._puts.push({ k, v, opts }); },
    async delete(k){ m.delete(k); },
    async list({ prefix } = {}){ return { keys: [...m.keys()].filter((k)=>!prefix||k.startsWith(prefix)).map((name)=>({name})), list_complete: true, cursor: "" }; },
  };
}

const ENV = (kv) => ({
  ALLOWED_ORIGIN: "https://qiuyuanqr.github.io",
  GITHUB_TOKEN: "GT",
  GITHUB_OWNER: "qiuyuanqr",
  GITHUB_REPO: "searchX",
  AUTHOR_LOGIN: "qiuyuanqr",
  INTAKE_KV: kv,
});

// 假 fetch：GitHub 建 Issue
function routeFetch({ issue = { number: 7, html_url: "https://x/7" }, ok = true, status = 201 } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (String(url).includes("api.github.com")) return ok ? { ok: true, json: async () => issue } : { ok: false, status, text: async () => "boom" };
    return { ok: false, status: 404, text: async () => "nope" };
  };
  fn.calls = calls;
  return fn;
}

const post = (body) =>
  new Request("https://w.dev", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "5.5.5.5" },
    body: JSON.stringify(body),
  });

const NOW = new Date("2026-06-03T10:00:00Z");

// 预置一个授权 token → 邮箱
async function withToken(email = "alice@gmail.com", token = "TOK") {
  const kv = fakeKV();
  await mintInvite(kv, email, { gen: () => token });
  return kv;
}

test("OPTIONS 预检回 204 + CORS 头", async () => {
  const res = await handleIntake(new Request("https://w.dev", { method: "OPTIONS" }), ENV(fakeKV()));
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe("https://qiuyuanqr.github.io");
});

test("非 POST 回 405", async () => {
  const res = await handleIntake(new Request("https://w.dev", { method: "GET" }), ENV(fakeKV()));
  expect(res.status).toBe(405);
});

test("无 token → 403 unauthorized，不建 Issue", async () => {
  const fetchImpl = routeFetch();
  const res = await handleIntake(post({ title: "稳定币", focus: "机制" }), ENV(fakeKV()), { fetch: fetchImpl, now: NOW });
  expect(res.status).toBe(403);
  expect((await res.json()).error).toBe("unauthorized");
  expect(fetchImpl.calls.some((c) => String(c.url).includes("api.github.com"))).toBe(false);
});

test("未知 token → 403", async () => {
  const res = await handleIntake(post({ k: "GHOST", title: "稳定币" }), ENV(await withToken()), { fetch: routeFetch(), now: NOW });
  expect(res.status).toBe(403);
});

test("快乐路径：有效 token + 干净内容 → 建 approved Issue、存映射邮箱、回 ok+approved", async () => {
  const kv = await withToken();
  const env = ENV(kv);
  const fetchImpl = routeFetch();
  const res = await handleIntake(post({ k: "TOK", title: "稳定币清结算", focus: "机制", message: "" }), env, { fetch: fetchImpl, now: NOW });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, approved: true });
  const ghCall = fetchImpl.calls.find((c) => String(c.url).includes("api.github.com"));
  const body = JSON.parse(ghCall.opts.body);
  expect(body.labels).toEqual(["approved"]);
  // 邮箱以 sub:<number> 私有存 KV（真实邮箱来自 token 映射）
  expect(kv.store.get("sub:7")).toBe("alice@gmail.com");
  // 发给 GitHub 的正文不含原始邮箱、含打码
  expect(body.body).not.toContain("alice@gmail.com");
  expect(body.body).toContain("a***@gmail.com");
});

test("命中安全红旗 → 降级 pending（approved:false）", async () => {
  const kv = await withToken();
  const fetchImpl = routeFetch();
  const res = await handleIntake(post({ k: "TOK", title: "标的", focus: "```js\nalert(1)\n```" }), ENV(kv), { fetch: fetchImpl, now: NOW });
  expect(res.status).toBe(200);
  expect((await res.json()).approved).toBe(false);
  const body = JSON.parse(fetchImpl.calls.find((c) => String(c.url).includes("api.github.com")).opts.body);
  expect(body.labels).toEqual(["pending"]);
});

test("校验失败（缺题目）→ 400", async () => {
  const res = await handleIntake(post({ k: "TOK", title: "" }), ENV(await withToken()), { fetch: routeFetch(), now: NOW });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("invalid");
});

test("超每邮箱每日上限（默认 5）→ 429", async () => {
  const kv = await withToken();
  kv.store.set("rl:email:alice%40gmail.com:20260603", "5");
  const res = await handleIntake(post({ k: "TOK", title: "稳定币" }), ENV(kv), { fetch: routeFetch(), now: NOW });
  expect(res.status).toBe(429);
});

test("可配额度：MAX_PER_EMAIL_PER_DAY=2 时第 2 次即超限", async () => {
  const kv = await withToken();
  kv.store.set("rl:email:alice%40gmail.com:20260603", "2");
  const env = { ...ENV(kv), MAX_PER_EMAIL_PER_DAY: "2" };
  const res = await handleIntake(post({ k: "TOK", title: "稳定币" }), env, { fetch: routeFetch(), now: NOW });
  expect(res.status).toBe(429);
});

test("坏 JSON → 400 bad_json", async () => {
  const req = new Request("https://w.dev", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
  const res = await handleIntake(req, ENV(await withToken()), { fetch: routeFetch(), now: NOW });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("bad_json");
});

test("GitHub 建 Issue 失败 → 502，且不消耗额度", async () => {
  const kv = await withToken();
  const res = await handleIntake(post({ k: "TOK", title: "稳定币" }), ENV(kv), { fetch: routeFetch({ ok: false, status: 500 }), now: NOW });
  expect(res.status).toBe(502);
  expect([...kv.store.keys()].some((k) => k.startsWith("rl:"))).toBe(false);
});

test("快乐路径后才记一次额度（ip+email 各 +1）", async () => {
  const kv = await withToken();
  await handleIntake(post({ k: "TOK", title: "稳定币" }), ENV(kv), { fetch: routeFetch(), now: NOW });
  expect(kv.store.get("rl:ip:5.5.5.5:20260603")).toBe("1");
  expect(kv.store.get("rl:email:alice%40gmail.com:20260603")).toBe("1");
});

test("提交者邮箱写 KV 带 60 天过期", async () => {
  const kv = await withToken();
  kv._puts = [];
  await handleIntake(post({ k: "TOK", title: "稳定币" }), ENV(kv), { fetch: routeFetch(), now: NOW });
  const subPut = kv._puts.find((p) => p.k === "sub:7");
  expect(subPut).toBeTruthy();
  expect(subPut.opts?.expirationTtl).toBe(60 * 60 * 24 * 60);
});

test("Issue 建成后 commitRateLimit 抛错 → 仍回 ok:true+degraded，不误报 500（audit-2026-07-04 [26]）", async () => {
  const kv = await withToken();
  const originalPut = kv.put.bind(kv);
  kv.put = async (k, v, opts) => {
    if (String(k).startsWith("rl:")) throw new Error("kv put boom");
    return originalPut(k, v, opts);
  };
  const res = await handleIntake(post({ k: "TOK", title: "稳定币" }), ENV(kv), { fetch: routeFetch(), now: NOW });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, approved: true, degraded: true });
  // sub 映射仍写成功——两个 KV 写各自独立吞错，一个失败不该拖垮另一个
  expect(kv.store.get("sub:7")).toBe("alice@gmail.com");
});

test("Issue 建成后 sub:<number> KV 写失败 → 仍回 ok:true+degraded，不误报 500（audit-2026-07-04 [26]）", async () => {
  const kv = await withToken();
  const originalPut = kv.put.bind(kv);
  kv.put = async (k, v, opts) => {
    if (String(k).startsWith("sub:")) throw new Error("kv put boom");
    return originalPut(k, v, opts);
  };
  const res = await handleIntake(post({ k: "TOK", title: "稳定币" }), ENV(kv), { fetch: routeFetch(), now: NOW });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, approved: true, degraded: true });
  // 额度仍计成功
  expect(kv.store.get("rl:ip:5.5.5.5:20260603")).toBe("1");
});

test("下游抛错（fetch reject）→ 结构化 500 且带 CORS 头", async () => {
  const kv = await withToken();
  const fetchImpl = async () => { throw new Error("network down"); };
  const res = await handleIntake(post({ k: "TOK", title: "稳定币" }), ENV(kv), { fetch: fetchImpl, now: NOW });
  expect(res.status).toBe(500);
  expect((await res.json()).error).toBe("internal");
  expect(res.headers.get("access-control-allow-origin")).toBe("https://qiuyuanqr.github.io");
});
