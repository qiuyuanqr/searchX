import { test, expect } from "bun:test";
import { renderIndex } from "./render-index.js";

const TPL = `<ul class="article-list"><!-- CARDS --></ul>`;
const mk = (date, title) => ({
  dir: `${date}_x`, date, slug: "x", type: "概念", title,
  tldr: "t", tags: [], boards: [], sourceCount: 1, href: `r/${date}_x/`,
});

test("把卡片注入占位符，保留顺序", () => {
  const html = renderIndex([mk("2026-06-02", "B 标题"), mk("2026-06-01", "A 标题")], TPL);
  expect(html).not.toContain("<!-- CARDS -->");
  expect(html.indexOf("B 标题")).toBeLessThan(html.indexOf("A 标题"));
});

test("跨月边界插入月分隔行，标签为「年 · 中文月」", () => {
  const html = renderIndex([mk("2026-06-24", "六月条目"), mk("2026-05-30", "五月条目")], TPL);
  expect(html).toContain('<li class="month-sep" data-month="2026-06">2026 · 六月</li>');
  expect(html).toContain('<li class="month-sep" data-month="2026-05">2026 · 五月</li>');
  // 分隔在对应卡片之前
  expect(html.indexOf("2026 · 六月")).toBeLessThan(html.indexOf("六月条目"));
  expect(html.indexOf("六月条目")).toBeLessThan(html.indexOf("2026 · 五月"));
});

test("同月多条只插一个分隔行", () => {
  const html = renderIndex([mk("2026-06-24", "甲"), mk("2026-06-20", "乙")], TPL);
  expect(html.match(/data-month="2026-06"/g).length).toBe(1);
});

test("空列表不产分隔行", () => {
  const html = renderIndex([], TPL);
  expect(html).not.toContain("month-sep");
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

test("卡片内容含 $' / $& 等替换模式序列时模板不被损坏（函数形式替换不解释 $）", () => {
  const entries = [{
    dir: "2026-06-01_x", date: "2026-06-01", type: "概念",
    title: "美元符文本 $' 与 $& 测试", tldr: "导语也带 $` 序列",
    boards: [], sourceCount: 3, href: "r/2026-06-01_x/",
  }];
  const template = "<ul>\n<!-- CARDS -->\n</ul><footer>尾部</footer>";
  const html = renderIndex(entries, template);
  expect(html).toContain("$' 与 $&");        // 字面保留
  expect(html.match(/<footer>/g).length).toBe(1); // 模板尾部没有被 $' 复制
  expect(html).toContain("$` 序列");
});
