import { test, expect } from "bun:test";
import { findReportDefects } from "./validate-report.js";

test("干净报告无缺陷", () => {
  expect(findReportDefects(`<h1>标题</h1><span class="src-tag src-disc">披露</span>`)).toEqual([]);
});

test("残留未替换的 {{TOKEN}} 被发现", () => {
  const d = findReportDefects(`<h1>{{TITLE}}</h1>正文 {{SOURCES}}`);
  expect(d.length).toBe(2);
  expect(d.join()).toContain("{{TITLE}}");
  expect(d.join()).toContain("{{SOURCES}}");
});

test("非法来源标签配色类被发现", () => {
  const d = findReportDefects(`<span class="src-tag src-typo">x</span>`);
  expect(d.length).toBe(1);
  expect(d[0]).toContain("src-typo");
});

test("5 个合法来源配色类都通过", () => {
  const html = ["reg", "disc", "media", "research", "comm"]
    .map((c) => `<span class="src-tag src-${c}">x</span>`)
    .join("");
  expect(findReportDefects(html)).toEqual([]);
});

// 防存储型 XSS：report.html 由全权限 headless Claude 生成、原样上线公开站主域，
// 发布前在这里拦住脚本类内容（每类一正一反）。
test("含 <script 被判为缺陷（忽略大小写）", () => {
  expect(findReportDefects(`<p>x</p><script>alert(1)</script>`).length).toBeGreaterThan(0);
  expect(findReportDefects(`<P>x</P><SCRIPT>alert(1)</SCRIPT>`).length).toBeGreaterThan(0);
});

test("正文出现 content= 等以 on 结尾的属性名不误判为事件处理器", () => {
  // 真实报告大量出现 <meta ... content="...">；不能因为含 "ontent=" 被误伤
  expect(findReportDefects(`<meta name="x" content="y">`)).toEqual([]);
});

test("内联事件处理器 on*= 被判为缺陷", () => {
  expect(findReportDefects(`<img src=x onerror=alert(1)>`).length).toBeGreaterThan(0);
  expect(findReportDefects(`<div onclick="steal()">x</div>`).length).toBeGreaterThan(0);
});

test("javascript: 协议被判为缺陷", () => {
  expect(findReportDefects(`<a href="javascript:alert(1)">x</a>`).length).toBeGreaterThan(0);
});

test("普通外部链接（含正文）不触发 javascript: 误判", () => {
  expect(findReportDefects(`<a href="https://example.com/a">来源</a>`)).toEqual([]);
});

test("<iframe / <object / <embed 被判为缺陷", () => {
  expect(findReportDefects(`<iframe src="//evil"></iframe>`).length).toBeGreaterThan(0);
  expect(findReportDefects(`<object data="x"></object>`).length).toBeGreaterThan(0);
  expect(findReportDefects(`<embed src="x">`).length).toBeGreaterThan(0);
});

test("一篇只含内联 <style> + 外部 <a> 的干净报告无缺陷", () => {
  const html = `<head><style>body{color:red}</style></head>`
    + `<body><a href="https://sec.gov/x">监管</a></body>`;
  expect(findReportDefects(html)).toEqual([]);
});
