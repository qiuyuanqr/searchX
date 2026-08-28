import { test, expect } from "bun:test";
import { renderIndex } from "./render-index.js";

const TPL = `<ul class="article-list"><!-- CARDS --></ul>`;
const mk = (date, title, extra = {}) => ({
  dir: `${date}_x`, date, slug: "x", type: "概念", title,
  tldr: "t", tags: [], boards: [], sourceCount: 1, href: `r/${date}_x/`, ...extra,
});

test("把条目注入占位符，保留顺序", () => {
  const html = renderIndex([mk("2026-06-02", "B 标题"), mk("2026-06-01", "A 标题")], TPL);
  expect(html).not.toContain("<!-- CARDS -->");
  expect(html.indexOf("B 标题")).toBeLessThan(html.indexOf("A 标题"));
});

test("简报式分组（2026-08-26 晚改版）：一天一张卡，同日条目并入同卡", () => {
  const html = renderIndex([mk("2026-06-24", "甲"), mk("2026-06-24", "乙"), mk("2026-06-20", "丙")], TPL);
  expect(html.match(/class="day-card"/g).length).toBe(2);
  expect(html).toContain('data-date="2026-06-24"');
  expect(html).toContain('<span class="day-date">2026 年 6 月 24 日</span>');
  // 甲乙同卡：两者之间不再出现新的卡头
  const seg = html.slice(html.indexOf("甲"), html.indexOf("乙"));
  expect(seg).not.toContain("day-head");
  expect(html).not.toContain("month-sep"); // 月分隔已被天卡替代
});

test("卡头合计：N 篇调研 · 来源总数；来源缺失或为脏数据时只计能解析的", () => {
  const html = renderIndex([
    mk("2026-06-24", "甲", { sourceCount: 14 }),
    mk("2026-06-24", "乙", { sourceCount: "<img src=x>" }),   // 脏数据不入合计、也不进 HTML
    mk("2026-06-24", "丙", { sourceCount: 0 }),
  ], TPL);
  expect(html).toContain('<span class="day-meta">3 篇调研 · 14 个来源</span>');
  expect(html).not.toContain("<img");
});

test("来源合计为 0 时卡头只说篇数", () => {
  const html = renderIndex([mk("2026-06-24", "甲", { sourceCount: 0 })], TPL);
  expect(html).toContain('<span class="day-meta">1 篇调研</span>');
});

test("空列表不产天卡", () => {
  const html = renderIndex([], TPL);
  expect(html).not.toContain("day-card");
});

test("chips 按数据生成：带条数、按条数降序、空类型不出现、全部在最前且激活", () => {
  const tpl = `<div class="chips" id="chips-type" data-group="type"><!-- CHIPS --></div><ul><!-- CARDS --></ul>`;
  const entries = [
    { ...mk("2026-06-03", "甲"), type: "股票" },
    { ...mk("2026-06-02", "乙"), type: "股票" },
    { ...mk("2026-06-01", "丙"), type: "概念" },
  ];
  const html = renderIndex(entries, tpl);
  expect(html).not.toContain("<!-- CHIPS -->");
  expect(html).toContain('data-filter="all" role="button" tabindex="0" aria-pressed="true">全部 <span class="n">3</span>');
  expect(html).toContain('data-filter="type:股票" role="button" tabindex="0" aria-pressed="false">股票 <span class="n">2</span>');
  expect(html).toContain('data-filter="type:概念" role="button" tabindex="0" aria-pressed="false">概念 <span class="n">1</span>');
  expect(html).not.toContain("type:人物"); // 没有的类型不出 chip
  expect(html.indexOf("type:股票")).toBeLessThan(html.indexOf("type:概念")); // 条数降序
  expect(html.indexOf('data-filter="all"')).toBeLessThan(html.indexOf("type:股票"));
});

test("模板没有 CHIPS 占位符时不受影响（向后兼容）", () => {
  const html = renderIndex([mk("2026-06-01", "甲")], TPL);
  expect(html).toContain("甲");
});

test("条目内容含 $' / $& 等替换模式序列时模板不被损坏（函数形式替换不解释 $）", () => {
  const entries = [{
    dir: "2026-06-01_x", date: "2026-06-01", type: "概念",
    title: "美元符标题 $' $& $`", tldr: "导语里也有 $' 序列", tags: [], sourceCount: 1, href: "r/2026-06-01_x/",
  }];
  const html = renderIndex(entries, TPL);
  // 模板尾部只出现一次（$ 序列被当作字面量，未复制模板片段）
  expect(html.match(/<\/ul>/g).length).toBe(1);
  expect(html).toContain("美元符标题");
});

// ── 2026-08-28：旧报告（已有更新版）不再出条目 ─────────────────────
test("旧篇不出条目：整天全是旧篇时天卡不出；计数与 chips 只算展示条目", () => {
  const stale = { series: { index: 1, total: 2, daysSincePrev: null, newerHref: "r/new/", latestHref: "r/new/", latestDate: "2026-06-24" } };
  const tplWithChips = `<div class="chips"><!-- CHIPS --></div><ul><!-- CARDS --></ul>`;
  const html = renderIndex([
    mk("2026-06-24", "最新篇", { series: { index: 2, total: 2, daysSincePrev: 4, newerHref: null, history: [{ date: "2026-06-20", href: "r/2026-06-20_x/" }] } }),
    mk("2026-06-20", "旧篇标题", stale),
  ], tplWithChips);
  expect(html).not.toContain("旧篇标题");
  expect(html.match(/class="day-card"/g).length).toBe(1);          // 06-20 那天整卡不出
  expect(html).toContain('>全部 <span class="n">1</span>');         // chips 不数旧篇
  expect(html).toContain("1 篇调研");
  expect(html).toContain("历史调研");                                // 历史入口在最新条目下
});
