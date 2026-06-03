import { test, expect } from "bun:test";
import { injectReportNav } from "./inject-report-nav.js";

const BASE = `<!doctype html><html><head></head><body><h1>正文</h1></body></html>`;

test("在 </body> 前注入「回到顶部」+「返回档案」两个浮动按钮", () => {
  const out = injectReportNav(BASE);
  expect(out).toContain('class="sx-nav-btn sx-top"');
  expect(out).toContain('class="sx-nav-btn sx-home"');
  expect(out).toContain('aria-label="回到顶部"');
  expect(out).toContain("返回");
  // 注入位置在 </body> 之前
  expect(out.indexOf("sx-home")).toBeLessThan(out.indexOf("</body>"));
  // 原正文保留
  expect(out).toContain("<h1>正文</h1>");
});

test("默认「返回档案」指向站点根 index（report 在 /r/<dir>/ 下，故上两级）", () => {
  expect(injectReportNav(BASE)).toContain('href="../../index.html"');
});

test("homeHref 可自定义", () => {
  expect(injectReportNav(BASE, { homeHref: "/searchX/" })).toContain('href="/searchX/"');
});

test("大小写不敏感地匹配 </BODY>", () => {
  const out = injectReportNav("<html><body>x</BODY></html>");
  expect(out).toContain("sx-home");
  expect(out).toContain("x");
});

test("没有 </body> 时追加到末尾且不丢原内容", () => {
  const out = injectReportNav("<h1>hi</h1>");
  expect(out).toContain("sx-home");
  expect(out).toContain("<h1>hi</h1>");
});

test("只注入一次（单个 </body>）", () => {
  const out = injectReportNav(BASE);
  expect(out.split("sx-nav-btn sx-home").length - 1).toBe(1);
});
