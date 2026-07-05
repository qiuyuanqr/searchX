// services/intake-worker/src/check.js
// 私密事实核查任务路由：/check、/check/pending、/check/<id>/done。
// 两把密钥完全隔离：CHECK_KEY（作者提交）/ CHECK_RUNNER_SECRET（runner 取/标任务）。
// 任务只存 KV，绝不进公开 GitHub Issue。
import { safeEqual } from "./safe-equal.js";

const TTL = 7 * 24 * 3600;                 // 任务与图片字节统一 7 天过期
const IDX_KEY = "check:idx";               // 轻量索引 key（替代全表 KV.list，见文件下方索引段）
const IMG_MAX_COUNT = 9;                    // 单次最多 9 张
const IMG_MAX_BYTES = 6 * 1024 * 1024;     // 单图上限 6 MiB
const IMG_MIME_ALLOW = new Set(["image/jpeg", "image/png", "image/webp"]);

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

// ── CHECK_KEY 在线暴力猜测限频 ─────────────────────────────────
// 同一 IP 在窗口内密钥错够 FAIL_LIMIT 次 → 该 IP 后续请求（含正确密钥）一律 429，
// 直到计数随 TTL 过期。只数失败，正常使用（偶尔输错一两次）远达不到。
// get-then-put 有竞态、KV 又是最终一致——这里只求"把无限次在线穷举压到有限次"，够用。
const FAIL_LIMIT = 20;
const FAIL_WINDOW_TTL = 3600; // 1 小时（每次失败续期，滑动窗口）

async function authFailuresExceeded(env, ip) {
  const n = parseInt(await env.INTAKE_KV.get(`checkfail:${ip}`), 10);
  return Number.isInteger(n) && n >= FAIL_LIMIT;
}

async function recordAuthFailure(env, ip) {
  const key = `checkfail:${ip}`;
  const n = (parseInt(await env.INTAKE_KV.get(key), 10) || 0) + 1;
  await env.INTAKE_KV.put(key, String(n), { expirationTtl: FAIL_WINDOW_TTL });
}

