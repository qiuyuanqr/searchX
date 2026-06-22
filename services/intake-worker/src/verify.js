// services/intake-worker/src/verify.js
// GET /verify?k=<token> → 提交前确认 token 有效，回显「打码邮箱」（不泄露完整邮箱）。
// 前端打开个人链接时调它：有效则回显授权身份并放开提交，无效则提示去找作者要链接。
import { emailForToken } from "./invite.js";
import { maskEmail } from "./issue-format.js";

export async function handleVerify(request, env) {
  const cors = { "access-control-allow-origin": env.ALLOWED_ORIGIN, vary: "origin" };
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...cors } });
  const token = new URL(request.url).searchParams.get("k") || "";
  const email = await emailForToken(env.INTAKE_KV, token);
  if (!email) return json({ ok: false });
  return json({ ok: true, email: maskEmail(email) });
}
