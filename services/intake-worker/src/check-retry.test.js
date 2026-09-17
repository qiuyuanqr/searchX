// services/intake-worker/src/check-retry.test.js
// 2026-09-17 第二批：/check/<id>/start（runner 标记开跑）、/retry（失败任务一键重试）、
// /recheck（补证据重查）、pending 附父任务结果、recent 视图新字段。
import { test, expect } from "bun:test";
import { handleCheckStart, handleCheckRetry, handleCheckRecheck, handleCheckPending, handleCheckRecent, handleCheckDone } from "./check.js";
import worker from "./index.js";

function fakeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  const meta = new Map();
  return {
    store: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async getWithMetadata(k) { return m.has(k) ? { value: m.get(k), metadata: meta.get(k) || null } : { value: null, metadata: null }; },
    async put(k, v, opts = {}) { m.set(k, v); if (opts.metadata) meta.set(k, opts.metadata); },
    async delete(k) { m.delete(k); meta.delete(k); },
    async list({ prefix } = {}) {
      return { keys: [...m.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })), list_complete: true, cursor: "" };
    },
  };
}
const ENV = (over = {}) => ({ ALLOWED_ORIGIN: "https://qiuyuanqr.github.io", CHECK_KEY: "CK_GOOD", CHECK_RUNNER_SECRET: "RS_GOOD", INTAKE_KV: fakeKV(), ...over });
const NOW = () => "2026-09-17T06:00:00.000Z";
const task = (over = {}) => JSON.stringify({ text: "某说法", link: "", status: "pending", createdAt: "2026-09-17T05:50:00.000Z", images: [], ...over });
const stored = (kv, id) => JSON.parse(kv.store.get(`check:${id}`));
const idx = (kv) => JSON.parse(kv.store.get("check:idx")).items;

const start = (env, id, headers = { "x-check-runner-secret": "RS_GOOD" }) =>
  handleCheckStart(new Request(`https://w.dev/check/${id}/start`, { method: "POST", headers }), env, id, { now: NOW });
const retry = (env, id, headers = { "x-check-key": "CK_GOOD" }, method = "POST") =>
  handleCheckRetry(new Request(`https://w.dev/check/${id}/retry`, { method, headers }), env, id, { now: NOW });
const recheckJson = (env, id, body = {}, headers = { "x-check-key": "CK_GOOD" }) =>
  handleCheckRecheck(new Request(`https://w.dev/check/${id}/recheck`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), env, id, { now: NOW });
const pending = (env) => handleCheckPending(new Request("https://w.dev/check/pending", { headers: { "x-check-runner-secret": "RS_GOOD" } }), env, { now: NOW });
const recent = (env) => handleCheckRecent(new Request("https://w.dev/check/recent", { headers: { "x-check-key": "CK_GOOD" } }), env, { now: NOW });
const done = (env, id, body) => handleCheckDone(new Request(`https://w.dev/check/${id}/done`, { method: "POST", headers: { "x-check-runner-secret": "RS_GOOD", "content-type": "application/json" }, body: JSON.stringify(body) }), env, id, { now: NOW });

// ── start ──
test("start：runner 密钥 → 记 startedAt，状态仍是 pending，索引条目同步", async () => {
  const kv = fakeKV({ "check:t1": task() });
  const env = ENV({ INTAKE_KV: kv });
  const res = await start(env, "t1");
  expect(res.status).toBe(200);
  expect(stored(kv, "t1")).toMatchObject({ status: "pending", startedAt: NOW() });
  expect(idx(kv).find((e) => e.id === "t1").startedAt).toBe(NOW());
  // pending 队列不受影响：runner 崩了下一轮还能重取
  const p = await (await pending(env)).json();
  expect(p.tasks.map((t) => t.id)).toEqual(["t1"]);
});

test("start：错密钥 401 / 不存在 404；CHECK_KEY 不能冒充 runner", async () => {
  const kv = fakeKV({ "check:t1": task() });
  const env = ENV({ INTAKE_KV: kv });
  expect((await start(env, "t1", { "x-check-runner-secret": "nope" })).status).toBe(401);
  expect((await start(env, "t1", { "x-check-key": "CK_GOOD" })).status).toBe(401);
  expect((await start(env, "missing")).status).toBe(404);
  expect(stored(kv, "t1").startedAt).toBeUndefined();
});