// 容错解析 check:* 值：损坏（非法 JSON）返回 null，绝不抛出。
// 纵深防御——不假设 KV 数据一定干净（如控制台误改），
// 单条坏数据不该让整张 pending 列表或某次 done 崩成 500。
function parseTask(raw) {
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

// ── check:idx 轻量索引：让 /check/recent、/check/pending 靠 read 工作，不再全表 KV.list ──
// list 是免费计划每日额度最紧的操作（约 1000/天），曾被 runner 每分钟轮询 /check/pending
// 打爆，额度一空两端点全抛错→兜底 500。索引把 list 降到"仅索引缺失/不完整时重建一次"，
// 正常态只 read（额度约 100 倍）。索引存 { complete, items:[{id,createdAt,status,snippet,summary?}] }。

// 轻量条目：recent 直接渲染、pending 靠它筛 id。绝不含 text/link/images 全文重字段。
function toIndexEntry(id, t) {
  const e = { id, createdAt: t.createdAt || "", status: t.status || "pending", snippet: taskSnippet(t) };
  if (t.summary) e.summary = t.summary;
  return e;
}

// upsert：已存在则就地更新（去重 + 状态同步），否则追加。
function upsertIndexEntry(items, id, t) {
  const e = items.find((x) => x && x.id === id);
  if (e) Object.assign(e, toIndexEntry(id, t));
  else items.push(toIndexEntry(id, t));
}

// 从全表 list 重建索引——唯一还用 list 的地方，仅索引缺失/不完整时走一次；成功即落
// { complete:true }，此后正常态不再 list。可能抛（list 额度耗尽）——调用方负责兜底。
async function rebuildIndex(env) {
  const listed = await env.INTAKE_KV.list({ prefix: "check:" });
  const items = [];
  for (const k of listed.keys) {
    if (k.name === IDX_KEY) continue;                 // 别把索引自己当任务
    const raw = await env.INTAKE_KV.get(k.name);
    if (!raw) continue;
    const t = parseTask(raw);
    if (!t) continue;                                 // 跳过损坏条目
    items.push(toIndexEntry(k.name.slice("check:".length), t));
  }
  await env.INTAKE_KV.put(IDX_KEY, JSON.stringify({ complete: true, items }), { expirationTtl: TTL });
  return { items, complete: true };
}

// 读索引：complete 则直接用（1 read，不 list）；缺失/不完整则尝试重建；重建失败（如 list
// 额度耗尽）降级——返回已有不完整条目或空，绝不抛错拖成 500。返回 { items, complete }。
async function loadIndexEx(env) {
  let obj = null;
  try {
    const raw = await env.INTAKE_KV.get(IDX_KEY);
    if (raw) { const p = JSON.parse(raw); if (p && Array.isArray(p.items)) obj = p; }
  } catch { obj = null; }
  if (obj && obj.complete) return { items: obj.items, complete: true };
  try {
    return await rebuildIndex(env);
  } catch {
    return { items: obj && Array.isArray(obj.items) ? obj.items : [], complete: false };
  }
}

// 写回索引（沿用当前完整性标志）。调用方以 best-effort 方式 catch——索引维护失败绝不该
// 让 submit/done 本身失败（全文已落库，索引可由后续惰性重建补上）。
async function saveIndex(env, items, complete) {
  await env.INTAKE_KV.put(IDX_KEY, JSON.stringify({ complete, items }), { expirationTtl: TTL });
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

  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  if (await authFailuresExceeded(env, ip)) return corsJson({ ok: false, error: "rate_limited" }, 429);
  const key = request.headers.get("x-check-key") || "";
  if (!env.CHECK_KEY || !safeEqual(key, env.CHECK_KEY)) {
    await recordAuthFailure(env, ip);
    return corsJson({ ok: false, error: "unauthorized" }, 401);
  }

  // multipart（带图片）走 formData；其余按 JSON（纯文本/链接，向后兼容）。
  const ct = request.headers.get("content-type") || "";
  let text = "", link = "", imageFiles = [];

  if (ct.includes("multipart/form-data")) {
    let form;
    try {
      form = await request.formData();
    } catch {
      return corsJson({ ok: false, error: "bad form" }, 400);
    }
    text = String(form.get("text") || "").trim();
    link = String(form.get("link") || "").trim();
    // 只收带 arrayBuffer() 的 File/Blob，过滤掉误填进 images 的纯字符串字段。
    imageFiles = form.getAll("images").filter((f) => f && typeof f.arrayBuffer === "function");
  } else {
    let body;
    try {
      body = await request.json();
    } catch {
      return corsJson({ ok: false, error: "bad json" }, 400);
    }
    if (!body || typeof body !== "object") body = {};
    text = String(body.text || "").trim();
    link = String(body.link || "").trim();
  }

  if (text.length > 4000 || link.length > 1000) return corsJson({ ok: false, error: "too long" }, 400);
  if (imageFiles.length > IMG_MAX_COUNT) return corsJson({ ok: false, error: "too many" }, 400);
  // 先整体校验所有图，再落库——避免部分写入后才发现某张不合法。
  for (const f of imageFiles) {
    if (f.size > IMG_MAX_BYTES || !IMG_MIME_ALLOW.has(f.type)) {
      return corsJson({ ok: false, error: "bad image" }, 400);
    }
  }
  if (!text && !link && imageFiles.length === 0) return corsJson({ ok: false, error: "empty" }, 400);

  const id = crypto.randomUUID();
  const images = [];
  for (let n = 0; n < imageFiles.length; n++) {
    const f = imageFiles[n];
    await env.INTAKE_KV.put(`checkimg:${id}:${n}`, await f.arrayBuffer(), {
      expirationTtl: TTL,
      metadata: { mime: f.type },
    });
    images.push({ mime: f.type, size: f.size });
  }
  const task = { text, link, status: "pending", createdAt: now(), images };
  await env.INTAKE_KV.put(`check:${id}`, JSON.stringify(task), { expirationTtl: TTL });
  // 维护 check:idx 索引（best-effort，失败不影响提交成功——全文已落库，索引可由后续惰性重建补上）。
  try {
    const { items, complete } = await loadIndexEx(env);
    upsertIndexEntry(items, id, task);
    await saveIndex(env, items, complete);
  } catch {}
  return corsJson({ ok: true, id }, 201);
}

// GET /check/recent —— 作者凭 CHECK_KEY 查最近任务（手机核查页状态区用）。
// 只回轻量视图 { id, createdAt, status, textSnippet, summary? }，按 createdAt 降序；
// 绝不回 text/link 全文、更不回图片字节。浏览器跨域调用，带 CORS + OPTIONS 预检。
export async function handleCheckRecent(request, env) {
  const cors = {
    "access-control-allow-origin": env.ALLOWED_ORIGIN,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type, x-check-key",
    vary: "origin",
  };
  const corsJson = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...cors } });

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  if (await authFailuresExceeded(env, ip)) return corsJson({ ok: false, error: "rate_limited" }, 429);
  const key = request.headers.get("x-check-key") || "";
  if (!env.CHECK_KEY || !safeEqual(key, env.CHECK_KEY)) {
    await recordAuthFailure(env, ip);
    return corsJson({ ok: false, error: "unauthorized" }, 401);
  }

  // 从索引直接映射轻量视图——不再逐条 get 全文、更不 list（根治 list 额度耗尽 → 500）。
  const { items } = await loadIndexEx(env);
  const tasks = items
    .filter((e) => e && e.id)
    .map((e) => {
      const view = {
        id: e.id,
        createdAt: e.createdAt || "",
        status: e.status || "pending",
        textSnippet: e.snippet || "",
      };
      if (e.summary) view.summary = e.summary;
      return view;
    });
  tasks.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return corsJson({ ok: true, tasks });
}

