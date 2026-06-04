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
  boards: ["光模块", "算力"],
  sourceCount: 14,
  href: "r/2026-06-03_cpo/",
};

test("卡片含标题、类型、链接、筛选用 data 属性", () => {
  const html = renderCard(ENTRY);
  expect(html).toContain('href="r/2026-06-03_cpo/"');
  expect(html).toContain("CPO / 硅光产业链");
  expect(html).toContain('data-type="板块"');
  expect(html).toContain('data-boards="光模块,算力"');
  expect(html).toContain("14 来源");
  expect(html).toContain("2026 · 06 · 03");
});

test("转义用户文本里的尖括号", () => {
  expect(escapeHtml("<a>")).toBe("&lt;a&gt;");
  expect(renderCard(ENTRY)).toContain("&lt;带尖括号&gt;");
});

test("非股票类型不显示板块标签（但 data-boards 仍保留）", () => {
  const html = renderCard(ENTRY); // type=板块
  expect(html).not.toContain('<span class="boards">');
  expect(html).toContain('data-boards="光模块,算力"');
});

test("股票类型显示板块标签", () => {
  const html = renderCard({ ...ENTRY, type: "股票" });
  expect(html).toContain('<span class="boards">光模块 · 算力</span>');
  expect(html).toContain('data-type="股票"');
});

test("股票类型但无关联板块时不渲染空标签", () => {
  const html = renderCard({ ...ENTRY, type: "股票", boards: [] });
  expect(html).not.toContain('<span class="boards">');
});
