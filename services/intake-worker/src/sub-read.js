// services/intake-worker/src/sub-read.js
// 只读端点：GET /sub/<issue号> → 返回该 Issue 提交者真实邮箱（M2a 存于私有 KV）。
// 仅供作者本机 M2b Runner 用，以共享密钥头鉴权。仓库公开，但此端点与 KV 不公开邮箱（需密钥）。
import { safeEqual } from "./safe-equal.js";

export async function handleSubRead(request, env) {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

  if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);

  const provided = request.headers.get("x-sub-secret") || "";
  if (!env.SUB_READ_SECRET || !safeEqual(provided, env.SUB_READ_SECRET)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const m = new URL(request.url).pathname.match(/^\/sub\/(\d+)$/);
  if (!m) return json({ ok: false, error: "bad_request" }, 400);

  const email = await env.INTAKE_KV.get(`sub:${m[1]}`);
  if (!email) return json({ ok: false, error: "not_found" }, 404);

  return json({ ok: true, email });
}
