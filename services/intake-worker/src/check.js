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
const RESULT_MAX_BYTES = 200 * 1024;       // 完整结果 markdown 封顶 200 KiB
const TITLE_MAX = 40;                       // 内容标题封顶 40 字（SKILL 要 12–20，此为防超写兜底）
const byteLen = (s) => new TextEncoder().encode(s).length;

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
function toIndexEntry(id, t, nowMs = Date.now()) {
  // updatedAt 是合并写择新的依据：两个 PoP 并发时，双方快照里都有的 id 必须取较新的那份，
  // 否则「done 被回退成 pending」——手机页据 pending 一直空转轮询，任务看着永远没跑完。
  const e = { id, createdAt: t.createdAt || "", status: t.status || "pending", snippet: taskSnippet(t), updatedAt: nowMs };
  if (t.summary) e.summary = t.summary;
  if (t.title) e.title = t.title;   // 核查完成回传的内容标题；未完成/旧任务无此字段，前端 fallback snippet
  return e;
}

// upsert：已存在则就地更新（去重 + 状态同步），否则追加。
function upsertIndexEntry(items, id, t, nowMs = Date.now()) {
  const e = items.find((x) => x && x.id === id);
  if (e) Object.assign(e, toIndexEntry(id, t, nowMs));
  else items.push(toIndexEntry(id, t, nowMs));
}

// 从全表 list 重建索引——唯一还用 list 的地方，仅索引缺失/不完整时走一次；成功即落
// { complete:true }，此后正常态不再 list。可能抛（list 额度耗尽）——调用方负责兜底。
async function rebuildIndex(env, nowMs = Date.now()) {
  const listed = await env.INTAKE_KV.list({ prefix: "check:" });
  const items = [];
  for (const k of listed.keys) {
    if (k.name === IDX_KEY) continue;                 // 别把索引自己当任务
    const raw = await env.INTAKE_KV.get(k.name);
    if (!raw) continue;
    const t = parseTask(raw);
    if (!t) continue;                                 // 跳过损坏条目
    items.push(toIndexEntry(k.name.slice("check:".length), t, nowMs));
  }
  await env.INTAKE_KV.put(IDX_KEY, JSON.stringify({ complete: true, rebuiltAt: nowMs, items }), { expirationTtl: TTL });
  return { items, complete: true };
}

// 从注入的 now()（ISO 串）取毫秒时间戳；取不到就退回真实时钟。
// 索引的过期修剪必须和写入 createdAt 用同一个时钟，否则测试/回放场景下会把有效条目全判过期。
function nowMsOf(opts) {
  const f = opts && typeof opts.now === "function" ? opts.now : null;
  if (!f) return Date.now();
  const t = Date.parse(f());
  return Number.isNaN(t) ? Date.now() : t;
}

// 索引强制重建周期：complete:true 会让 rebuildIndex 永不再跑，于是任何一次索引写丢条目
// （KV 无 CAS，两个 PoP 的读-改-写会互相覆盖）都没有自愈路径——那条任务全文还在 KV、状态还是
// pending，却永远不被 runner 下发、也不在手机列表里，直到 7 天 TTL 静默过期。
// 周期定在 30 分钟：并发丢条目无法用 KV 根治（没有 CAS），这条重建就是兜底，窗口多长
// 就意味着一条 pending 任务最久可能有多久不被 runner 下发。30 分钟 ≈ 48 次 list/天，
// 占免费版每日约 1000 的 5%，换掉原来 6 小时那个不可接受的失明窗口。
const REBUILD_EVERY_MS = 30 * 60 * 1000;

// 惰性修剪：任务本体 7 天 TTL 到期后自动消失，索引条目却只增不删。不修剪的话，手机页会长期
// 列出一堆点开即 404 的幽灵条目，其中 pending 状态的还会让页面永远 50 秒一轮地空转轮询。
function pruneExpired(items, nowMs) {
  if (!Number.isFinite(nowMs)) return items;
  return items.filter((e) => {
    if (!e || !e.id) return false;
    const t = Date.parse(e.createdAt || "");
    if (Number.isNaN(t)) return true;          // 时间读不出来 → 保守保留
    return nowMs - t < TTL * 1000;
  });
}

