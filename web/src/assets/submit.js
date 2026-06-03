// 提交表单的纯逻辑：拼载荷 + 把响应映射成中文。
// DOM 引导（打开/关闭弹窗、提交、Turnstile 渲染）统一由 feed.js 负责，feed.js 从这里 import 这两个纯函数。
// 纯函数：从表单字段值 + turnstile token 拼 POST 载荷。
export function buildPayload(fields, turnstileToken) {
  const s = (v) => (v == null ? "" : String(v)).trim();
  return {
    title: s(fields.title),
    focus: s(fields.focus),
    email: s(fields.email),
    message: s(fields.message),
    turnstile: turnstileToken || "",
  };
}

// 纯函数：把服务端响应（或异常）映射成给用户看的中文。
export function describeResult(res) {
  if (res && res.ok) {
    return {
      kind: "success",
      text: "已提交，作者会尽快审核。审核通过后研究结果会发到你的邮箱。",
    };
  }
  const map = {
    invalid: "请检查：题目和邮箱必填，且长度别超限。",
    bad_json: "提交格式有误，请重试。",
    turnstile_failed: "人机验证未通过，请重试。",
    ip_rate_limited: "今天提交太多次了，请明天再来。",
    email_rate_limited: "这个邮箱今天提交太多次了，请明天再来。",
    issue_create_failed: "服务器开小差了，请稍后重试。",
  };
  const code = res && res.error;
  return { kind: "error", text: map[code] || "提交失败，请稍后重试。" };
}
