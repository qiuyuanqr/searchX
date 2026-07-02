// services/intake-worker/src/index.js
import { handleIntake } from "./handler.js";
import { handleSubRead } from "./sub-read.js";
import { handleAdmin } from "./admin.js";
import { handleVerify } from "./verify.js";
import { handleCheckSubmit, handleCheckPending, handleCheckDone, handleCheckImage, handleCheckRecent } from "./check.js";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/sub/")) return handleSubRead(request, env);   // runner 取提交者邮箱（共享密钥）
    if (pathname.startsWith("/admin/")) return handleAdmin(request, env);   // 授权白名单管理（ADMIN_KEY）
    if (pathname === "/verify") return handleVerify(request, env);          // 提交前确认 token

    // 私密核查任务路由（/check/*）—— 任务只进 KV，不进公开 GitHub Issue。
    // OPTIONS 也走 handleCheckSubmit（它处理预检），别让预检穿透到 handleIntake（其 allow-headers 不含 x-check-key）。
    if (pathname === "/check") {
      if (request.method === "POST" || request.method === "OPTIONS")
        return handleCheckSubmit(request, env, { now: () => new Date().toISOString() });
      return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
    }
    if (pathname === "/check/pending") {
      if (request.method === "GET") return handleCheckPending(request, env);
      return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
    }
    // 作者查最近任务（CHECK_KEY）；OPTIONS 预检由 handleCheckRecent 自己处理
    if (pathname === "/check/recent") {
      if (request.method === "GET" || request.method === "OPTIONS") return handleCheckRecent(request, env);
      return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
    }
    const doneMatch = pathname.match(/^\/check\/([^/]+)\/done$/);
    if (doneMatch) {
      // "pending"/"recent" 是保留路径段，不可当任务 id 用（精确匹配已在上面处理）
      if (doneMatch[1] === "pending" || doneMatch[1] === "recent")
        return new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
      if (request.method === "POST")
        return handleCheckDone(request, env, doneMatch[1]);
      return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
    }
    const imgMatch = pathname.match(/^\/check\/([^/]+)\/image\/(\d+)$/);
    if (imgMatch) {
      if (request.method === "GET")
        return handleCheckImage(request, env, imgMatch[1], Number(imgMatch[2]));
      return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
    }
    if (pathname.startsWith("/check/"))
      return new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });

    return handleIntake(request, env);                                       // 站内表单提交（token 鉴权）
  },
};
