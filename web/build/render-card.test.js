import { test, expect } from "bun:test";
import { renderCard, escapeHtml } from "./render-card.js";

const ENTRY = {
  dir: "2026-06-03_cpo",
  date: "2026-06-03",
  slug: "cpo",
  type: "板块",
  title: "CPO / 硅光产业链",
  tldr: "一句话结论 <带尖括号>",
  tags: ["CPO"],
  sourceCount: 14,
  href: "r/2026-06-03_cpo/",
};

const STOCK = {
  dir: "2026-07-13_guoci",
  date: "2026-07-13",
  slug: "guoci",
  type: "股票",
  title: "国瓷材料（300285.SZ）— 未来约 13 周走势判断",
  tldr: "未来约 13 周方向偏弱、震荡偏跌，置信度中。政策题材已被完整买涨又卖光、主力资金逐日净流出。",
  sourceCount: 24,
  href: "r/2026-07-13_guoci/",
};

test("条目含链接、筛选用 data 属性、编号占位与文字行", () => {
  const html = renderCard(ENTRY);
  expect(html).toContain('href="r/2026-06-03_cpo/"');
  expect(html).toContain("CPO / 硅光产业链");
  expect(html).toContain('data-type="板块"');
  expect(html).toContain('class="num"');   // 编号本体由 CSS 计数器画，筛选后自动重排
  expect(html).toContain('class="eline"');
});

test("简报式结构（2026-08-26 晚改版）：加粗段 + 行尾标注，无旧版卡片结构", () => {
  const html = renderCard(ENTRY);
  expect(html).toContain('class="ehead"');
  expect(html).not.toContain('class="card-title"');
  expect(html).not.toContain('class="card-meta"');
  expect(html).not.toContain('class="lead"');
});

test("非股票：行尾出彩色类型字；导语切不出短句时只加粗标题", () => {
  const html = renderCard(ENTRY);
  // tldr「一句话结论 <带尖括号>」无标点可切 → 加粗段=标题，导语接在「：」后
  expect(html).toContain('<span class="ehead">CPO / 硅光产业链</span>：一句话结论 &lt;带尖括号&gt;');
  expect(html).toContain('<span class="tprefix">板块</span>');
});

test("股票条目：标题清洗成名称并与导语首句合成加粗段，套话后缀不进条目", () => {
  const html = renderCard(STOCK);
  expect(html).toContain('<span class="ehead">国瓷材料：政策题材已被完整买涨又卖光、主力资金逐日净流出</span>');
  expect(html).toContain('<span class="code">300285.SZ</span>');
  expect(html).not.toContain("走势判断");
  expect(html).not.toContain('class="tprefix"'); // 股票不挂类型字，方向标即身份
});

test("股票条目：方向标 + 导语剥掉开头套话句", () => {
  const html = renderCard(STOCK);
  expect(html).toContain('<span class="dir down">↘ 偏弱</span>');
  expect(html).not.toContain("未来约 13 周方向偏弱"); // 套话句已剥掉
});

test("股票条目：提取不到方向时无 dir 标记、导语原样进加粗段", () => {
  const t = "阳光电源做两件事：光伏逆变器 + 储能系统，收入九成来自这两块。";
  const html = renderCard({ ...STOCK, title: "阳光电源 300274.SZ · 深度调研", tldr: t });
  expect(html).not.toContain('class="dir');
  expect(html).toContain('<span class="ehead">阳光电源：阳光电源做两件事</span>');
});

test("股票条目：标题解析不出代码时回退到原样标题 + 类型字缺省不出（仍是股票）", () => {
  const html = renderCard({ ...STOCK, title: "某未上市主体调研", tldr: "" });
  expect(html).toContain("某未上市主体调研");
  expect(html).not.toContain('class="code"');
});

test("非股票导语剥「一句话：」引子；转义仍生效", () => {
  const html = renderCard({ ...ENTRY, tldr: "一句话：概念成立，但边界要看清。" });
  expect(html).not.toContain("一句话：概念");
  expect(html).toContain('<span class="ehead">CPO / 硅光产业链：概念成立</span>');
  expect(escapeHtml("<a>")).toBe("&lt;a&gt;");
});

test("条目不展示板块信息（首页板块信息 2026-07-14 起整体下线）", () => {
  const html = renderCard({ ...ENTRY, boards: ["光模块", "算力"] });
  expect(html).not.toContain("光模块");
  expect(html).not.toContain("data-boards");
});

test("无导语时只加粗名称，行内不残留孤立冒号", () => {
  const html = renderCard({ ...ENTRY, tldr: "" });
  expect(html).toContain('<span class="ehead">CPO / 硅光产业链</span>');
  expect(html).not.toContain("</span>：<");
});

// ── 同一标的多份报告的角标（方案 C）────────────────────────────────
const SERIES_BASE = { title: "胜宏科技（300476.SZ）", type: "股票", date: "2026-07-26", href: "r/new/", tldr: "偏震荡，前次判断已兑现" };

test("系列里较新的一篇：行尾出「第 N 次 · X 天后」", () => {
  const html = renderCard({ ...SERIES_BASE, series: { index: 2, total: 2, daysSincePrev: 48, newerHref: null } });
  expect(html).toContain('<span class="series-badge">第 2 次<span class="series-gap"> · 48 天后</span></span>');
  expect(html).not.toContain("series-newer");     // 最新那篇不出「已有更新版」
  expect(html).not.toContain("is-superseded");
});

test("系列里较旧的一篇：条目压暗 + 出「已有更新版 →」，且该链接在 .entry 之外", () => {
  const html = renderCard({ ...SERIES_BASE, date: "2026-06-08", href: "r/old/", series: { index: 1, total: 2, daysSincePrev: null, newerHref: "r/new/" } });
  expect(html).toContain('class="article-card is-superseded"');
  expect(html).toContain('<a class="series-newer" href="r/new/">已有更新版 →</a>');
  // <a> 套 <a> 会被浏览器拆开导致链接失效：更新版链接必须出现在 .entry 闭合之后
  expect(html.indexOf("series-newer")).toBeGreaterThan(html.indexOf("</a>"));
  expect(html).not.toContain("series-badge");     // 最早那篇不挂「第 1 次」
});

test("非系列报告：两种角标都不出", () => {
  const html = renderCard(SERIES_BASE);
  expect(html).not.toContain("series-badge");
  expect(html).not.toContain("series-newer");
  expect(html).not.toContain("is-superseded");
});
