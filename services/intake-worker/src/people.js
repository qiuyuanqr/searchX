// services/intake-worker/src/people.js
// 只读端点：GET /people → 授权白名单（打码邮箱 + token + addedAt）。
// 仅供作者本机 runner 的「新链接自检」用：发现新增/换钥授权 → 自动验证 → 邮件通知作者。
// 与 /sub 同一信任域、同一共享密钥头（x-sub-secret）鉴权；token 本身就是提交凭证，
// 此端点绝不能匿名可达。邮箱出门前打码（runner 通知只需要认出是谁，不需要完整邮箱）。
import { safeEqual } from "./safe-equal.js";
import { listPeople } from "./invite.js";
import { maskEmail } from "./issue-format.js";

export async function handlePeople(request, env) {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

  if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);

  const provided = request.headers.get("x-sub-secret") || "";
  if (!env.SUB_READ_SECRET || !safeEqual(provided, env.SUB_READ_SECRET)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const people = (await listPeople(env.INTAKE_KV)).map((p) => ({
    email: maskEmail(p.email),
    token: p.token,
    addedAt: p.addedAt,
  }));
  return json({ ok: true, people });
}
