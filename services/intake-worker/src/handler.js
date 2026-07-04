// services/intake-worker/src/handler.js
// 提交主流程：token 鉴权 → 校验内容 → 安全初筛 → 限频 → 建 Issue（红旗降级 pending、否则 approved）
// → 私存提交者邮箱（runner 取来发信）。全部副作用经 deps 注入，离线可测。
// 邮箱不来自表单：由提交链接里的 token 反查得到，杜绝冒充他人 / 往邮箱字段塞注入。
import { validateContent } from "./validate.js";
import { peekRateLimit, commitRateLimit, dayKey } from "./ratelimit.js";
import { formatIssue, maskEmail } from "./issue-format.js";
import { createIssue } from "./github.js";
import { emailForToken } from "./invite.js";

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
    new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...cors } });

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  let input;
  try {
    input = await request.json();
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }

  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const token = typeof input?.k === "string" ? input.k : "";

  // 主体含多个下游网络/KV 调用，任一抛错都兜成结构化 500（带 CORS 头），不让裸 500 冒泡。
  try {
    // 凭证闸：token 必须有效；邮箱由映射取得（用户不输邮箱 → 杜绝冒充 / 注入）。
    const email = await emailForToken(env.INTAKE_KV, token);
    if (!email) return json({ ok: false, error: "unauthorized" }, 403);

    const { ok: valid, errors, clean, flags } = validateContent(input);
    if (!valid) return json({ ok: false, error: "invalid", details: errors }, 400);

    const emailCap = parseInt(env.MAX_PER_EMAIL_PER_DAY || "5", 10) || 5;
    const limits = { ip: 8, email: emailCap };
    const dk = dayKey(now);
    // 先只检查是否超限（不计数）：失败的请求不应消耗当日额度。
    const rl = await peekRateLimit(env.INTAKE_KV, { ip, email, dayKeyStr: dk, limits });
    if (!rl.allowed) return json({ ok: false, error: rl.reason }, 429);

    // 命中安全红旗 → 降级人工复核（pending）；干净 → 自动放行（approved）。
    const approved = flags.length === 0;
    const issue = formatIssue({ ...clean, email: maskEmail(email) }, { author: env.AUTHOR_LOGIN, flags, approved });
    const created = await createIssue(
      { owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO, token: env.GITHUB_TOKEN, ...issue },
      fetchImpl
    );
    if (!created.ok) return json({ ok: false, error: "issue_create_failed" }, 502);

    // Issue 已建成——以下两个 KV 写只是配套动作，各自吞错，绝不能让失败冒泡成 500。
    // 冒泡成 500 会让提交者以为没提交成功而重试，在 GitHub 上重复建一个 Issue（runner 跑两遍）；
    // 且首条的邮箱映射（sub:<number>）就此永久丢失，那条 Issue 完成后也永远发不出"已上线"邮件。
    // 失败语义与真实结果（Issue 已建成）相反，故仍按 ok:true 返回，只在 degraded 里如实告知。
    let degraded = false;
    try {
      // Issue 建成功之后才把额度 +1（建失败已在上面 return，不扣额度）。
      await commitRateLimit(env.INTAKE_KV, { ip, email, dayKeyStr: dk, limits });
    } catch {
      degraded = true;
    }
    try {
      // 真实邮箱私有存 KV（键 sub:<number>），供 runner 取来发信。60 天过期、用完即清。
      await env.INTAKE_KV.put(`sub:${created.number}`, email, { expirationTtl: 60 * 60 * 24 * 60 });
    } catch {
      degraded = true;
    }

    return json(degraded ? { ok: true, approved, degraded: true } : { ok: true, approved });
  } catch {
    return json({ ok: false, error: "internal" }, 500);
  }
}