// 读索引：complete 且未到强制重建时点则直接用（1 read，不 list）；缺失/不完整/到期则尝试重建；
// 重建失败（如 list 额度耗尽）降级——返回已有不完整条目或空，绝不抛错拖成 500。
// 返回 { items, complete }。
async function loadIndexEx(env, nowMs = Date.now()) {
  let obj = null;
  try {
    const raw = await env.INTAKE_KV.get(IDX_KEY);
    if (raw) { const p = JSON.parse(raw); if (p && Array.isArray(p.items)) obj = p; }
  } catch { obj = null; }
  const fresh = obj && obj.complete &&
    Number.isFinite(obj.rebuiltAt) && nowMs - obj.rebuiltAt < REBUILD_EVERY_MS;
  if (fresh) return { items: pruneExpired(obj.items, nowMs), complete: true };
  try {
    const rebuilt = await rebuildIndex(env, nowMs);
    return { items: pruneExpired(rebuilt.items, nowMs), complete: true };
  } catch {
    // 重建不了（list 额度耗尽等）→ 用手上这份将就，绝不 500
    return { items: pruneExpired(obj && Array.isArray(obj.items) ? obj.items : [], nowMs), complete: !!(obj && obj.complete) };
  }
}

// 索引的读-改-写：写回前重读一次最新索引做并集合并。
// KV 没有 CAS，saveIndex 是整表盲覆盖：两个 PoP（手机提交 / runner 回传 done）并发时，
// 后写的那份会把先写的新条目整表抹掉。写回前重读一次做并集能盖住**大部分**交错，
// 但**不能声称杜绝丢条目**——真并发下两次读可能都拿到同一份旧值，合并不到任何东西
// （2026-07-31 第二轮审查实测证伪了这里原本「至少不会丢任务」的断言）。
// 所以真正兜底的是下面的强制重建周期：丢了条目最多 REBUILD_EVERY_MS 后由 list 重建捞回来。
async function upsertIndexMerged(env, id, task, nowMs = Date.now()) {
  const { items, complete } = await loadIndexEx(env, nowMs);
  upsertIndexEntry(items, id, task, nowMs);
  try {
    const raw = await env.INTAKE_KV.get(IDX_KEY);
    const latest = raw ? JSON.parse(raw) : null;
    if (latest && Array.isArray(latest.items)) {
      const byId = new Map(items.map((x) => [x && x.id, x]).filter(([k]) => k));
      for (const e of latest.items) {
        if (!e || !e.id || e.id === id) continue;      // 本次改的这条以我为准
        const mine = byId.get(e.id);
        if (!mine) { items.push(e); continue; }        // 我快照里没有 → 并进来
        // 两边都有：取较新的那份。没有 updatedAt 的老条目当 0，新写的一定更大。
        const a = Number.isFinite(mine.updatedAt) ? mine.updatedAt : 0;
        const b = Number.isFinite(e.updatedAt) ? e.updatedAt : 0;
        // 时间戳打平时（同一毫秒内的两次并发写很常见）还要看状态：pending → done/failed 是
        // 单向的，任务不会从「已完成」退回「处理中」。少了这条，两条 done 并发时先写的那条
        // 会被后写者的旧快照覆盖回 pending，手机页据此永远空转轮询。
        const terminal = (x) => x && x.status && x.status !== "pending";
        if (b > a || (b === a && terminal(e) && !terminal(mine))) Object.assign(mine, e);
      }
    }
  } catch {}
  await saveIndex(env, pruneExpired(items, nowMs), complete);
}

// 写回索引（沿用当前完整性标志）。调用方以 best-effort 方式 catch——索引维护失败绝不该
// 让 submit/done 本身失败（全文已落库，索引可由后续惰性重建补上）。
async function saveIndex(env, items, complete, rebuiltAt) {
  // rebuiltAt 原样带过去：普通 upsert 不算「重建」，不该把强制重建的时钟拨回去。
  const prev = rebuiltAt ?? (await readRebuiltAt(env));
  await env.INTAKE_KV.put(IDX_KEY, JSON.stringify({ complete, rebuiltAt: prev, items }), { expirationTtl: TTL });
}

async function readRebuiltAt(env) {
  try {
    const raw = await env.INTAKE_KV.get(IDX_KEY);
    const p = raw ? JSON.parse(raw) : null;
    return Number.isFinite(p?.rebuiltAt) ? p.rebuiltAt : 0;
  } catch { return 0; }
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
  // 图片写入包 try/catch：第 N 张失败时前 N-1 张已入 KV，若放任冒泡到兜底 500 会留孤儿键
  // （靠 7 天 TTL 兜底但与"先整体校验再落库"的意图不符）。失败时 best-effort 逐个清理已写入的
  // 键，此时任务键 check:<id> 尚未写入（下方顺序不变），无需回滚。
  try {
    for (let n = 0; n < imageFiles.length; n++) {
      const f = imageFiles[n];
      await env.INTAKE_KV.put(`checkimg:${id}:${n}`, await f.arrayBuffer(), {
        expirationTtl: TTL,
        metadata: { mime: f.type },
      });
      images.push({ mime: f.type, size: f.size });
    }
  } catch {
    for (let n = 0; n < images.length; n++) {
      try { await env.INTAKE_KV.delete(`checkimg:${id}:${n}`); } catch {}
    }
    return corsJson({ ok: false, error: "image_store_failed" }, 502);
  }
  const task = { text, link, status: "pending", createdAt: now(), images };
  await env.INTAKE_KV.put(`check:${id}`, JSON.stringify(task), { expirationTtl: TTL });
  // 维护 check:idx 索引（best-effort，失败不影响提交成功——全文已落库，索引可由后续惰性重建补上）。
  try {
    await upsertIndexMerged(env, id, task, nowMsOf({ now }));
  } catch {}
  return corsJson({ ok: true, id }, 201);
}

