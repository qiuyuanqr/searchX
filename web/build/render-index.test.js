import { test, expect } from "bun:test";
import { renderIndex } from "./render-index.js";

const TPL = `<ul class="article-list"><!-- CARDS --></ul>`;
const ENTRIES = [
  { dir: "2026-06-02_b", date: "2026-06-02", slug: "b", type: "板块", title: "B 标题", tldr: "b", tags: [], boards: [], sourceCount: 1, href: "r/2026-06-02_b/" },
  { dir: "2026-06-01_a", date: "2026-06-01", slug: "a", type: "概念", title: "A 标题", tldr: "a", tags: [], boards: [], sourceCount: 2, href: "r/2026-06-01_a/" },
];

test("把卡片注入占位符，保留顺序", () => {
  const html = renderIndex(ENTRIES, TPL);
  expect(html).not.toContain("<!-- CARDS -->");
  expect(html).toContain("B 标题");
  expect(html).toContain("A 标题");
  expect(html.indexOf("B 标题")).toBeLessThan(html.indexOf("A 标题"));
});