test("done 清掉 startedAt（终态不再显示核查中），索引条目也不再带", async () => {
  const kv = fakeKV({ "check:t1": task({ startedAt: "2026-09-17T05:55:00.000Z" }) });
  const env = ENV({ INTAKE_KV: kv });
  await start(env, "t1");
  await done(env, "t1", { outcome: "done", summary: "属实（高）：真" });
  expect(stored(kv, "t1").startedAt).toBeUndefined();
  expect(idx(kv).find((e) => e.id === "t1").startedAt).toBeUndefined();
});

// ── retry ──
test("retry：failed 任务 → 回 pending、清 summary/title/startedAt、retries+1；图片键仍在；索引同步", async () => {
  const kv = fakeKV({
    "check:t1": task({ status: "failed", summary: "连续失败 3 次", title: "旧标题", startedAt: "x", images: [{ mime: "image/jpeg", size: 3 }] }),
    "checkimg:t1:0": new Uint8Array([1]).buffer,
  });
  const env = ENV({ INTAKE_KV: kv });
  await recent(env); // 先让索引建出来（含旧 summary/title）
  const res = await retry(env, "t1");
  expect(res.status).toBe(200);
  expect(res.headers.get("access-control-allow-origin")).toBe("https://qiuyuanqr.github.io");
  const t = stored(kv, "t1");
  expect(t.status).toBe("pending");
  expect(t.summary).toBeUndefined();
  expect(t.title).toBeUndefined();
  expect(t.startedAt).toBeUndefined();
  expect(t.retries).toBe(1);
  expect(kv.store.has("checkimg:t1:0")).toBe(true);
  const e = idx(kv).find((x) => x.id === "t1");
  expect(e.status).toBe("pending");
  expect(e.summary).toBeUndefined();   // 旧失败原因不能留在索引里顶着
  expect(e.title).toBeUndefined();
  expect(e.retries).toBe(1);
  // runner 下一轮能取到
  const p = await (await pending(env)).json();
  expect(p.tasks.map((x) => x.id)).toEqual(["t1"]);
  // 再 retry 一次：已在排队 → 409
  expect((await retry(env, "t1")).status).toBe(409);
});

test("retry：done 任务 409（该走 recheck）；不存在 404；错密钥 401；OPTIONS 204", async () => {
  const kv = fakeKV({ "check:d1": task({ status: "done" }) });
  const env = ENV({ INTAKE_KV: kv });
  expect((await retry(env, "d1")).status).toBe(409);
  expect((await retry(env, "nope")).status).toBe(404);
  expect((await retry(env, "d1", { "x-check-key": "bad" })).status).toBe(401);
  expect((await retry(env, "d1", {}, "OPTIONS")).status).toBe(204);
  expect(stored(kv, "d1").status).toBe("done");
});

// ── recheck ──
test("recheck：父任务 done → 新建任务挂 parentId/parentTitle，载荷可全空；pending 下发 parentResult 与 parentClaim", async () => {
  const kv = fakeKV({
    "check:p1": task({ status: "done", title: "某公众号称XX", text: "原始说法", link: "https://e.com/a" }),
    "checkresult:p1": "---\nverdict: 属实\n---\n## 真相直述\n上次的笔记",
    "check:plain": task(),   // 无父任务的普通任务：一开始就在库里（索引建好后直接塞 KV 的条目要等 30 分钟强制重建才可见，属设计）
  });
  const env = ENV({ INTAKE_KV: kv });
  const res = await recheckJson(env, "p1", { text: "新证据：官方公告说……" });
  expect(res.status).toBe(201);
  const { id } = await res.json();
  const t = stored(kv, id);
  expect(t).toMatchObject({ status: "pending", parentId: "p1", parentTitle: "某公众号称XX", text: "新证据：官方公告说……" });
  // 全空也允许（只是"再查一遍"）
  const res2 = await recheckJson(env, "p1", {});
  expect(res2.status).toBe(201);
  // pending 附父任务整篇与原始内容
  const p = await (await pending(env)).json();
  const mine = p.tasks.find((x) => x.id === id);
  expect(mine.parentResult).toContain("上次的笔记");
  expect(mine.parentClaim).toEqual({ text: "原始说法", link: "https://e.com/a" });
  // 无父任务的普通任务不带这两个字段
  const plain = p.tasks.find((x) => x.id === "plain");
  expect(plain.parentResult).toBeUndefined();
  expect(plain.parentClaim).toBeUndefined();
});