// 任务的可辨认摘要：text 前 40 字 > link 域名 > "N 张图"。够作者认出是哪条即可。
function taskSnippet(t) {
  const text = String(t.text || "").trim();
  if (text) return text.slice(0, 40);
  const link = String(t.link || "").trim();
  if (link) {
    try { return new URL(link).hostname; } catch { return link.slice(0, 40); }
  }
  const n = Array.isArray(t.images) ? t.images.length : 0;
  return n > 0 ? `${n} 张图` : "";
}

// GET /check/pending —— runner 凭 CHECK_RUNNER_SECRET 取待处理任务
export async function handleCheckPending(request, env) {
  if (!runnerAuthed(request, env)) return json({ ok: false, error: "unauthorized" }, 401);

  // 靠索引筛出 pending 的 id 再逐条取全文——不再全表 list（根治 list 额度耗尽 → 500）。
  // 以全文 status 为准：索引可能滞后（done 的索引同步是 best-effort），避免误把已完成任务发回 runner。
  const { items } = await loadIndexEx(env);
  const tasks = [];
  for (const e of items) {
    if (!e || e.status !== "pending") continue;
    const raw = await env.INTAKE_KV.get(`check:${e.id}`);
    if (!raw) continue;
    const t = parseTask(raw);
    if (!t) continue; // 跳过损坏条目，不拖垮整列表
    if (t.status === "pending") tasks.push({ id: e.id, ...t });
  }
  return json({ ok: true, tasks });
}

// GET /check/<id>/image/<n> —— runner 凭 CHECK_RUNNER_SECRET 取某张图片字节
export async function handleCheckImage(request, env, id, n) {
  if (!runnerAuthed(request, env)) return json({ ok: false, error: "unauthorized" }, 401);

  const got = await env.INTAKE_KV.getWithMetadata(`checkimg:${id}:${n}`, "arrayBuffer");
  if (!got || got.value == null) return json({ ok: false, error: "not found" }, 404);
  const mime = (got.metadata && got.metadata.mime) || "application/octet-stream";
  return new Response(got.value, { status: 200, headers: { "content-type": mime } });
}

// POST /check/<id>/done —— runner 标记完成。
// 可选 JSON body { outcome: "done"|"failed", summary }：failed 用于退休任务，
// summary 是一行结论（≤200 字），供 /check/recent 回显给作者手机页。
// 无 body / 坏 body 一律按旧行为（status=done、无 summary）容错处理——别把 done 卡死。
export async function handleCheckDone(request, env, id) {
  if (!runnerAuthed(request, env)) return json({ ok: false, error: "unauthorized" }, 401);

  const raw = await env.INTAKE_KV.get(`check:${id}`);
  if (!raw) return json({ ok: false, error: "not found" }, 404);

  const t = parseTask(raw);
  if (!t) return json({ ok: false, error: "not found" }, 404); // 值损坏，任务已不可用，按 404 处理

  let outcome = "", summary = "";
  try {
    const body = await request.json();
    if (body && typeof body === "object") {
      outcome = String(body.outcome || "");
      summary = String(body.summary || "").trim().slice(0, 200);
    }
  } catch {}
  t.status = outcome === "failed" ? "failed" : "done";
  if (summary) t.summary = summary;
  await env.INTAKE_KV.put(`check:${id}`, JSON.stringify(t), { expirationTtl: TTL });
  // 同步 check:idx 索引条目 status/summary（best-effort，失败不影响 done——全文已更新，
  // 索引可由后续惰性重建/自愈补上）。索引缺该条时 upsert 会追加（self-heal）。
  try {
    const { items, complete } = await loadIndexEx(env);
    upsertIndexEntry(items, id, t);
    await saveIndex(env, items, complete);
  } catch {}
  // 隐私加固：任务跑完即清图片字节（云端只停留到处理完）。best-effort——
  // 删失败不该影响 done 的 200（任务已标完成，图片随 7 天 TTL 兜底过期）。
  const imgs = Array.isArray(t.images) ? t.images : [];
  for (let n = 0; n < imgs.length; n++) {
    try { await env.INTAKE_KV.delete(`checkimg:${id}:${n}`); } catch {}
  }
  return json({ ok: true });
}
