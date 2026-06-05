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

test("在 <head> 注入站点 favicon（默认上两级到 /assets）", () => {
  const out = injectReportNav(BASE);
  expect(out).toContain('<link rel="icon" type="image/png" href="../../assets/favicon.png">');
  // favicon 落在 <head> 内
  expect(out.indexOf("favicon.png")).toBeLessThan(out.indexOf("</head>"));
});

test("faviconHref 可自定义", () => {
  expect(injectReportNav(BASE, { faviconHref: "/assets/favicon.png" }))
    .toContain('href="/assets/favicon.png"');
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

test("把存量报告的旧 viewport 改写成「禁移动端触摸缩放」（防误放大）", () => {
  const old = `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>x</body></html>`;
  const out = injectReportNav(old);
  expect(out).toContain("maximum-scale=1");
  expect(out).toContain("user-scalable=no");
  // 旧的无约束 viewport 不再残留
  expect(out).not.toContain('content="width=device-width, initial-scale=1"');
  // 只剩一个 viewport meta（改写而非追加）
  expect(out.match(/name=["']viewport["']/g).length).toBe(1);
});

test("报告缺 viewport 时补一个锁定的（落在 <head> 内）", () => {
  const out = injectReportNav(BASE);
  expect(out).toContain("user-scalable=no");
  expect(out.indexOf("user-scalable=no")).toBeLessThan(out.indexOf("</head>"));
});

test("注入 touch-action:manipulation，移动端禁双击放大", () => {
  expect(injectReportNav(BASE)).toContain("touch-action:manipulation");
});
