// services/intake-worker/src/index.js
import { handleIntake } from "./handler.js";
import { handleSubRead } from "./sub-read.js";
import { handleAdmin } from "./admin.js";
import { handleVerify } from "./verify.js";
import { handleCheckSubmit, handleCheckPending, handleCheckDone } from "./check.js";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/sub/")) return handleSubRead(request, env);   // runner 取提交者邮箱（共享密钥）
    if (pathname.startsWith("/admin/")) return handleAdmin(request, env);   // 授权白名单管理（ADMIN_KEY）
    if (pathname === "/verify") return handleVerify(request, env);          // 提交前确认 token

    // 私密核查任务路由（/check/*）—— 任务只进 KV，不进公开 GitHub Issue。
    // OPTIONS 也走 handleCheckSubmit（它处理预检），别让预检穿透到 handleIntake（其 allow-headers 不含 x-check-key）。
    if (pathname === "/check" && (request.method === "POST" || request.method === "OPTIONS"))
      return handleCheckSubmit(request, env, { now: () => new Date().toISOString() });
    if (pathname === "/check/pending" && request.method === "GET")
      return handleCheckPending(request, env);
    const doneMatch = pathname.match(/^\/check\/([^/]+)\/done$/);
    if (doneMatch && request.method === "POST")
      return handleCheckDone(request, env, doneMatch[1]);

    return handleIntake(request, env);                                       // 站内表单提交（token 鉴权）
  },
};
