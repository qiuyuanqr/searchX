// services/intake-worker/src/admin.js
// 管理路由 /admin/*：ADMIN_KEY 鉴权 + 失败限流锁定 + 增/查/删/轮换授权白名单。
// 安全要点：管理凭证（ADMIN_KEY，请求头）与朋友的提交 token 完全隔离；定长比较防时序侧信道；
// 按 IP 对错误密钥计数，达阈值临时 429（防暴力 / 防刷）。
import { safeEqual } from "./safe-equal.js";
import { mintInvite, listPeople, revoke, rotate } from "./invite.js";

const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

// 北京时间「年月日时」桶，用于把失败计数按小时归并、自动过期。
const hourKey = (ms) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", hour12: false,
  }).format(new Date(ms)).replace(/[^0-9]/g, "");

export async function handleAdmin(request, env, deps = {}) {
  const now = deps.now || (() => Date.now());
  const cors = {
    "access-control-allow-origin": env.ALLOWED_ORIGIN,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-admin-key",
    vary: "origin",
  };
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...cors } });

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const kv = env.INTAKE_KV;
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const maxFails = parseInt(env.ADMIN_MAX_FAILS_PER_HOUR || "10", 10) || 10;
  const failKey = `afail:${encodeURIComponent(ip)}:${hourKey(now())}`;

  // 失败限流：先看是否已锁定（即便后面给对密钥，锁定期内也先拒）
  const fails = parseInt((await kv.get(failKey)) || "0", 10);
  if (fails >= maxFails) return json({ ok: false, error: "locked" }, 429);

  // 鉴权：定长比较；未配 / 空密钥一律拒绝（防空密钥裸奔）
  const provided = request.headers.get("x-admin-key") || "";
  if (!env.ADMIN_KEY || !safeEqual(provided, env.ADMIN_KEY)) {
    await kv.put(failKey, String(fails + 1), { expirationTtl: 7200 });
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const { pathname } = new URL(request.url);
  try {
    if (request.method === "GET" && pathname === "/admin/list") {
      return json({ ok: true, people: await listPeople(kv) });
    }
    if (request.method === "POST" && pathname === "/admin/add") {
      const body = await request.json().catch(() => ({}));
      const email = typeof body.email === "string" ? body.email.trim() : "";
      if (!isEmail(email) || email.length > 254) return json({ ok: false, error: "invalid_email" }, 400);
      const r = await mintInvite(kv, email, { now, gen: deps.gen });
      return json({ ok: true, ...r });
    }
    if (request.method === "POST" && pathname === "/admin/remove") {
      const body = await request.json().catch(() => ({}));
      const email = typeof body.email === "string" ? body.email.trim() : "";
      const ok = await revoke(kv, email);
      return json({ ok, removed: ok });
    }
    if (request.method === "POST" && pathname === "/admin/rotate") {
      const body = await request.json().catch(() => ({}));
      const email = typeof body.email === "string" ? body.email.trim() : "";
      const r = await rotate(kv, email, { now, gen: deps.gen });
      return r ? json({ ok: true, ...r }) : json({ ok: false, error: "not_found" }, 404);
    }
    return json({ ok: false, error: "not_found" }, 404);
  } catch {
    return json({ ok: false, error: "internal" }, 500);
  }
}
