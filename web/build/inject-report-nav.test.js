import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
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

test("锁横向滚动：注入 overflow-x:hidden，手机端报告页不能左右拖动", () => {
  const out = injectReportNav(BASE);
  expect(out).toContain("overflow-x:hidden");
  // 宽内容自适应规则也一并补上，避免表格/图片撑出横向滚动
  expect(out).toContain("img,video,iframe{max-width:100%; height:auto}");
  expect(out).toContain("overflow-wrap:break-word");
});

test("表格：整页锁横滑，但表格自身可左右拖动；列给最小宽不被压成竖排逐字；首列冻结", () => {
  const out = injectReportNav(BASE);
  // 表格自身是横向滚动容器（与整页 overflow-x:hidden 互补：只有表能横拖）
  expect(out).toContain("table{display:block");
  expect(out).toContain("overflow-x:auto");
  // 列有最小宽度——中文不再被挤成一列竖排逐字
  expect(out).toMatch(/min-width:\s*5em/);
  // 首列冻结：横向拖动看后面列时，行名/字段名始终可见
  expect(out).toContain("position:sticky; left:0");
});

test("注入顶部阅读进度条", () => {
  const out = injectReportNav(BASE);
  expect(out).toContain('class="sx-progress"');
  expect(out).toContain('aria-hidden="true"');
});

test("浮动按钮贴正文列：right 用 --measure 计算而非死贴 20px", () => {
  const out = injectReportNav(BASE);
  expect(out).toContain("(100vw - var(--measure)) / 2 - 56px");
});

test("进度条脚本按文档滚动比例更新宽度", () => {
  const out = injectReportNav(BASE);
  expect(out).toContain("scrollHeight");
  expect(out).toContain("sx-progress");
});

test("自动目录骨架：电脑侧栏 + 手机浮层 + 目录按钮", () => {
  const out = injectReportNav(BASE);
  expect(out).toContain('class="sx-toc"');
  expect(out).toContain('class="sx-nav-btn sx-toc-btn"');
  expect(out).toContain('class="sx-toc-sheet"');
  expect(out).toContain('aria-label="目录"');
});

test("目录浮层防滑动穿透：面板/遮罩加 overscroll-behavior:contain，且打开时锁整页滚动", () => {
  const out = injectReportNav(BASE);
  // 面板内部滚动不外漏 + 遮罩吞手势（touch-action:none）/面板可纵向滚（pan-y）
  expect(out).toContain("overscroll-behavior:contain");
  expect(out).toContain("touch-action:none");
  expect(out).toContain("touch-action:pan-y");
  // 浮层打开时锁住整页滚动：html/body 一起锁，脚本里切换 sx-toc-open 类
  expect(out).toContain("html.sx-toc-open,body.sx-toc-open{overflow:hidden}");
  expect(out).toContain('document.documentElement.classList.toggle("sx-toc-open"');
  expect(out).toContain('document.body.classList.toggle("sx-toc-open"');
});

test("目录脚本按固定区块顺序 + 正文 h2 扫描", () => {
  const out = injectReportNav(BASE);
  expect(out).toContain("核心结论");
  expect(out).toContain("关键发现");
  expect(out).toContain("来源清单");
  expect(out).toContain("main h2");
});

test("窄屏阈值：电脑侧栏宽屏才显示", () => {
  expect(injectReportNav(BASE)).toContain("@media (min-width:1100px)");
});

// CSP：防存储型 XSS。只放行本文件注入的那段导航脚本（按哈希白名单），
// 其它任何内联脚本被挡；script-src 绝不含 unsafe-inline。
test("往 <head> 注入 CSP meta", () => {
  const out = injectReportNav(BASE);
  expect(out).toContain('http-equiv="Content-Security-Policy"');
  expect(out).toContain("default-src 'none'");
  expect(out).toContain("script-src 'sha256-");
  // CSP 落在 <head> 内
  expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf("</head>"));
});

test("CSP 的 sha256 与被注入脚本文本一致", () => {
  const out = injectReportNav(BASE);
  // 取出注入的那段 <script>...</script> 内容
  const m = out.match(/<script>([\s\S]*?)<\/script>/);
  expect(m).not.toBeNull();
  const want = createHash("sha256").update(m[1]).digest("base64");
  expect(out).toContain(`'sha256-${want}'`);
});

test("script-src 不含 unsafe-inline（其它内联脚本会被挡）", () => {
  const out = injectReportNav(BASE);
  const csp = out.match(/content="(default-src[^"]*)"/);
  expect(csp).not.toBeNull();
  const scriptSrc = csp[1].split(";").find((d) => d.trim().startsWith("script-src"));
  expect(scriptSrc).toBeDefined();
  expect(scriptSrc).not.toContain("unsafe-inline");
});

test("CSP 允许内联 <style> 与外部链接：style-src unsafe-inline、img/font 放开", () => {
  const out = injectReportNav(BASE);
  expect(out).toContain("style-src 'unsafe-inline'");
  expect(out).toContain("img-src 'self' data: https:");
  expect(out).toContain("base-uri 'none'");
  expect(out).toContain("form-action 'none'");
});

// F7：正文里出现字面 </body> / viewport 标签时，注入仍要落到真正的文档末尾 / 头部。
test("正文含字面 </body> 时，导航仍注入到真正的文档末尾", () => {
  const html = `<html><head></head><body><pre>示例代码：</body> 字样</pre></body></html>`;
  const out = injectReportNav(html);
  // 只注入一次
  expect(out.split("sx-nav-btn sx-home").length - 1).toBe(1);
  // 导航必须落在最后一个 </body> 之前（真正文末），而不是正文里那个字面标签处
  const firstBody = out.indexOf("</body>");
  const lastBody = out.lastIndexOf("</body>");
  expect(lastBody).toBeGreaterThan(firstBody); // 确实有两个 </body>
  // 不能注在第一个（正文里的）之前——那会插进代码块、把示例标签当成真文末
  expect(out.indexOf("sx-home")).toBeGreaterThan(firstBody);
  expect(out.indexOf("sx-home")).toBeLessThan(lastBody);
});

test("正文含字面 </head> 时，favicon/CSP 仍注入到真正的文档头部末尾", () => {
  const html = `<html><head><title>x</title></head><body><pre>文中写了 </head> 字样</pre></body></html>`;
  const out = injectReportNav(html);
  // favicon 只注入一次，落在真正的 </head>（第一个，即头部）之前
  expect(out.split("favicon.png").length - 1).toBe(1);
  const headEnd = out.indexOf("</head>");
  expect(out.indexOf("favicon.png")).toBeLessThan(headEnd);
});
