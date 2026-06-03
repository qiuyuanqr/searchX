// services/intake-worker/src/handler.js
import { validateSubmission } from "./validate.js";
import { verifyTurnstile } from "./turnstile.js";
import { checkRateLimit, dayKey } from "./ratelimit.js";
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

  const passed = await verifyTurnstile(token, env.TURNSTILE_SECRET, ip, fetchImpl);
  if (!passed) return json({ ok: false, error: "turnstile_failed" }, 403);

  const { ok: valid, errors, clean } = validateSubmission(input);
  if (!valid) return json({ ok: false, error: "invalid", details: errors }, 400);

  const rl = await checkRateLimit(env.INTAKE_KV, { ip, email: clean.email, dayKeyStr: dayKey(now) });
  if (!rl.allowed) return json({ ok: false, error: rl.reason }, 429);

  // 公开仓库 → Issue 正文只放打码邮箱
  const issue = formatIssue({ ...clean, email: maskEmail(clean.email) }, { author: env.AUTHOR_LOGIN });
  const created = await createIssue(
    { owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO, token: env.GITHUB_TOKEN, ...issue },
    fetchImpl
  );
  if (!created.ok) return json({ ok: false, error: "issue_create_failed" }, 502);

  // 真实邮箱私有存 KV（键 sub:<number>），供 M2b Emailer 取
  await env.INTAKE_KV.put(`sub:${created.number}`, clean.email);

  return json({ ok: true });
}