test("recheck：父结果已过期 → parentResult 为 null 但任务照常下发", async () => {
  const kv = fakeKV({ "check:p1": task({ status: "done" }) });
  const env = ENV({ INTAKE_KV: kv });
  const { id } = await (await recheckJson(env, "p1", { text: "补充" })).json();
  const p = await (await pending(env)).json();
  const mine = p.tasks.find((x) => x.id === id);
  expect(mine.parentResult).toBeNull();
  expect(mine.parentClaim).toEqual({ text: "某说法", link: "" });
});

test("recheck：父任务 pending / failed → 409；不存在 404；错密钥 401；超长 400", async () => {
  const kv = fakeKV({ "check:q": task(), "check:f": task({ status: "failed" }), "check:d": task({ status: "done" }) });
  const env = ENV({ INTAKE_KV: kv });
  expect((await recheckJson(env, "q", { text: "x" })).status).toBe(409);
  expect((await recheckJson(env, "f", { text: "x" })).status).toBe(409);
  expect((await recheckJson(env, "nope", { text: "x" })).status).toBe(404);
  expect((await recheckJson(env, "d", { text: "x" }, { "x-check-key": "bad" })).status).toBe(401);
  expect((await recheckJson(env, "d", { text: "x".repeat(4001) })).status).toBe(400);
  expect([...kv.store.keys()].filter((k) => k.startsWith("check:") && !["check:q", "check:f", "check:d", "check:idx"].includes(k))).toEqual([]);
});

// ── recent 视图新字段 ──
test("recent：视图带 startedAt / retries / parentId（有才带）", async () => {
  const kv = fakeKV({
    "check:a": task({ startedAt: "2026-09-17T05:58:00.000Z", retries: 2 }),
    "check:b": task({ status: "pending", parentId: "a", createdAt: "2026-09-17T05:59:00.000Z" }),
    "check:c": task({ createdAt: "2026-09-17T05:40:00.000Z" }),
  });
  const env = ENV({ INTAKE_KV: kv });
  const { tasks } = await (await recent(env)).json();
  const by = Object.fromEntries(tasks.map((t) => [t.id, t]));
  expect(by.a.startedAt).toBe("2026-09-17T05:58:00.000Z");
  expect(by.a.retries).toBe(2);
  expect(by.b.parentId).toBe("a");
  expect(by.c.startedAt).toBeUndefined();
  expect(by.c.retries).toBeUndefined();
  expect(by.c.parentId).toBeUndefined();
});

// ── 路由 ──
test("路由：start/retry/recheck 接通；保留路径段 pending/recent 不当 id；错方法 405", async () => {
  const kv = fakeKV({ "check:t1": task(), "check:d1": task({ status: "done" }), "check:f1": task({ status: "failed" }) });
  const env = ENV({ INTAKE_KV: kv });
  const req = (method, path, headers = {}, body) => worker.fetch(new Request(`https://w.dev${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body != null ? JSON.stringify(body) : undefined }), env);
  expect((await req("POST", "/check/t1/start", { "x-check-runner-secret": "RS_GOOD" })).status).toBe(200);
  expect((await req("POST", "/check/f1/retry", { "x-check-key": "CK_GOOD" })).status).toBe(200);
  expect((await req("POST", "/check/d1/recheck", { "x-check-key": "CK_GOOD" }, { text: "补" })).status).toBe(201);
  expect((await req("GET", "/check/t1/start", { "x-check-runner-secret": "RS_GOOD" })).status).toBe(405);
  expect((await req("GET", "/check/f1/retry", { "x-check-key": "CK_GOOD" })).status).toBe(405);
  expect((await req("POST", "/check/pending/retry", { "x-check-key": "CK_GOOD" })).status).toBe(404);
  expect((await req("POST", "/check/recent/recheck", { "x-check-key": "CK_GOOD" }, {})).status).toBe(404);
  expect((await req("OPTIONS", "/check/d1/recheck")).status).toBe(204);
});
