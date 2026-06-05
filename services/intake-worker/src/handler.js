// services/intake-worker/src/handler.js
import { validateSubmission } from "./validate.js";
import { verifyTurnstile } from "./turnstile.js";
import { peekRateLimit, commitRateLimit, dayKey } from "./ratelimit.js";
import { formatIssue, maskEmail } from "./issue-format.js";
import { createIssue } from "./github.js";

export async function handleIntake(request, env, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const now = deps.now || new Date();

  const cors = {
    "access-control-allow-origin": env.ALLOWED_ORIGIN,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "origin",
  };
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json", ...cors },
    });

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  let input;
  try {
    input = await request.json();
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }

  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const token = typeof input?.turnstile === "string" ? input.turnstile : "";

  // 主体含多个下游网络调用（Turnstile / GitHub / KV），任一抛错都兜成结构化 500（带 CORS 头），
  // 而不是让异常冒泡成裸 500——前端才能拿到 {ok:false} 并给用户友好反馈。
  try {
    const passed = await verifyTurnstile(token, env.TURNSTILE_SECRET, ip, fetchImpl);
    if (!passed) return json({ ok: false, error: "turnstile_failed" }, 403);

    const { ok: valid, errors, clean } = validateSubmission(input);
    if (!valid) return json({ ok: false, error: "invalid", details: errors }, 400);

    const dk = dayKey(now);
    // 先只检查是否超限（不计数）：失败的请求不应消耗当日额度
    const rl = await peekRateLimit(env.INTAKE_KV, { ip, email: clean.email, dayKeyStr: dk });
    if (!rl.allowed) return json({ ok: false, error: rl.reason }, 429);

    // 公开仓库 → Issue 正文只放打码邮箱
    const issue = formatIssue({ ...clean, email: maskEmail(clean.email) }, { author: env.AUTHOR_LOGIN });
    const created = await createIssue(
      { owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO, token: env.GITHUB_TOKEN, ...issue },
      fetchImpl
    );
    if (!created.ok) return json({ ok: false, error: "issue_create_failed" }, 502);

    // Issue 建成功之后才把额度 +1（建失败已在上面 return，不会扣额度）
    await commitRateLimit(env.INTAKE_KV, { ip, email: clean.email, dayKeyStr: dk });

    // 真实邮箱私有存 KV（键 sub:<number>），供 M2b Emailer 取。设 60 天过期：覆盖
    // 「审批 → 跑研究 → 发信」最长周期，到期自动清；避免被驳回 / 永不审批的提交邮箱永久驻留
    // （隐私红线：个人信息用完即清、最小留存）。
    await env.INTAKE_KV.put(`sub:${created.number}`, clean.email, { expirationTtl: 60 * 60 * 24 * 60 });

    return json({ ok: true });
  } catch {
    return json({ ok: false, error: "internal" }, 500);
  }
}
