// services/intake-worker/src/check.test.js
import { test, expect } from "bun:test";
import { handleCheckSubmit, handleCheckPending, handleCheckDone, handleCheckImage } from "./check.js";
import worker from "./index.js";

function fakeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  const meta = new Map();
  return {
    store: m,
    meta,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async getWithMetadata(k) {
      if (!m.has(k)) return { value: null, metadata: null };
      return { value: m.get(k), metadata: meta.has(k) ? meta.get(k) : null };
    },
    async put(k, v, opts = {}) { m.set(k, v); if (opts.metadata) meta.set(k, opts.metadata); },
    async delete(k) { m.delete(k); meta.delete(k); },
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

// ── 图片上传（multipart）─────────────────────────────────────────

// 用 multipart/form-data 提交：text/link 字段 + images 文件（Blob）。不手设 content-type，
// 让 Request 据 FormData 自动带 multipart 边界——与浏览器一致。
function postCheckMultipart(env, { key = "CK_GOOD", text, link, images = [] } = {}) {
  const fd = new FormData();
  if (text != null) fd.append("text", text);
  if (link != null) fd.append("link", link);
  for (const img of images) {
    fd.append("images", new Blob([img.bytes], { type: img.mime }), img.name || "img");
  }
  return handleCheckSubmit(
    new Request("https://w.dev/check", {
      method: "POST",
      headers: key ? { "x-check-key": key } : {},
      body: fd,
    }),
    env,
    { now: NOW },
  );
}

const jpg = (n = 8) => ({ bytes: new Uint8Array(n).fill(1), mime: "image/jpeg", name: "a.jpg" });

test("multipart：图片 + 文本 → 201，图存 checkimg:<id>:<n>，任务 images 记 mime/size", async () => {
  const env = ENV();
  const res = await postCheckMultipart(env, {
    text: "看看这张图",
    images: [{ bytes: new Uint8Array([1, 2, 3, 4]), mime: "image/jpeg", name: "a.jpg" },
             { bytes: new Uint8Array([5, 6, 7]), mime: "image/png", name: "b.png" }],
  });
  expect(res.status).toBe(201);
  const { id } = await res.json();
  const task = JSON.parse(env.INTAKE_KV.store.get(`check:${id}`));
  expect(task.text).toBe("看看这张图");
  expect(task.status).toBe("pending");
  expect(task.images).toHaveLength(2);
  expect(task.images[0]).toEqual({ mime: "image/jpeg", size: 4 });
  expect(task.images[1]).toEqual({ mime: "image/png", size: 3 });
  // 图片字节落在独立键，带 mime metadata
  expect(env.INTAKE_KV.store.has(`checkimg:${id}:0`)).toBe(true);
  expect(env.INTAKE_KV.store.has(`checkimg:${id}:1`)).toBe(true);
  expect(env.INTAKE_KV.meta.get(`checkimg:${id}:0`)).toEqual({ mime: "image/jpeg" });
});

test("multipart：仅图片（无文本无链接）→ 201（图片可单独提交）", async () => {
  const env = ENV();
  const res = await postCheckMultipart(env, { images: [jpg()] });
  expect(res.status).toBe(201);
  const { id } = await res.json();
  const task = JSON.parse(env.INTAKE_KV.store.get(`check:${id}`));
  expect(task.text).toBe("");
  expect(task.link).toBe("");
  expect(task.images).toHaveLength(1);
});

test("multipart：仅文本（无图）→ 201，images 为空数组", async () => {
  const env = ENV();
  const res = await postCheckMultipart(env, { text: "纯文字也走 multipart" });
  expect(res.status).toBe(201);
  const { id } = await res.json();
  const task = JSON.parse(env.INTAKE_KV.store.get(`check:${id}`));
  expect(task.text).toBe("纯文字也走 multipart");
  expect(task.images).toEqual([]);
});

test("multipart：全空（无文本/链接/图）→ 400 empty，不写 KV", async () => {
  const env = ENV();
  const res = await postCheckMultipart(env, {});
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("empty");
  expect(env.INTAKE_KV.store.size).toBe(0);
});

test("multipart：错 key → 401，不写 KV", async () => {
  const env = ENV();
  const res = await postCheckMultipart(env, { key: "WRONG", images: [jpg()] });
  expect(res.status).toBe(401);
  expect(env.INTAKE_KV.store.size).toBe(0);
});

test("multipart：图片超 9 张 → 400 too many，不写 KV", async () => {
  const env = ENV();
  const res = await postCheckMultipart(env, { images: Array.from({ length: 10 }, () => jpg()) });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("too many");
  expect(env.INTAKE_KV.store.size).toBe(0);
});

test("multipart：恰好 9 张 → 201", async () => {
  const env = ENV();
  const res = await postCheckMultipart(env, { images: Array.from({ length: 9 }, () => jpg()) });
  expect(res.status).toBe(201);
});

test("multipart：单图超 6 MiB → 400 bad image，不写 KV", async () => {
  const env = ENV();
  const big = { bytes: new Uint8Array(6 * 1024 * 1024 + 1).fill(1), mime: "image/jpeg", name: "big.jpg" };
  const res = await postCheckMultipart(env, { images: [big] });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("bad image");
  expect(env.INTAKE_KV.store.size).toBe(0);
});

test("multipart：坏 mime（gif）→ 400 bad image，不写 KV", async () => {
  const env = ENV();
  const res = await postCheckMultipart(env, {
    images: [{ bytes: new Uint8Array([1, 2]), mime: "image/gif", name: "a.gif" }],
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("bad image");
  expect(env.INTAKE_KV.store.size).toBe(0);
});

test("multipart：webp 允许 → 201", async () => {
  const env = ENV();
  const res = await postCheckMultipart(env, {
    images: [{ bytes: new Uint8Array([1, 2]), mime: "image/webp", name: "a.webp" }],
  });
  expect(res.status).toBe(201);
});

// ── GET /check/<id>/image/<n> ──────────────────────────────────

function getImage(env, id, n, headers = {}) {
  return handleCheckImage(
    new Request(`https://w.dev/check/${id}/image/${n}`, { method: "GET", headers }),
    env,
    id,
    n,
  );
}

test("image：无 runner secret → 401", async () => {
  const env = ENV({ INTAKE_KV: fakeKV({ "checkimg:t1:0": new Uint8Array([1]).buffer }) });
  const res = await getImage(env, "t1", 0);
  expect(res.status).toBe(401);
});

test("image：错 runner secret → 401", async () => {
  const env = ENV();
  const res = await getImage(env, "t1", 0, { "x-check-runner-secret": "WRONG" });
  expect(res.status).toBe(401);
});

test("image：CHECK_KEY 用在 image 端点无效（凭据隔离）", async () => {
  const env = ENV();
  const res = await getImage(env, "t1", 0, { "x-check-runner-secret": "CK_GOOD" });
  expect(res.status).toBe(401);
});

test("image：有效 secret 取到图 → 200 + 字节 + content-type=mime", async () => {
  const bytes = new Uint8Array([9, 8, 7, 6]);
  const kv = fakeKV();
  await kv.put("checkimg:t1:0", bytes.buffer, { metadata: { mime: "image/png" } });
  const env = ENV({ INTAKE_KV: kv });
  const res = await getImage(env, "t1", 0, { "x-check-runner-secret": "RS_GOOD" });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
});

test("image：不存在 → 404", async () => {
  const env = ENV();
  const res = await getImage(env, "t1", 5, { "x-check-runner-secret": "RS_GOOD" });
  expect(res.status).toBe(404);
});

test("image：无 mime metadata → content-type 兜底 octet-stream", async () => {
  const kv = fakeKV();
  await kv.put("checkimg:t1:0", new Uint8Array([1]).buffer);
  const env = ENV({ INTAKE_KV: kv });
  const res = await getImage(env, "t1", 0, { "x-check-runner-secret": "RS_GOOD" });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/octet-stream");
});

// ── done 清图（隐私加固）───────────────────────────────────────

test("done：标完成同时清掉 checkimg:<id>:* 图片字节", async () => {
  const kv = fakeKV({
    "check:t1": JSON.stringify({ text: "", link: "", status: "pending", createdAt: NOW(), images: [{ mime: "image/jpeg", size: 3 }, { mime: "image/jpeg", size: 4 }] }),
    "checkimg:t1:0": new Uint8Array([1, 2, 3]).buffer,
    "checkimg:t1:1": new Uint8Array([4, 5, 6, 7]).buffer,
  });
  const env = ENV({ INTAKE_KV: kv });
  const res = await postDone(env, "t1", { "x-check-runner-secret": "RS_GOOD" });
  expect(res.status).toBe(200);
  expect(JSON.parse(kv.store.get("check:t1")).status).toBe("done");
  // 图片字节已清
  expect(kv.store.has("checkimg:t1:0")).toBe(false);
  expect(kv.store.has("checkimg:t1:1")).toBe(false);
});

test("done：无图任务照常标完成（images 缺失不报错）", async () => {
  const kv = fakeKV({
    "check:t1": JSON.stringify({ text: "x", link: "", status: "pending", createdAt: NOW() }),
  });
  const env = ENV({ INTAKE_KV: kv });
  const res = await postDone(env, "t1", { "x-check-runner-secret": "RS_GOOD" });
  expect(res.status).toBe(200);
  expect(JSON.parse(kv.store.get("check:t1")).status).toBe("done");
});

// ── 路由：GET /check/<id>/image/<n> 经 index.js 分发 ───────────

test("路由：POST /check/t1/image/0（错方法）→ 405", async () => {
  const res = await workerReq("POST", "/check/t1/image/0", { "x-check-runner-secret": "RS_GOOD" });
  expect(res.status).toBe(405);
  expect((await res.json()).error).toBe("method_not_allowed");
});

test("路由：GET /check/t1/image/0（无 secret）→ 401（命中 image 处理器）", async () => {
  const res = await workerReq("GET", "/check/t1/image/0");
  expect(res.status).toBe(401);
});
