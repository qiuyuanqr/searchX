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

test("卡片含标题、类型、链接、筛选用 data 属性", () => {
  const html = renderCard(ENTRY);
  expect(html).toContain('href="r/2026-06-03_cpo/"');
  expect(html).toContain("CPO / 硅光产业链");
  expect(html).toContain('data-type="板块"');
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

test("卡片不再展示板块信息（2026-07-14 起首页板块信息整体下线）", () => {
  const html = renderCard({ ...ENTRY, boards: ["光模块", "算力"] });
  expect(html).not.toContain("光模块");
  expect(html).not.toContain("data-boards");
  expect(html).toContain('<div class="card-meta">2026·06·03 · 14 来源</div>');
});

test("无一句话结论时不渲染 lead", () => {
  const html = renderCard({ ...ENTRY, tldr: "" });
  expect(html).not.toContain('class="lead"');
});

test("sourceCount 也走转义：即便上游漏拦，标记也不会进 HTML", () => {
  const html = renderCard({
    dir: "2026-06-01_x", date: "2026-06-01", type: "概念", title: "T", tldr: "",
    sourceCount: '<img src=x onerror=alert(1)>', href: "r/2026-06-01_x/",
  });
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
});
