// services/intake-worker/src/index.js
import { handleIntake } from "./handler.js";
import { handleSubRead } from "./sub-read.js";
import { handlePeople } from "./people.js";
import { handleAdmin } from "./admin.js";
import { handleVerify } from "./verify.js";
import { handleCheckSubmit, handleCheckPending, handleCheckDone, handleCheckImage, handleCheckRecent, handleCheckResult } from "./check.js";

// 兜底 500：各 handler 自身已尽量兜错，但鉴权前的 KV 读（如 admin.js 的失败限流计数、
// verify.js/check.js 的 emailForToken / authFailuresExceeded）都在各自的 try 之外——KV 抖动
// 时会一路冒泡到这里。裸抛出去 Cloudflare 只会回无 CORS 头的 1101 错误页，浏览器 fetch 直接
// 判定成网络错误、读不到任何原因。这里统一兜成带 CORS 的结构化 JSON 500。对纯服务端路由
// （/sub、/people、/check/pending 等只有 runner 用共享密钥调用）加这层 CORS 头无害——反正
// 不会有浏览器读它。
function internalErrorResponse(env) {
  const cors = {
    "access-control-allow-origin": env.ALLOWED_ORIGIN,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-check-key, x-admin-key",
    vary: "origin",
  };
  return new Response(JSON.stringify({ ok: false, error: "internal" }), {
    status: 500,
    headers: { "content-type": "application/json", ...cors },
  });
}

export default {
  async fetch(request, env) {
    try {
      // 注意：这里每个 handler 调用都必须 await 后再 return——在 async 函数里 `return
      // 某个会 reject 的 promise` 不经过本函数的 try/catch（承诺状态是外层直接采用，
      // 不会被当前调用栈的 catch 拦到），只有 `return await` 才会让 handler 的异常真正
      // 落进下面的 catch。漏一个 await，那条路由的兜底就形同没做。
      const { pathname } = new URL(request.url);
      if (pathname.startsWith("/sub/")) return await handleSubRead(request, env);   // runner 取提交者邮箱（共享密钥）
      if (pathname === "/people") return await handlePeople(request, env);          // runner 取授权列表做新链接自检（共享密钥）
      if (pathname.startsWith("/admin/")) return await handleAdmin(request, env);   // 授权白名单管理（ADMIN_KEY）
      if (pathname === "/verify") return await handleVerify(request, env);          // 提交前确认 token

      // 私密核查任务路由（/check/*）—— 任务只进 KV，不进公开 GitHub Issue。
      // OPTIONS 也走 handleCheckSubmit（它处理预检），别让预检穿透到 handleIntake（其 allow-headers 不含 x-check-key）。
      if (pathname === "/check") {
        if (request.method === "POST" || request.method === "OPTIONS")
          return await handleCheckSubmit(request, env, { now: () => new Date().toISOString() });
        return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
      }
      if (pathname === "/check/pending") {
        if (request.method === "GET") return await handleCheckPending(request, env);
        return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
      }
      // 作者查最近任务（CHECK_KEY）；OPTIONS 预检由 handleCheckRecent 自己处理
      if (pathname === "/check/recent") {
        if (request.method === "GET" || request.method === "OPTIONS") return await handleCheckRecent(request, env);
        return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
      }
      const doneMatch = pathname.match(/^\/check\/([^/]+)\/done$/);
      if (doneMatch) {
        // "pending"/"recent" 是保留路径段，不可当任务 id 用（精确匹配已在上面处理）
        if (doneMatch[1] === "pending" || doneMatch[1] === "recent")
          return new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
        if (request.method === "POST")
          return await handleCheckDone(request, env, doneMatch[1]);
        return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
      }
      const imgMatch = pathname.match(/^\/check\/([^/]+)\/image\/(\d+)$/);
      if (imgMatch) {
        if (request.method === "GET")
          return await handleCheckImage(request, env, imgMatch[1], Number(imgMatch[2]));
        return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
      }
      // 作者取某条核查的完整结果（CHECK_KEY）；OPTIONS 预检由 handleCheckResult 自己处理
      const resultMatch = pathname.match(/^\/check\/([^/]+)\/result$/);
      if (resultMatch) {
        // "pending"/"recent" 是保留路径段，不可当任务 id 用
        if (resultMatch[1] === "pending" || resultMatch[1] === "recent")
          return new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
        if (request.method === "GET" || request.method === "OPTIONS")
          return await handleCheckResult(request, env, resultMatch[1]);
        return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
      }
      if (pathname.startsWith("/check/"))
        return new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });

      return await handleIntake(request, env);                                // 站内表单提交（token 鉴权）
    } catch {
      return internalErrorResponse(env);
    }
  },
};
