import { test, expect } from "bun:test";
import { handleVerify } from "./verify.js";
import { mintInvite } from "./invite.js";

function fakeKV(){ const m=new Map(); return { store:m, async get(k){return m.has(k)?m.get(k):null;}, async put(k,v){m.set(k,v);}, async delete(k){m.delete(k);} }; }
const ENV = (kv) => ({ ALLOWED_ORIGIN: "https://qiuyuanqr.github.io", INTAKE_KV: kv });
const get = (q) => new Request(`https://w.dev/verify${q}`, { method: "GET" });

test("有效 token → ok + 打码邮箱（不泄露完整邮箱）", async () => {
  const kv = fakeKV();
  await mintInvite(kv, "bob@gmail.com", { gen: () => "TOK" });
  const r = await handleVerify(get("?k=TOK"), ENV(kv));
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.ok).toBe(true);
  expect(j.email).toBe("b***@gmail.com");
  expect(JSON.stringify(j)).not.toContain("bob@gmail.com");
});

test("无效 token → ok:false", async () => {
  const r = await handleVerify(get("?k=nope"), ENV(fakeKV()));
  expect((await r.json()).ok).toBe(false);
});

test("缺 k → ok:false", async () => {
  const r = await handleVerify(get(""), ENV(fakeKV()));
  expect((await r.json()).ok).toBe(false);
});

// ── token 传法：新式请求头 + 旧式查询串（2026-07-31）─────────────
// 走请求头后 token 不再落进 Worker 访问日志的 URL 字段；但缓存的旧前端仍在用 ?k=，必须兼容。
test("新式：x-invite-token 请求头里的 token 有效 → ok + 打码邮箱", async () => {
  const env = ENV(fakeKV());
  await env.INTAKE_KV.put("invite:TOK", "bob@x.com");
  const r = await handleVerify(
    new Request("https://w.dev/verify", { headers: { "x-invite-token": "TOK" } }),
    env
  );
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.ok).toBe(true);
  expect(j.email).toBe("b***@x.com");
});

test("旧式：?k= 查询串仍然有效（已发出去的旧链接不能失效）", async () => {
  const env = ENV(fakeKV());
  await env.INTAKE_KV.put("invite:TOK", "bob@x.com");
  const j = await (await handleVerify(new Request("https://w.dev/verify?k=TOK"), env)).json();
  expect(j.ok).toBe(true);
});

test("请求头优先于查询串（同时给时以头为准）", async () => {
  const env = ENV(fakeKV());
  await env.INTAKE_KV.put("invite:GOOD", "bob@x.com");
  const j = await (await handleVerify(
    new Request("https://w.dev/verify?k=BAD", { headers: { "x-invite-token": "GOOD" } }),
    env
  )).json();
  expect(j.ok).toBe(true);
});

test("OPTIONS 预检 → 204，allow-headers 含 x-invite-token（不然带自定义头的跨域请求会被浏览器拦掉）", async () => {
  const r = await handleVerify(new Request("https://w.dev/verify", { method: "OPTIONS" }), ENV(fakeKV()));
  expect(r.status).toBe(204);
  expect(r.headers.get("access-control-allow-headers")).toContain("x-invite-token");
  expect(r.headers.get("access-control-allow-origin")).toBe("https://qiuyuanqr.github.io");
});
