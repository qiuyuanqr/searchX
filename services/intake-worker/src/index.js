// services/intake-worker/src/index.js
import { handleIntake } from "./handler.js";
import { handleSubRead } from "./sub-read.js";
import { handleAdmin } from "./admin.js";
import { handleVerify } from "./verify.js";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/sub/")) return handleSubRead(request, env);   // runner 取提交者邮箱（共享密钥）
    if (pathname.startsWith("/admin/")) return handleAdmin(request, env);   // 授权白名单管理（ADMIN_KEY）
    if (pathname === "/verify") return handleVerify(request, env);          // 提交前确认 token
    return handleIntake(request, env);                                       // 站内表单提交（token 鉴权）
  },
};
