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
