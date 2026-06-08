// services/intake-worker/src/sub-read.js
// 只读端点：GET /sub/<issue号> → 返回该 Issue 提交者真实邮箱（M2a 存于私有 KV）。
// 仅供作者本机 M2b Runner 用，以共享密钥头鉴权。仓库公开，但此端点与 KV 不公开邮箱（需密钥）。

// 恒定时间字符串比较：等长时不在首个不同字符处提前返回，逐字符 XOR 累加后才给结论，
// 耗时与内容无关 → 杜绝靠"对前几位会更慢"逐位猜密钥的时序侧信道。等长前提下连长度也不泄露。
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false; // 定长随机密钥，长度本身无信息量
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function handleSubRead(request, env) {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

  if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);

  const provided = request.headers.get("x-sub-secret") || "";
  if (!env.SUB_READ_SECRET || !safeEqual(provided, env.SUB_READ_SECRET)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const m = new URL(request.url).pathname.match(/^\/sub\/(\d+)$/);
  if (!m) return json({ ok: false, error: "bad_request" }, 400);

  const email = await env.INTAKE_KV.get(`sub:${m[1]}`);
  if (!email) return json({ ok: false, error: "not_found" }, 404);

  return json({ ok: true, email });
}
