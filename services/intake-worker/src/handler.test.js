// services/intake-worker/src/handler.test.js
import { test, expect } from "bun:test";
import { handleIntake } from "./handler.js";

function fakeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { store: m, async get(k){return m.has(k)?m.get(k):null;}, async put(k,v){m.set(k,v);} };
}

const ENV = () => ({
  ALLOWED_ORIGIN: "https://qiuyuanqr.github.io",
  TURNSTILE_SECRET: "TS",
  GITHUB_TOKEN: "GT",
  GITHUB_OWNER: "qiuyuanqr",
  GITHUB_REPO: "searchX",
  AUTHOR_LOGIN: "qiuyuanqr",
  INTAKE_KV: fakeKV(),
});

// 假 fetch：按 URL 分流 turnstile / github
function routeFetch({ turnstile = true, issue = { number: 7, html_url: "https://x/7" } } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (String(url).includes("siteverify")) return { ok: true, json: async () => ({ success: turnstile }) };
    if (String(url).includes("api.github.com")) return { ok: true, json: async () => issue };
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
const GOOD = { title: "稳定币清结算", focus: "机制", email: "alice@gmail.com", message: "", turnstile: "TKN" };

test("OPTIONS 预检回 204 + CORS 头", async () => {
  const res = await handleIntake(new Request("https://w.dev", { method: "OPTIONS" }), ENV());
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe("https://qiuyuanqr.github.io");
});

test("非 POST 回 405", async () => {
  const res = await handleIntake(new Request("https://w.dev", { method: "GET" }), ENV());
  expect(res.status).toBe(405);
});

test("快乐路径：建 Issue、存打码前的真实邮箱进 KV、回 ok", async () => {
  const env = ENV();
  const fetchImpl = routeFetch();
  const res = await handleIntake(post(GOOD), env, { fetch: fetchImpl, now: NOW });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  // 邮箱以 sub:<number> 私有存 KV，供 M2b 用
  expect(env.INTAKE_KV.store.get("sub:7")).toBe("alice@gmail.com");
  // 发给 GitHub 的正文不含原始邮箱
  const ghCall = fetchImpl.calls.find((c) => String(c.url).includes("api.github.com"));
  expect(JSON.parse(ghCall.opts.body).body).not.toContain("alice@gmail.com");
  expect(JSON.parse(ghCall.opts.body).body).toContain("a****@gmail.com");
});

test("Turnstile 失败 → 403，不建 Issue", async () => {
  const fetchImpl = routeFetch({ turnstile: false });
  const res = await handleIntake(post(GOOD), ENV(), { fetch: fetchImpl, now: NOW });
  expect(res.status).toBe(403);
  expect(fetchImpl.calls.some((c) => String(c.url).includes("api.github.com"))).toBe(false);
});

test("校验失败 → 400 + details", async () => {
  const res = await handleIntake(post({ ...GOOD, title: "" }), ENV(), { fetch: routeFetch(), now: NOW });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("invalid");
});

test("超限 → 429", async () => {
  const env = ENV();
  env.INTAKE_KV = fakeKV({ "rl:email:alice@gmail.com:20260603": "4" });
  const res = await handleIntake(post(GOOD), env, { fetch: routeFetch(), now: NOW });
  expect(res.status).toBe(429);
});

test("坏 JSON → 400 bad_json", async () => {
  const req = new Request("https://w.dev", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
  const res = await handleIntake(req, ENV(), { fetch: routeFetch(), now: NOW });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("bad_json");
});

test("GitHub 建 Issue 失败 → 502", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("siteverify")) return { ok: true, json: async () => ({ success: true }) };
    return { ok: false, status: 500, text: async () => "boom" };
  };
  const res = await handleIntake(post(GOOD), ENV(), { fetch: fetchImpl, now: NOW });
  expect(res.status).toBe(502);
});
