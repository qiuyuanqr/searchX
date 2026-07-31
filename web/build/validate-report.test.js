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

// audit-2026-07-04 [17]：属性值里带 > 会让 [^>]* 提前截断，onerror= 落在检测范围外、零缺陷。
test("属性值里带 > 也拦得住内联事件处理器（不再被提前截断漏检）", () => {
  const d = findReportDefects(`<img alt="a>b" onerror=alert(1)>`);
  expect(d.length).toBeGreaterThan(0);
  expect(d.join()).toContain("onerror");
});

test("单引号属性值里带 > 同样拦得住", () => {
  const d = findReportDefects(`<img alt='a>b' onerror=alert(1)>`);
  expect(d.length).toBeGreaterThan(0);
  expect(d.join()).toContain("onerror");
});

// audit-2026-07-04 [17]：class 正则只认双引号，单引号写法（class='src-tag src-typo'）会漏检。
test("单引号写法的非法来源标签配色类也被发现", () => {
  const d = findReportDefects(`<span class='src-tag src-typo'>x</span>`);
  expect(d.length).toBe(1);
  expect(d[0]).toContain("src-typo");
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

// ── 检测绕过（2026-07-31 审查）───────────────────────────────────
// on<词> 前的属性分隔符不止空白：`/` 和「剥掉引号内容后留下的引号残壳」都是合法边界。
test("内联事件处理器：用 / 或引号紧贴当分隔符也被检出", () => {
  expect(findReportDefects('<svg/onload=alert(1)>').join()).toContain("onload");
  expect(findReportDefects('<img alt="x"onerror=alert(1)>').join()).toContain("onerror");
});

test("meta refresh 整页跳转被检出（CSP 没有指令能挡它）", () => {
  expect(findReportDefects('<meta http-equiv="refresh" content="0;url=https://evil.example">').join())
    .toContain("refresh");
});

// 反向：正文里出现「javascript:」这个词是完全正常的（报告聊前端、聊 XSS 就会写到），
// 老实现的裸 /javascript:/i 会让整次站点构建抛错、全站停止发布。
test("正文里作为普通文字出现的 javascript: 不算缺陷（不再击穿整站构建）", () => {
  expect(findReportDefects("<p>老式写法会把 javascript: 协议写进链接，这是反面教材。</p>")).toEqual([]);
});

test("javascript: 出现在链接属性里仍算缺陷", () => {
  expect(findReportDefects('<a href="javascript:alert(1)">点我</a>').join()).toContain("javascript:");
  expect(findReportDefects("<a href='javascript:alert(1)'>点我</a>").join()).toContain("javascript:");
});
