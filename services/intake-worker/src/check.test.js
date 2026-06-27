// services/intake-worker/src/check.test.js
import { test, expect } from "bun:test";
import { handleCheckSubmit, handleCheckPending, handleCheckDone } from "./check.js";
import worker from "./index.js";

function fakeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    store: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v, _opts) { m.set(k, v); },
    async list({ prefix } = {}) {
      return {
        keys: [...m.keys()]
          .filter((k) => !prefix || k.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
        cursor: "",
      };
    },
  };
}

const ENV = (over = {}) => ({
  ALLOWED_ORIGIN: "https://qiuyuanqr.github.io",
  CHECK_KEY: "CK_GOOD",
  CHECK_RUNNER_SECRET: "RS_GOOD",
  INTAKE_KV: fakeKV(),
  ...over,
});

const NOW = () => "2026-06-27T10:00:00.000Z";

// ── POST /check 提交 ─────────────────────────────────────────────

function postCheck(env, headers = {}, body = {}) {
  return handleCheckSubmit(
    new Request("https://w.dev/check", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env,
    { now: NOW },
  );
}

test("提交：无 x-check-key → 401，且不写 KV", async () => {
  const env = ENV();
  const res = await postCheck(env, {}, { text: "hello" });
  expect(res.status).toBe(401);
  expect(env.INTAKE_KV.store.size).toBe(0);
});

test("提交：错 key → 401，且不写 KV", async () => {
  const env = ENV();
  const res = await postCheck(env, { "x-check-key": "WRONG_KEY" }, { text: "hello" });
  expect(res.status).toBe(401);
  expect(env.INTAKE_KV.store.size).toBe(0);
});

test("提交：等长错 key → 401（恒定时间比较仍判错）", async () => {
  // CHECK_KEY = "CK_GOOD" 7字符，给等长但不同的串
  const env = ENV();
  const res = await postCheck(env, { "x-check-key": "CK_BAAD" }, { text: "hello" });
  expect(res.status).toBe(401);
  expect(env.INTAKE_KV.store.size).toBe(0);
});

test("提交：未配 CHECK_KEY → 401（防空密钥裸奔）", async () => {
  const env = ENV({ CHECK_KEY: "" });
  const res = await postCheck(env, { "x-check-key": "" }, { text: "hello" });
  expect(res.status).toBe(401);
});

test("提交：正确 key + 文本 → 201，写入 KV，status=pending，返回 {ok:true,id}", async () => {
  const env = ENV();
  const res = await postCheck(env, { "x-check-key": "CK_GOOD" }, { text: "这是一段核查文本" });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(typeof body.id).toBe("string");
  expect(body.id.length).toBeGreaterThan(0);
  // 验证 KV 写入
  const stored = JSON.parse(env.INTAKE_KV.store.get(`check:${body.id}`));
  expect(stored.text).toBe("这是一段核查文本");
  expect(stored.link).toBe("");
  expect(stored.status).toBe("pending");
  expect(stored.createdAt).toBe(NOW());
});

test("提交：正确 key + link → 201 写入", async () => {
  const env = ENV();
  const res = await postCheck(env, { "x-check-key": "CK_GOOD" }, { link: "https://example.com" });
  expect(res.status).toBe(201);
  const { id } = await res.json();
  const stored = JSON.parse(env.INTAKE_KV.store.get(`check:${id}`));
  expect(stored.link).toBe("https://example.com");
  expect(stored.text).toBe("");
});

test("提交：text 和 link 都空 → 400", async () => {
  const res = await postCheck(ENV(), { "x-check-key": "CK_GOOD" }, { text: "  ", link: "" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("empty");
});

test("提交：text 超 4000 字符 → 400", async () => {
  const res = await postCheck(
    ENV(),
    { "x-check-key": "CK_GOOD" },
    { text: "a".repeat(4001) },
  );
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("too long");
});

test("提交：link 超 1000 字符 → 400", async () => {
  const res = await postCheck(
    ENV(),
    { "x-check-key": "CK_GOOD" },
    { text: "some text", link: "https://x.com/" + "a".repeat(990) },
  );
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("too long");
});

test("提交：JSON 格式错误 → 400", async () => {
  const res = await handleCheckSubmit(
    new Request("https://w.dev/check", {
      method: "POST",
      headers: { "content-type": "application/json", "x-check-key": "CK_GOOD" },
      body: "not json",
    }),
    ENV(),
    { now: NOW },
  );
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("bad json");
});

// ── CORS（浏览器前端跨域调用 /check）─────────────────────────────

test("OPTIONS /check 预检 → 204 + CORS 头（allow-headers 含 x-check-key）", async () => {
  const res = await handleCheckSubmit(
    new Request("https://w.dev/check", { method: "OPTIONS" }),
    ENV(),
    { now: NOW },
  );
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe("https://qiuyuanqr.github.io");
  expect(res.headers.get("access-control-allow-headers")).toContain("x-check-key");
});

test("POST /check 成功响应头含 access-control-allow-origin", async () => {
  const res = await postCheck(ENV(), { "x-check-key": "CK_GOOD" }, { text: "hello" });
  expect(res.status).toBe(201);
  expect(res.headers.get("access-control-allow-origin")).toBe("https://qiuyuanqr.github.io");
});

test("401 响应也带 CORS 头（前端能读到错误）", async () => {
  const res = await postCheck(ENV(), { "x-check-key": "WRONG" }, { text: "hello" });
  expect(res.status).toBe(401);
  expect(res.headers.get("access-control-allow-origin")).toBe("https://qiuyuanqr.github.io");
});

// ── GET /check/pending ─────────────────────────────────────────

function getPending(env, headers = {}) {
  return handleCheckPending(
    new Request("https://w.dev/check/pending", {
      method: "GET",
      headers,
    }),
    env,
  );
}

test("pending：无 runner secret → 401", async () => {
  const res = await getPending(ENV());
  expect(res.status).toBe(401);
});

test("pending：错 runner secret → 401", async () => {
  const res = await getPending(ENV(), { "x-check-runner-secret": "WRONG" });
  expect(res.status).toBe(401);
});

test("pending：未配 CHECK_RUNNER_SECRET → 401（防空密钥裸奔）", async () => {
  const res = await getPending(
    ENV({ CHECK_RUNNER_SECRET: "" }),
    { "x-check-runner-secret": "" },
  );
  expect(res.status).toBe(401);
});

test("pending：有效 secret，只返回 status=pending 的任务", async () => {
  const kv = fakeKV({
    "check:id-pending": JSON.stringify({ text: "待核查", link: "", status: "pending", createdAt: NOW() }),
    "check:id-done": JSON.stringify({ text: "已完成", link: "", status: "done", createdAt: NOW() }),
  });
  const env = ENV({ INTAKE_KV: kv });
  const res = await getPending(env, { "x-check-runner-secret": "RS_GOOD" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.tasks).toHaveLength(1);
  expect(body.tasks[0].id).toBe("id-pending");
  expect(body.tasks[0].status).toBe("pending");
  // 确认 done 的任务不在结果里
  expect(body.tasks.find((t) => t.id === "id-done")).toBeUndefined();
});

test("pending：无任务时返回空数组", async () => {
  const res = await getPending(ENV(), { "x-check-runner-secret": "RS_GOOD" });
  expect(res.status).toBe(200);
  expect((await res.json()).tasks).toEqual([]);
});

test("pending：损坏条目被跳过、不拖垮整列表（其它仍正常返回）", async () => {
  const kv = fakeKV({
    "check:id-bad": "{ 这不是合法 JSON",
    "check:id-ok": JSON.stringify({ text: "待核查", link: "", status: "pending", createdAt: NOW() }),
  });
  const env = ENV({ INTAKE_KV: kv });
  const res = await getPending(env, { "x-check-runner-secret": "RS_GOOD" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.tasks).toHaveLength(1);
  expect(body.tasks[0].id).toBe("id-ok");
});

// ── POST /check/<id>/done ──────────────────────────────────────

function postDone(env, id, headers = {}) {
  return handleCheckDone(
    new Request(`https://w.dev/check/${id}/done`, {
      method: "POST",
      headers,
    }),
    env,
    id,
  );
}

test("done：无 runner secret → 401", async () => {
  const res = await postDone(ENV(), "some-id");
  expect(res.status).toBe(401);
});

test("done：错 runner secret → 401", async () => {
  const res = await postDone(ENV(), "some-id", { "x-check-runner-secret": "WRONG" });
  expect(res.status).toBe(401);
});

test("done：id 不存在 → 404", async () => {
  const res = await postDone(ENV(), "nonexistent", { "x-check-runner-secret": "RS_GOOD" });
  expect(res.status).toBe(404);
});

test("done：损坏值 → 干净的 404 结构化错误，而非未处理的 500", async () => {
  const kv = fakeKV({
    "check:id-bad": "{ 这不是合法 JSON",
  });
  const env = ENV({ INTAKE_KV: kv });
  const res = await postDone(env, "id-bad", { "x-check-runner-secret": "RS_GOOD" });
  expect(res.status).toBe(404);
  expect((await res.json()).ok).toBe(false);
});

test("done：标记成功 → status 变 done", async () => {
  const kv = fakeKV({
    "check:task-1": JSON.stringify({ text: "核查任务", link: "", status: "pending", createdAt: NOW() }),
  });
  const env = ENV({ INTAKE_KV: kv });
  const res = await postDone(env, "task-1", { "x-check-runner-secret": "RS_GOOD" });
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
  const stored = JSON.parse(kv.store.get("check:task-1"));
  expect(stored.status).toBe("done");
});

// ── 凭据隔离（重点）────────────────────────────────────────────

test("隔离：CHECK_KEY 用在 /check/pending 无效", async () => {
  const res = await getPending(ENV(), { "x-check-runner-secret": "CK_GOOD" });
  expect(res.status).toBe(401);
});

test("隔离：CHECK_KEY 用在 /check/<id>/done 无效", async () => {
  const kv = fakeKV({
    "check:t1": JSON.stringify({ text: "x", link: "", status: "pending", createdAt: NOW() }),
  });
  const res = await postDone(ENV({ INTAKE_KV: kv }), "t1", { "x-check-runner-secret": "CK_GOOD" });
  expect(res.status).toBe(401);
});

test("隔离：CHECK_RUNNER_SECRET 用在 /check 提交无效", async () => {
  const env = ENV();
  const res = await postCheck(env, { "x-check-key": "RS_GOOD" }, { text: "hello" });
  expect(res.status).toBe(401);
  expect(env.INTAKE_KV.store.size).toBe(0);
});

// ── Minor 1/2：路由方法兜底 + done id 边界（经 index.js 路由分发）──────────

function workerReq(method, path, headers = {}, body = undefined) {
  return worker.fetch(
    new Request(`https://w.dev${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body != null ? JSON.stringify(body) : undefined,
    }),
    ENV(),
  );
}

test("路由：GET /check（错方法）→ 405，不落到 handleIntake", async () => {
  const res = await workerReq("GET", "/check");
  expect(res.status).toBe(405);
  const body = await res.json();
  expect(body.error).toBe("method_not_allowed");
});

test("路由：PUT /check（错方法）→ 405", async () => {
  const res = await workerReq("PUT", "/check");
  expect(res.status).toBe(405);
  expect((await res.json()).error).toBe("method_not_allowed");
});

test("路由：POST /check/pending（错方法）→ 405", async () => {
  const res = await workerReq("POST", "/check/pending", { "x-check-runner-secret": "RS_GOOD" });
  expect(res.status).toBe(405);
  expect((await res.json()).error).toBe("method_not_allowed");
});

test("路由：DELETE /check/pending（错方法）→ 405", async () => {
  const res = await workerReq("DELETE", "/check/pending", { "x-check-runner-secret": "RS_GOOD" });
  expect(res.status).toBe(405);
  expect((await res.json()).error).toBe("method_not_allowed");
});

test("路由：GET /check/some-id/done（错方法）→ 405", async () => {
  const res = await workerReq("GET", "/check/some-id/done", { "x-check-runner-secret": "RS_GOOD" });
  expect(res.status).toBe(405);
  expect((await res.json()).error).toBe("method_not_allowed");
});

test("路由：未知子路径 /check/foo/bar → 404", async () => {
  const res = await workerReq("GET", "/check/foo/bar");
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBe("not found");
});

test("Minor 2：POST /check/pending/done（id=pending 保留字）→ 404", async () => {
  // id="pending" 不合法边界：明确返回 404
  const res = await workerReq("POST", "/check/pending/done", { "x-check-runner-secret": "RS_GOOD" });
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBe("not found");
});
