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
  expect(html).toContain("2026·06·03");
});

test("紧凑结构：类型徽标 + 标题 + 一句话 + 微元信息一行", () => {
  const html = renderCard(ENTRY);
  expect(html).toContain('class="ctype"');
  expect(html).toContain('class="card-title"');
  expect(html).toContain('class="lead"');
  expect(html).toContain('class="card-meta"');
});

test("转义用户文本里的尖括号", () => {
  expect(escapeHtml("<a>")).toBe("&lt;a&gt;");
  expect(renderCard(ENTRY)).toContain("&lt;带尖括号&gt;");
});

test("所有类型都在微元信息里显示板块（交集），不再仅限股票", () => {
  const html = renderCard(ENTRY); // type=板块
  expect(html).toContain("光模块 · 算力");
  const stock = renderCard({ ...ENTRY, type: "股票" });
  expect(stock).toContain("光模块 · 算力");
});

test("只显示属于 5 大板块的项，过滤掉 related 里的非板块双链", () => {
  const html = renderCard({ ...ENTRY, boards: ["光模块", "CPO 共封装光学", "概率"] });
  // 显示层（card-meta）只露板块，非板块双链不出现
  expect(html).toContain('<div class="card-meta">2026·06·03 · 14 来源 · 光模块</div>');
  // data-boards 仍保留全部原始值（筛选只匹配 5 大板块，多余值无害）
  expect(html).toContain('data-boards="光模块,CPO 共封装光学,概率"');
});

test("无板块时微元信息不带板块段", () => {
  const html = renderCard({ ...ENTRY, boards: [] });
  expect(html).not.toContain(" · 光模块");
  expect(html).toContain("14 来源");
});

test("无一句话结论时不渲染 lead", () => {
  const html = renderCard({ ...ENTRY, tldr: "" });
  expect(html).not.toContain('class="lead"');
});
