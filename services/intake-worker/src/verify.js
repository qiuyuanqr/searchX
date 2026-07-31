// services/intake-worker/src/verify.js
// GET /verify → 提交前确认 token 有效，回显「打码邮箱」（不泄露完整邮箱）。
// 前端打开个人链接时调它：有效则回显授权身份并放开提交，无效则提示去找作者要链接。
//
// token 的传法：优先读 `x-invite-token` 请求头（新式，token 不进 Worker 访问日志的 URL 字段），
// 读不到再回退 `?k=` 查询串——2026-07-31 之前的前端与已缓存的旧 HTML 都用查询串，必须永久兼容。
// 带自定义头的跨域请求会先发 OPTIONS 预检，所以这里必须自己处理 OPTIONS 并声明 allow-headers。
import { emailForToken } from "./invite.js";
import { maskEmail } from "./issue-format.js";

export async function handleVerify(request, env) {
  const cors = {
    "access-control-allow-origin": env.ALLOWED_ORIGIN,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type, x-invite-token",
    "access-control-max-age": "86400",
    vary: "origin",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...cors } });
  const token =
    (request.headers.get("x-invite-token") || "").trim() ||
    new URL(request.url).searchParams.get("k") ||
    "";
  const email = await emailForToken(env.INTAKE_KV, token);
  if (!email) return json({ ok: false });
  return json({ ok: true, email: maskEmail(email) });
}
