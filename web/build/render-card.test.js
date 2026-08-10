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

test("卡片含标题、链接、筛选用 data 属性、右侧日期与来源数", () => {
  const html = renderCard(ENTRY);
  expect(html).toContain('href="r/2026-06-03_cpo/"');
  expect(html).toContain("CPO / 硅光产业链");
  expect(html).toContain('data-type="板块"');
  expect(html).toContain('<span class="date-side">06·03 · 14 源</span>');
});

test("高密度结构：标题行（title-row）+ 导语，无独立 meta 行与类型徽章", () => {
  const html = renderCard(ENTRY);
  expect(html).toContain('class="title-row"');
  expect(html).toContain('class="card-title"');
  expect(html).toContain('class="lead"');
  expect(html).not.toContain('class="ctype"');
  expect(html).not.toContain('class="card-meta"');
});

test("非股票类型：标题前缀小字标注类型", () => {
  const html = renderCard(ENTRY);
  expect(html).toContain('<span class="tprefix">板块 · </span>CPO / 硅光产业链');
});

test("股票卡：标题清洗成 名称 + 灰色代码，套话后缀不进卡片", () => {
  const html = renderCard(STOCK);
  expect(html).toContain('国瓷材料 <span class="code">300285.SZ</span>');
  expect(html).not.toContain("走势判断");
  expect(html).not.toContain('class="tprefix"'); // 股票不挂类型前缀，代码即身份
});

test("股票卡：方向标记 + 导语剥掉开头套话句", () => {
  const html = renderCard(STOCK);
  expect(html).toContain('<span class="dir down">↘ 偏弱</span>');
  expect(html).toContain("政策题材已被完整买涨又卖光");
  expect(html).not.toContain("未来约 13 周方向偏弱"); // 套话句已剥掉
});

test("股票卡：提取不到方向时无 dir 标记、导语原样", () => {
  const t = "阳光电源做两件事：光伏逆变器 + 储能系统，收入九成来自这两块。";
  const html = renderCard({ ...STOCK, title: "阳光电源 300274.SZ · 深度调研", tldr: t });
  expect(html).not.toContain('class="dir');
  expect(html).toContain("阳光电源做两件事");
});

test("股票卡：标题解析不出代码时回退到类型前缀 + 原样标题", () => {
  const html = renderCard({ ...STOCK, title: "某未上市主体调研", tldr: "" });
  expect(html).toContain('<span class="tprefix">股票 · </span>某未上市主体调研');
});

test("非股票导语剥「一句话：」引子；转义仍生效", () => {
  const html = renderCard(ENTRY);
  expect(html).toContain("结论 &lt;带尖括号&gt;");
  expect(html).not.toContain("一句话：");
  expect(escapeHtml("<a>")).toBe("&lt;a&gt;");
});

test("卡片不展示板块信息（2026-07-14 起首页板块信息整体下线）", () => {
  const html = renderCard({ ...ENTRY, boards: ["光模块", "算力"] });
  expect(html).not.toContain("光模块");
  expect(html).not.toContain("data-boards");
});

test("无导语且无方向时不渲染 lead；来源数为 0 时日期不带来源", () => {
  const html = renderCard({ ...ENTRY, tldr: "", sourceCount: 0 });
  expect(html).not.toContain('class="lead"');
  expect(html).toContain('<span class="date-side">06·03</span>');
});

test("sourceCount 也走转义：即便上游漏拦，标记也不会进 HTML", () => {
  const html = renderCard({
    dir: "2026-06-01_x", date: "2026-06-01", type: "概念", title: "T", tldr: "",
    sourceCount: '<img src=x onerror=alert(1)>', href: "r/2026-06-01_x/",
  });
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
});

// ── 同一标的多份报告的角标（方案 C）────────────────────────────────
const SERIES_BASE = { title: "胜宏科技（300476.SZ）", type: "股票", date: "2026-07-26", href: "r/new/", tldr: "偏震荡，前次判断已兑现" };

test("系列里较新的一篇：标题行出「第 N 次 · X 天后」", () => {
  const html = renderCard({ ...SERIES_BASE, series: { index: 2, total: 2, daysSincePrev: 48, newerHref: null } });
  expect(html).toContain('<span class="series-badge">第 2 次<span class="series-gap"> · 48 天后</span></span>');
  // 角标是标题行的独立 flex 项，不能落进 .card-title——后者 nowrap+省略号，窄屏会把它截没
  expect(html).not.toMatch(/<h2 class="card-title">[^<]*<span class="series-badge"/);
  expect(html).not.toContain("series-newer");     // 最新那篇不出「已有更新版」
  expect(html).not.toContain("is-superseded");
});

test("系列里较旧的一篇：卡片压暗 + 出「已有更新版 →」，且该链接在 card-link 之外", () => {
  const html = renderCard({ ...SERIES_BASE, date: "2026-06-08", href: "r/old/", series: { index: 1, total: 2, daysSincePrev: null, newerHref: "r/new/" } });
  expect(html).toContain('class="article-card is-superseded"');
  expect(html).toContain('<a class="series-newer" href="r/new/">已有更新版 →</a>');
  // <a> 套 <a> 会被浏览器拆开导致链接失效：更新版链接必须出现在 card-link 闭合之后
  expect(html.indexOf("series-newer")).toBeGreaterThan(html.indexOf("</a>"));
  expect(html).not.toContain("series-badge");     // 最早那篇不挂「第 1 次」
});

test("非系列报告：两种角标都不出，卡片 HTML 与原先一致", () => {
  const html = renderCard(SERIES_BASE);
  expect(html).not.toContain("series-badge");
  expect(html).not.toContain("series-newer");
  expect(html).not.toContain("is-superseded");
});
