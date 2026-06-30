import { test, expect } from "bun:test";
import { buildPayload, tokenFromQuery, resolveToken, clearStoredToken, TOKEN_STORAGE_KEY, describeVerify, describeResult, escapeHtml, renderSearchResultsHTML, describeExistingReport } from "./submit.js";

// 假 storage：Map 撑起 get/set/remove；可选 throwOn 模拟隐私模式下方法抛错。
function fakeStorage(init = {}, throwOn = new Set()) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => { if (throwOn.has("get")) throw new Error("blocked"); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { if (throwOn.has("set")) throw new Error("blocked"); m.set(k, String(v)); },
    removeItem: (k) => { if (throwOn.has("remove")) throw new Error("blocked"); m.delete(k); },
    _map: m,
  };
}

test("buildPayload 去空白、带 token、不含 email/turnstile", () => {
  const p = buildPayload(
    { title: "  比特币挖矿  ", focus: " 能耗 ", message: "" },
    "TOK"
  );
  expect(p).toEqual({
    k: "TOK",
    title: "比特币挖矿",
    focus: "能耗",
    message: "",
  });
});

test("tokenFromQuery：从 ?k= 取 token；无则空串", () => {
  expect(tokenFromQuery("?k=abc123")).toBe("abc123");
  expect(tokenFromQuery("")).toBe("");
  expect(tokenFromQuery("?x=1")).toBe("");
});

test("resolveToken：URL 有 ?k= → 返回它并写进 storage（覆盖旧值）", () => {
  const s = fakeStorage({ [TOKEN_STORAGE_KEY]: "OLD" });
  expect(resolveToken("?k=NEW", s)).toBe("NEW");
  expect(s._map.get(TOKEN_STORAGE_KEY)).toBe("NEW"); // 新链接覆盖旧 token
});

test("resolveToken：URL 无 ?k= 但 storage 有 → 回退到 storage（返回首页/刷新/主屏重开场景）", () => {
  const s = fakeStorage({ [TOKEN_STORAGE_KEY]: "SAVED" });
  expect(resolveToken("", s)).toBe("SAVED");
  expect(resolveToken("?x=1", s)).toBe("SAVED");
});

test("resolveToken：URL 无、storage 无 → 空串", () => {
  expect(resolveToken("", fakeStorage())).toBe("");
});

test("resolveToken：storage 不可用（隐私模式）也不崩", () => {
  // setItem 抛错：URL 有 token 仍照常返回（只是没存住）
  expect(resolveToken("?k=NEW", fakeStorage({}, new Set(["set"])))).toBe("NEW");
  // getItem 抛错：URL 无 token 时降级为空串，不抛
  expect(resolveToken("", fakeStorage({}, new Set(["get"])))).toBe("");
  // storage 为 null/undefined 也不崩
  expect(resolveToken("?k=NEW", null)).toBe("NEW");
  expect(resolveToken("", undefined)).toBe("");
});

test("clearStoredToken：删掉本机 token；storage 不可用也不崩", () => {
  const s = fakeStorage({ [TOKEN_STORAGE_KEY]: "X" });
  clearStoredToken(s);
  expect(s._map.has(TOKEN_STORAGE_KEY)).toBe(false);
  expect(() => clearStoredToken(fakeStorage({}, new Set(["remove"])))).not.toThrow();
  expect(() => clearStoredToken(null)).not.toThrow();
});

test("describeVerify：有效回显邮箱并授权；无效给提示且不授权", () => {
  const ok = describeVerify({ ok: true, email: "b***@x.com" });
  expect(ok.authorized).toBe(true);
  expect(ok.email).toBe("b***@x.com");
  const no = describeVerify({ ok: false });
  expect(no.authorized).toBe(false);
  expect(no.text).toContain("专属链接");
});

test("describeResult: ok=true 给成功文案", () => {
  expect(describeResult({ ok: true }).kind).toBe("success");
});

test("describeResult: 已知错误码给对应中文", () => {
  expect(describeResult({ ok: false, error: "unauthorized" }).text).toContain("专属链接");
  expect(describeResult({ ok: false, error: "email_rate_limited" }).text).toContain("提交太多");
});

test("describeResult: 未知错误给兜底文案", () => {
  expect(describeResult({ ok: false, error: "weird" }).kind).toBe("error");
  expect(describeResult(null).kind).toBe("error");
});

test("escapeHtml 转义 & < > 与双引号", () => {
  expect(escapeHtml(`<a href="x">&`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
  expect(escapeHtml(null)).toBe("");
});

test("renderSearchResultsHTML 转义 title 与 url（防 DOM-XSS），excerpt 原样保留", () => {
  const html = renderSearchResultsHTML([
    { url: `x" onmouseover="alert(1)`, meta: { title: `<img src=x onerror=alert(1)>` }, excerpt: "命中<mark>片段</mark>" },
  ]);
  expect(html).not.toContain("<img src=x");                  // title 里的标签被转义
  expect(html).toContain("&lt;img src=x");
  expect(html).toContain(`href="x&quot; onmouseover=&quot;alert(1)"`); // url 引号被转义，无法逃逸属性
  expect(html).not.toContain(`href="x" onmouseover="alert(1)"`);       // 原始可执行形态不存在
  expect(html).toContain("命中<mark>片段</mark>");           // excerpt（Pagefind 高亮）原样保留
});

test("renderSearchResultsHTML 空标题回退「(无标题)」", () => {
  const html = renderSearchResultsHTML([{ url: "u", meta: { title: "" }, excerpt: "" }]);
  expect(html).toContain("(无标题)");
});

test("describeExistingReport：含标题/天数/链接；无命中给空串", () => {
  expect(describeExistingReport(null)).toBe("");
  expect(describeExistingReport({})).toBe("");
  const h = describeExistingReport({
    entry: { title: "芯原股份（688521.SH）", href: "r/2026-06-08_verisilicon-688521/" },
    ageDays: 2, matchedBy: "name",
  });
  expect(h).toContain("2 天内已调研过");
  expect(h).toContain("芯原股份（688521.SH）");
  expect(h).toContain('href="r/2026-06-08_verisilicon-688521/"');
  expect(h).toContain("点此查看报告");
});

test("describeExistingReport：0 天显示『今天刚调研过』", () => {
  const h = describeExistingReport({ entry: { title: "X", href: "r/x/" }, ageDays: 0 });
  expect(h).toContain("今天刚调研过");
});

test("describeExistingReport：title/href 转义防 DOM-XSS", () => {
  const h = describeExistingReport({
    entry: { title: `<img src=x onerror=alert(1)>`, href: `r/" onmouseover="alert(1)` },
    ageDays: 1,
  });
  expect(h).not.toContain("<img src=x");
  expect(h).toContain("&lt;img src=x");
  expect(h).not.toContain(`href="r/" onmouseover="alert(1)"`); // 引号被转义，无法逃逸属性
});