// GET /check/recent —— 作者凭 CHECK_KEY 查最近任务（手机核查页状态区用）。
// 只回轻量视图 { id, createdAt, status, textSnippet, summary? }，按 createdAt 降序；
// 绝不回 text/link 全文、更不回图片字节。浏览器跨域调用，带 CORS + OPTIONS 预检。
export async function handleCheckRecent(request, env, opts = {}) {
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
  const { items } = await loadIndexEx(env, nowMsOf(opts));
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
      if (e.title) view.title = e.title;   // 有内容标题就带上，前端优先用它当那行标题
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
export async function handleCheckPending(request, env, opts = {}) {
  if (!runnerAuthed(request, env)) return json({ ok: false, error: "unauthorized" }, 401);

  // 靠索引筛出 pending 的 id 再逐条取全文——不再全表 list（根治 list 额度耗尽 → 500）。
  // 以全文 status 为准：索引可能滞后（done 的索引同步是 best-effort），避免误把已完成任务发回 runner。
  const { items } = await loadIndexEx(env, nowMsOf(opts));
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
export async function handleCheckDone(request, env, id, opts = {}) {
  if (!runnerAuthed(request, env)) return json({ ok: false, error: "unauthorized" }, 401);

  const raw = await env.INTAKE_KV.get(`check:${id}`);
  if (!raw) return json({ ok: false, error: "not found" }, 404);

  const t = parseTask(raw);
  if (!t) return json({ ok: false, error: "not found" }, 404); // 值损坏，任务已不可用，按 404 处理

  let outcome = "", summary = "", result = "", title = "";
  try {
    const body = await request.json();
    if (body && typeof body === "object") {
      outcome = String(body.outcome || "");
      summary = String(body.summary || "").trim().slice(0, 200);
      result = typeof body.result === "string" ? body.result : "";
      title = String(body.title || "").trim().slice(0, TITLE_MAX);
    }
  } catch {}
  t.status = outcome === "failed" ? "failed" : "done";
  if (summary) t.summary = summary;
  if (title) t.title = title;   // 手机列表那行标题；空则不存（保留旧任务/pending 的 snippet fallback）
  await env.INTAKE_KV.put(`check:${id}`, JSON.stringify(t), { expirationTtl: TTL });
  // 完整结果 markdown 单独存 checkresult:<id>（7 天 TTL），供作者手机页详情视图懒加载渲染。
  // 不写进 task / idx（列表照旧只读轻量索引、保持快）。超限跳过、不截断（避免坏 markdown，
  // 详情走兜底文案）；存失败 best-effort catch——绝不拖垮 done（任务已标完成、图片仍会清）。
  if (result && byteLen(result) <= RESULT_MAX_BYTES) {
    try { await env.INTAKE_KV.put(`checkresult:${id}`, result, { expirationTtl: TTL }); } catch {}
  }
  // 同步 check:idx 索引条目 status/summary（best-effort，失败不影响 done——全文已更新，
  // 索引可由后续惰性重建/自愈补上）。索引缺该条时 upsert 会追加（self-heal）。
  try {
    await upsertIndexMerged(env, id, t, nowMsOf(opts));
  } catch {}
  // 隐私加固：任务跑完即清图片字节（云端只停留到处理完）。best-effort——
  // 删失败不该影响 done 的 200（任务已标完成，图片随 7 天 TTL 兜底过期）。
  const imgs = Array.isArray(t.images) ? t.images : [];
  for (let n = 0; n < imgs.length; n++) {
    try { await env.INTAKE_KV.delete(`checkimg:${id}:${n}`); } catch {}
  }
  return json({ ok: true });
}

// GET /check/<id>/result —— 作者凭 CHECK_KEY 取某条核查的完整结果 markdown（详情视图懒加载）。
// 浏览器跨域调用，带 CORS + OPTIONS 预检 + 复用密钥错限频。无结果（旧任务 / 回传失败 / 超期）→ 404。
export async function handleCheckResult(request, env, id) {
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

  const result = await env.INTAKE_KV.get(`checkresult:${id}`);
  if (result == null) return corsJson({ ok: false, error: "not found" }, 404);
  return corsJson({ ok: true, result });
}
