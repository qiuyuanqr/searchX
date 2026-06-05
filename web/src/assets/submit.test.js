import { test, expect } from "bun:test";
import { buildPayload, describeResult, escapeHtml, renderSearchResultsHTML } from "./submit.js";

test("buildPayload 去空白并带上 turnstile token", () => {
  const p = buildPayload(
    { title: "  比特币挖矿  ", focus: " 能耗 ", email: " a@b.com ", message: "" },
    "TKN"
  );
  expect(p).toEqual({
    title: "比特币挖矿",
    focus: "能耗",
    email: "a@b.com",
    message: "",
    turnstile: "TKN",
  });
});

test("describeResult: ok=true 给成功文案", () => {
  expect(describeResult({ ok: true }).kind).toBe("success");
});

test("describeResult: 已知错误码给对应中文", () => {
  expect(describeResult({ ok: false, error: "turnstile_failed" }).text).toContain("人机验证");
  expect(describeResult({ ok: false, error: "email_rate_limited" }).text).toContain("邮箱");
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
