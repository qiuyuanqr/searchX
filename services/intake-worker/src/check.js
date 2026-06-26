// services/intake-worker/src/check.js
// 私密事实核查任务路由：/check、/check/pending、/check/<id>/done。
// 两把密钥完全隔离：CHECK_KEY（作者提交）/ CHECK_RUNNER_SECRET（runner 取/标任务）。
// 任务只存 KV，绝不进公开 GitHub Issue。
import { safeEqual } from "./safe-equal.js";

// runner 端点（pending / done）是服务端 runner 调用、不经浏览器，无需 CORS，用裸 json。
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });

function runnerAuthed(request, env) {
  const s = request.headers.get("x-check-runner-secret") || "";
  return !!env.CHECK_RUNNER_SECRET && safeEqual(s, env.CHECK_RUNNER_SECRET);
}

// POST /check —— 作者凭 CHECK_KEY 提交一条核查任务。
// 浏览器前端跨域调用：所有响应带 CORS、并处理 OPTIONS 预检（allow-headers 必含 x-check-key）。
export async function handleCheckSubmit(request, env, { now }) {
  const cors = {
    "access-control-allow-origin": env.ALLOWED_ORIGIN,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-check-key",
    vary: "origin",
  };
  const corsJson = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...cors } });

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const key = request.headers.get("x-check-key") || "";
  if (!env.CHECK_KEY || !safeEqual(key, env.CHECK_KEY)) {
    return corsJson({ ok: false, error: "unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return corsJson({ ok: false, error: "bad json" }, 400);
  }

  const text = (body.text || "").trim();
  const link = (body.link || "").trim();
  if (!text && !link) return corsJson({ ok: false, error: "empty" }, 400);
  if (text.length > 4000 || link.length > 1000) return corsJson({ ok: false, error: "too long" }, 400);

  const id = crypto.randomUUID();
  const task = { text, link, status: "pending", createdAt: now() };
  await env.INTAKE_KV.put(`check:${id}`, JSON.stringify(task), { expirationTtl: 7 * 24 * 3600 });
  return corsJson({ ok: true, id }, 201);
}

// GET /check/pending —— runner 凭 CHECK_RUNNER_SECRET 取待处理任务
export async function handleCheckPending(request, env) {
  if (!runnerAuthed(request, env)) return json({ ok: false, error: "unauthorized" }, 401);

  const list = await env.INTAKE_KV.list({ prefix: "check:" });
  const tasks = [];
  for (const k of list.keys) {
    const raw = await env.INTAKE_KV.get(k.name);
    if (!raw) continue;
    const t = JSON.parse(raw);
    if (t.status === "pending") tasks.push({ id: k.name.slice("check:".length), ...t });
  }
  return json({ ok: true, tasks });
}

// POST /check/<id>/done —— runner 标记完成
export async function handleCheckDone(request, env, id) {
  if (!runnerAuthed(request, env)) return json({ ok: false, error: "unauthorized" }, 401);

  const raw = await env.INTAKE_KV.get(`check:${id}`);
  if (!raw) return json({ ok: false, error: "not found" }, 404);

  const t = JSON.parse(raw);
  t.status = "done";
  await env.INTAKE_KV.put(`check:${id}`, JSON.stringify(t), { expirationTtl: 7 * 24 * 3600 });
  return json({ ok: true });
}
