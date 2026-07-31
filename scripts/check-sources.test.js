// scripts/check-sources.test.js
import { test, expect } from "bun:test";
import { extractUrls, checkArchive, normalizeUrl } from "./check-sources.js";

test("extractUrls：抽出 http(s) 链接，剥掉结尾的中英文标点", () => {
  const s = "见 https://a.example/x 与 https://b.example/y。另有 (https://c.example/z)，以及 https://d.example/w;";
  expect([...extractUrls(s)].sort()).toEqual([
    "https://a.example/x",
    "https://b.example/y",
    "https://c.example/z",
    "https://d.example/w",
  ].sort());
});

test("extractUrls：空/非字符串输入返回空集合，不抛", () => {
  expect(extractUrls("").size).toBe(0);
  expect(extractUrls(null).size).toBe(0);
  expect(extractUrls(undefined).size).toBe(0);
});

test("checkArchive：报告引了但清单没有 → 记入 missing（这是要修的）", () => {
  const r = checkArchive({
    sourcesMd: "- [甲](https://a.example/x)",
    reportHtml: '<a href="https://a.example/x">甲</a><a href="https://b.example/y">乙</a>',
  });
  expect(r.missing).toEqual(["https://b.example/y"]);
  expect(r.extra).toEqual([]);
});

test("checkArchive：清单有但报告没引 → 记入 extra（查过没引用，可接受）", () => {
  const r = checkArchive({
    sourcesMd: "- [甲](https://a.example/x)\n- [乙](https://b.example/y)",
    reportHtml: '<a href="https://a.example/x">甲</a>',
  });
  expect(r.missing).toEqual([]);
  expect(r.extra).toEqual(["https://b.example/y"]);
});

test("checkArchive：完全对得上时两边都空", () => {
  const r = checkArchive({
    sourcesMd: "- [甲](https://a.example/x)",
    reportHtml: '<a href="https://a.example/x">甲</a>',
  });
  expect(r.missing).toEqual([]);
  expect(r.extra).toEqual([]);
  expect(r.counts).toEqual({ sources: 1, report: 1 });
});

// ── URL 归一化（同一来源在正文与清单里写法常不一致）─────────────
test("normalizeUrl：协议/结尾斜杠/#锚点/大小写/www 前缀都不影响比对", () => {
  const forms = [
    "http://www.Example.com/a/b/",
    "https://example.com/a/b",
    "https://example.com/a/b#frag",
    "https://WWW.example.com/a/b/",
  ];
  const keys = new Set(forms.map(normalizeUrl));
  expect(keys.size).toBe(1);
});

test("normalizeUrl：查询参数保留（不同参数是不同页面）", () => {
  expect(normalizeUrl("https://a.example/p?id=1")).not.toBe(normalizeUrl("https://a.example/p?id=2"));
});

test("checkArchive：写法不同的同一来源不再被误报为缺失", () => {
  const r = checkArchive({
    sourcesMd: "- [媒体] 甲 — http://www.a.example/x/ — 2026-01-01 — 摘要",
    reportHtml: '<a href="https://a.example/x">甲</a>',
  });
  expect(r.missing).toEqual([]);
  expect(r.extra).toEqual([]);
});
