// scripts/check-sources.test.js
import { test, expect } from "bun:test";
import { extractUrls, checkArchive } from "./check-sources.js";

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
