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

// DOM 引导：仅在浏览器运行（bun 测试环境无 document，自动跳过）。
if (typeof document !== "undefined") {
  const form = document.getElementById("submit-form");
  const statusEl = document.getElementById("form-status");

  const setStatus = (text, kind) => {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
    statusEl.hidden = false;
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const token = (fd.get("cf-turnstile-response") || "").toString();
    const payload = buildPayload(
      {
        title: fd.get("title"),
        focus: fd.get("focus"),
        email: fd.get("email"),
        message: fd.get("message"),
      },
      token
    );
    setStatus("提交中…", "pending");
    try {
      const r = await fetch(form.dataset.worker, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({ ok: false }));
      const out = describeResult(data);
      setStatus(out.text, out.kind);
      if (out.kind === "success") {
        form.reset();
        if (window.turnstile) window.turnstile.reset();
      }
    } catch {
      const out = describeResult({ ok: false });
      setStatus(out.text, out.kind);
    }
  });
}
