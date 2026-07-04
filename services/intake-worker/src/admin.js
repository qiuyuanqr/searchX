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

  // 鉴权 + 失败限流：对密钥优先放行（清零失败计数——邻居 IP 的错误尝试绝不能把合法管理员锁在门外）；
  // 错 / 空密钥才计数，达 maxFails 起一律 429（不泄露对错），否则 401。定长比较防时序侧信道、空密钥一律拒。
  const fails = parseInt((await kv.get(failKey)) || "0", 10);
  const keyOk = !!env.ADMIN_KEY && safeEqual(request.headers.get("x-admin-key") || "", env.ADMIN_KEY);
  if (keyOk) {
    if (fails) await kv.delete(failKey);
  } else {
    const n = fails + 1;
    await kv.put(failKey, String(n), { expirationTtl: 7200 });
    const locked = n >= maxFails;
    return json({ ok: false, error: locked ? "locked" : "unauthorized" }, locked ? 429 : 401);
  }

  const { pathname } = new URL(request.url);
  try {
    if (request.method === "GET" && pathname === "/admin/list") {
      return json({ ok: true, people: await listPeople(kv) });
    }
    if (request.method === "POST" && pathname === "/admin/add") {
      const body = await request.json().catch(() => ({}));
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (!isEmail(email) || email.length > 254) return json({ ok: false, error: "invalid_email" }, 400);
      const r = await mintInvite(kv, email, { now, gen: deps.gen });
      return json({ ok: true, ...r });
    }
    if (request.method === "POST" && pathname === "/admin/remove") {
      const body = await request.json().catch(() => ({}));
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const ok = await revoke(kv, email);
      return json({ ok, removed: ok });
    }
    if (request.method === "POST" && pathname === "/admin/rotate") {
      const body = await request.json().catch(() => ({}));
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const r = await rotate(kv, email, { now, gen: deps.gen });
      return r ? json({ ok: true, ...r }) : json({ ok: false, error: "not_found" }, 404);
    }
    return json({ ok: false, error: "not_found" }, 404);
  } catch {
    return json({ ok: false, error: "internal" }, 500);
  }
}
