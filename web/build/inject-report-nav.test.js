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

test("把存量报告的旧 viewport 统一改写成标准 viewport（改写而非追加）", () => {
  const old = `<html><head><meta name="viewport" content="width=device-width, initial-scale=2"></head><body>x</body></html>`;
  const out = injectReportNav(old);
  expect(out).toContain('content="width=device-width, initial-scale=1"');
  // 旧的非标准 viewport 不再残留
  expect(out).not.toContain('content="width=device-width, initial-scale=2"');
  // 只剩一个 viewport meta（改写而非追加）
  expect(out.match(/name=["']viewport["']/g).length).toBe(1);
});

// audit-2026-07-04 [20]/[7]：不锁 maximum-scale/user-scalable——双击误放大已由 body 的
// touch-action:manipulation 单独解决，禁缩放对低视力用户是纯损失（WCAG 1.4.4），且 iOS 本就
// 忽略这两个参数，唯一"生效"的是让遵守它的 Android Chrome 把放大功能锁死。
test("不锁 maximum-scale / user-scalable：低视力用户仍可在 Android Chrome 上放大", () => {
  const out = injectReportNav(BASE);
  expect(out).not.toContain("maximum-scale");
  expect(out).not.toContain("user-scalable");
});

test("报告缺 viewport 时补一个标准的（落在 <head> 内）", () => {
  const out = injectReportNav(BASE);
  expect(out).toContain('content="width=device-width, initial-scale=1"');
  expect(out.indexOf('name="viewport"')).toBeLessThan(out.indexOf("</head>"));
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

test("自动目录骨架：单一迷你横条栏（≡ 浮层已退役），所有宽度都显示", () => {
  const out = injectReportNav(BASE);
  expect(out).toContain('class="sx-toc"');
  expect(out).toContain('aria-label="目录"');
  expect(out).not.toContain("sx-toc-sheet");   // 手机浮层与 ≡ 按钮已被触摸滑选取代
  expect(out).not.toContain("sx-toc-btn");
});

test("鱼眼交互：鼠标移动/触摸滑动做阶梯放大，最近一条弹标题气泡", () => {
  const out = injectReportNav(BASE);
  expect(out).toContain("bindRail");
  expect(out).toContain("sx-rail-tip");
  expect(out).toContain("data-label");
  expect(out).toContain('addEventListener("mousemove"');
  expect(out).toContain('addEventListener("touchmove"');
  // 手指松开跳到最近那节；触摸取消要复位
  expect(out).toContain('addEventListener("touchend"');
  expect(out).toContain('addEventListener("touchcancel"');
});

test("触屏侧布局：窄屏/纯触控把栏移到右缘、气泡换左侧、滑动时不带动页面", () => {
  const out = injectReportNav(BASE);
  expect(out).toContain("@media (max-width:899px), (hover:none)");
  expect(out).toContain("touch-action:none");
  expect(out).toContain("right:6px");
});

test("排版换装：核心结论上移居中导读、节题拆字母编号、关键发现标签行、区块滚动淡入", () => {
  const out = injectReportNav(BASE);
  expect(out).toContain("insertBefore(tldrEl, plainEl)");   // tldr 搬到 plain 之前
  expect(out).toContain("sx-sec-letter");                    // A–M 节题的等宽字母编号
  expect(out).toContain(".findings li{background:rgba(180,84,58,.07)");
  expect(out).toContain("sx-reveal");                        // 滚动淡入（脚本不跑则全可见）
  expect(out).toContain("IntersectionObserver");
});

test("外部来源链接补 target=_blank + rel=noopener：点来源不离开报告页", () => {
  const out = injectReportNav(BASE);
  expect(out).toContain(`a[href^="http"]`);
  expect(out).toContain(`a.target = "_blank"`);
  expect(out).toContain(`a.rel = "noopener"`);
});

test("窄屏下滚阅读时藏浮动按钮、上滚再浮现：脚本切 body.sx-fab-hide + CSS 只在窄屏生效", () => {
  const out = injectReportNav(BASE);
  expect(out).toContain('classList.add("sx-fab-hide")');
  expect(out).toContain('classList.remove("sx-fab-hide")');
  // 隐藏规则包在窄屏媒体查询里，宽屏（按钮在页边留白、不压正文）不受影响
  expect(out).toContain("@media (max-width:900px){\n  body.sx-fab-hide .sx-nav-btn");
});

test("表格加 data-pagefind-ignore：裸数字表格不进全文索引、摘录不再是无意义数字串", () => {
  const html = `<html><head></head><body><table><tr><td>682 亿</td></tr></table><table class="x"><tr><td>1</td></tr></table></body></html>`;
  const out = injectReportNav(html);
  expect(out).toContain("<table data-pagefind-ignore><tr>");
  expect(out).toContain(`<table data-pagefind-ignore class="x">`);
});

test("表格已带 data-pagefind-ignore 时不重复加（幂等）", () => {
  const html = `<html><head></head><body><table data-pagefind-ignore><tr><td>1</td></tr></table></body></html>`;
  const out = injectReportNav(html);
  expect(out.match(/data-pagefind-ignore/g).length).toBe(1);
});

test("目录脚本按固定区块顺序 + 正文 h2 扫描", () => {
  const out = injectReportNav(BASE);
  expect(out).toContain("核心结论");
  expect(out).toContain("关键发现");
  expect(out).toContain("来源清单");
  expect(out).toContain("main h2");
});

test("迷你横条目录不再按宽度隐藏：基础态常显，窄屏/纯触控只是换到右缘", () => {
  const out = injectReportNav(BASE);
  expect(out).toContain("railHtml");
  expect(out).not.toContain("@media (min-width:900px) and (hover:hover)");  // 旧的显示门槛已撤
  expect(out).toContain(".sx-toc{position:fixed; top:0; bottom:0; display:flex");
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

// ── 缺 </head> 的报告也必须带 CSP（2026-07-31 审查）─────────────────
// 老实现遇到没有 </head> 的 report.html 直接跳过注入，那篇报告就以「无 CSP」状态
// 上线公开站主域——这道防线恰好在最异常的产物上失效。
test("report.html 缺 </head>：CSP 与 viewport 仍被注入（插在 <html> 之后）", () => {
  const out = injectReportNav("<html><body><main><h1>标题</h1></main></body></html>");
  expect(out).toContain("Content-Security-Policy");
  expect(out).toContain("script-src 'sha256-");
  expect(out).toContain('name="viewport"');
  expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf("<main>"));
});

test("连 <html> 都没有的碎片：CSP 插到文档最前面", () => {
  const out = injectReportNav("<main><h1>标题</h1></main>");
  expect(out.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
});

// ── 2026-08-26 站点改版：存量报告的配色统一覆盖段 ─────────────────
// 老报告的 <style> 里烧着旧纸感配色，靠注入段尾部的 :root 覆盖（含暗色）才与首页一致。
// 这段要是被误删，站上 100+ 篇存量报告会静默退回旧配色——用测试钉住。
test("注入段带新调色板覆盖（:root 亮/暗 + 组件圆角），且排在报告自身样式之后", () => {
  const html = "<html><head><style>:root{--seal:#a3361f}</style></head><body><p>x</p></body></html>";
  const out = injectReportNav(html);
  expect(out).toContain("--seal:#b4543a");        // 亮色主色 = 首页珊瑚橙
  expect(out).toContain("--seal:#d97e5c");        // 暗色主色
  expect(out).toContain(".case,.limitation,.correction{border-radius:12px}");
  // 覆盖段必须出现在报告自己的 <style> 之后（同特异性靠位置取胜）
  expect(out.indexOf("--seal:#b4543a")).toBeGreaterThan(out.indexOf("--seal:#a3361f"));
});

test("报头元信息整队：概念标签串拆成小胶囊行、来源短项归前", () => {
  const out = injectReportNav(BASE);
  expect(out).toContain("sx-tags");
  expect(out).toContain("sx-tag");
  expect(out).toContain('"概念标签" || k === "关联板块"');
  expect(out).toContain("header.masthead::after");   // 主色短色条挂报头、不再挂 tldr
  expect(out).not.toContain(".tldr::after");
});
