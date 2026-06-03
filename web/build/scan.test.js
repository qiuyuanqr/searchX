import { test, expect } from "bun:test";
import { scanResearch } from "./scan.js";

const ROOT = "web/build/fixtures/research";

test("只收 日期_slug 文件夹，按日期倒序", () => {
  const entries = scanResearch(ROOT);
  expect(entries.length).toBe(2);
  expect(entries.map((e) => e.dir)).toEqual([
    "2026-06-02_beta",
    "2026-06-01_alpha",
  ]);
});

test("条目带解析后的字段", () => {
  const beta = scanResearch(ROOT)[0];
  expect(beta.title).toBe("Beta 板块");
  expect(beta.sourceCount).toBe(9);
  expect(beta.href).toBe("r/2026-06-02_beta/");
});
