// 精确匹配允许的浏览器来源；CORS 不代替接口原有的密钥/token 鉴权。
export function originHeaders(request, env) {
  const allowed = new Set([env.ALLOWED_ORIGIN, ...(env.ALLOWED_ORIGINS || "").split(",")]
    .map(value => String(value || "").trim()).filter(value => {
      try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && url.origin === value; }
      catch { return false; }
    }));
  // 无 Origin 的服务端调用保留旧配置响应，浏览器 Origin 则必须精确命中。
  const origin = request.headers.get("origin") ?? env.ALLOWED_ORIGIN;
  return { ...(allowed.has(origin) ? { "access-control-allow-origin": origin } : {}), vary: "Origin" };
}

export function withOrigin(response, request, env) {
  const headers = new Headers(response.headers);
  headers.delete("access-control-allow-origin");
  const selected = originHeaders(request, env);
  if (selected["access-control-allow-origin"]) headers.set("access-control-allow-origin", selected["access-control-allow-origin"]);
  const vary = new Set((headers.get("vary") || "").split(",").map(x => x.trim()).filter(Boolean));
  if (![...vary].some(x => x.toLowerCase() === "origin")) vary.add("Origin");
  headers.set("vary", [...vary].join(", "));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
