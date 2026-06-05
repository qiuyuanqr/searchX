import { test, expect } from "bun:test";
import { findReportDefects } from "./validate-report.js";

test("干净报告无缺陷", () => {
  expect(findReportDefects(`<h1>标题</h1><span class="src-tag src-disc">披露</span>`)).toEqual([]);
});

test("残留未替换的 {{TOKEN}} 被发现", () => {
  const d = findReportDefects(`<h1>{{TITLE}}</h1>正文 {{SOURCES}}`);
  expect(d.length).toBe(2);
  expect(d.join()).toContain("{{TITLE}}");
  expect(d.join()).toContain("{{SOURCES}}");
});

test("非法来源标签配色类被发现", () => {
  const d = findReportDefects(`<span class="src-tag src-typo">x</span>`);
  expect(d.length).toBe(1);
  expect(d[0]).toContain("src-typo");
});

test("5 个合法来源配色类都通过", () => {
  const html = ["reg", "disc", "media", "research", "comm"]
    .map((c) => `<span class="src-tag src-${c}">x</span>`)
    .join("");
  expect(findReportDefects(html)).toEqual([]);
});
