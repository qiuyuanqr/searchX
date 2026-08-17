import { expect, test, describe } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { STOCK_META, metaOf, exchangeOf } from "./mapping.js";

const ARCHIVE = join(new URL("../../..", import.meta.url).pathname.replace(/\/$/, ""), "research");

describe("slug 与已归档目录必须一致", () => {
  // 这是本表最重要的不变量：slug 就是公开网址（/r/<date>_<slug>/）。
  // 一旦某只票已经归档，再改它在表里的 slug，重导就会造出**新目录**，
  // 旧链接直接 404——已分享出去的、书签、搜索引擎收录的全部失效。
  // 这条测试自动盯住漂移，不靠人记得去比对。
  test("表里每个代码的 slug 等于它已归档目录里的 slug", () => {
    const dirs = readdirSync(ARCHIVE).filter((n) => /^\d{4}-\d{2}-\d{2}_/.test(n));
    const mismatches = [];
    for (const [code, meta] of Object.entries(STOCK_META)) {
      for (const d of dirs.filter((x) => x.slice(11).endsWith(code))) {
        const slug = d.slice(11);
        if (slug !== meta.slug) mismatches.push(`${code}：表里 ${meta.slug} ≠ 目录 ${slug}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe("metaOf", () => {
  test("表里有的返回表里的值，known 为真", () => {
    const m = metaOf("300394");
    expect(m.slug).toBe("tfc-optical-300394");
    expect(m.boards).toEqual(["光模块", "算力"]);
    expect(m.known).toBe(true);
  });

  // 已上线才补进表的两只，slug 刻意保持降级形态以保住网址；
  // boards: [] 是「与五大板块确无关联」的结论，不是没填。
  test("已上线后补表的票保持 stock-<代码> 形态", () => {
    for (const code of ["688137", "301230"]) {
      const m = metaOf(code);
      expect(m.slug).toBe(`stock-${code}`);
      expect(m.boards).toEqual([]);
      expect(m.known).toBe(true);
    }
  });

  test("表里没有的降级成 stock-<代码>、板块留空、known 为假", () => {
    const m = metaOf("999999");
    expect(m.slug).toBe("stock-999999");
    expect(m.boards).toEqual([]);
    expect(m.known).toBe(false);
  });

  test("补齐到 6 位后再查表", () => {
    expect(metaOf("725").slug).toBe("boe-000725");
  });
});

describe("exchangeOf", () => {
  test.each([["600519", "SH"], ["601138", "SH"], ["603259", "SH"], ["688635", "SH"]])(
    "沪市 %s → %s", (code, ex) => expect(exchangeOf(code)).toBe(ex));

  test.each([["000725", "SZ"], ["002050", "SZ"], ["300394", "SZ"], ["301230", "SZ"]])(
    "深市 %s → %s", (code, ex) => expect(exchangeOf(code)).toBe(ex));
});
