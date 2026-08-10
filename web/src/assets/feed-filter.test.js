import { test, expect } from "bun:test";
import { computeFeedView } from "./feed-filter.js";

// items：信息流里有序的项；kind 'sep' 是月分隔，'card' 是卡片。
const ITEMS = [
  { kind: "sep", month: "2026-06" },
  { kind: "card", type: "概念" },
  { kind: "card", type: "股票" },
  { kind: "sep", month: "2026-05" },
  { kind: "card", type: "人物" },
];

test("默认（全部）：所有卡片可见，所有分隔可见，计数=卡片数", () => {
  const { visible, count } = computeFeedView(ITEMS, { type: "all" });
  expect(count).toBe(3);
  expect(visible).toEqual([true, true, true, true, true]);
});

test("按类型筛选：只留该类型卡片", () => {
  const { visible, count } = computeFeedView(ITEMS, { type: "股票" });
  expect(count).toBe(1);
  expect(visible[2]).toBe(true);
  expect(visible[1]).toBe(false);
  expect(visible[4]).toBe(false);
});

test("没有可见卡片的月分隔要隐藏", () => {
  // 只剩五月那条人物可见 → 六月分隔(索引0)隐藏，五月分隔(索引3)可见
  const { visible } = computeFeedView(ITEMS, { type: "人物" });
  expect(visible[0]).toBe(false);
  expect(visible[3]).toBe(true);
  expect(visible[4]).toBe(true);
});

test("全空时所有分隔都隐藏，计数=0", () => {
  const { visible, count } = computeFeedView(ITEMS, { type: "事件" });
  expect(count).toBe(0);
  expect(visible).toEqual([false, false, false, false, false]);
});

// ── 站内清单直配（matchReportsLocally）────────────────────────────────
// 背景：Pagefind 的中文分词把「江丰电子」切词后做 AND，「江丰」不在索引里就整条落空，
// 实测搜「江丰电子」「润泽科技」返回 0 条——站上明明有这两篇报告。清单直配是兜底。
import { matchReportsLocally, buildSearchItems } from "./feed-filter.js";

const ENTRIES = [
  { title: "江丰电子（300666.SZ）", type: "股票", date: "2026-07-14",
    slug: "jiangfeng-electronic-300666", tags: ["research", "江丰电子", 300666, "靶材"],
    href: "r/2026-07-14_jiangfeng-electronic-300666/" },
  { title: "宏景科技（301396.SZ）", type: "股票", date: "2026-07-29",
    slug: "hongjing-tech-301396", tags: ["research", "宏景科技", 301396, "算力"],
    href: "r/2026-07-29_hongjing-tech-301396/" },
  { title: "国产替代芯片供应链的龙头企业", type: "板块", date: "2026-08-10",
    slug: "china-chip-supply-chain", tags: ["research", "半导体"],
    href: "r/2026-08-10_china-chip-supply-chain/" },
];

test("按股票名直配到报告（Pagefind 分词查空的那类）", () => {
  expect(matchReportsLocally("江丰电子", ENTRIES).map((e) => e.slug))
    .toEqual(["jiangfeng-electronic-300666"]);
  expect(matchReportsLocally("润泽", ENTRIES)).toEqual([]);
});

test("按股票代码、slug、部分名称都能直配", () => {
  expect(matchReportsLocally("300666", ENTRIES).map((e) => e.slug)).toEqual(["jiangfeng-electronic-300666"]);
  expect(matchReportsLocally("江丰", ENTRIES).map((e) => e.slug)).toEqual(["jiangfeng-electronic-300666"]);
  expect(matchReportsLocally("hongjing", ENTRIES).map((e) => e.slug)).toEqual(["hongjing-tech-301396"]);
});

test("大小写与首尾空格不影响匹配", () => {
  expect(matchReportsLocally("  HONGJING  ", ENTRIES).map((e) => e.slug)).toEqual(["hongjing-tech-301396"]);
});

test("空查询 / 清单缺失 → 空数组，不炸", () => {
  expect(matchReportsLocally("", ENTRIES)).toEqual([]);
  expect(matchReportsLocally("江丰", null)).toEqual([]);
  expect(matchReportsLocally("江丰", [{ title: "无 href 的脏条目" }])).toEqual([]);
});

test("精确标签命中排在部分匹配之前", () => {
  const entries = [
    { title: "算力租赁行业", slug: "a", tags: ["算力"], href: "r/a/", date: "2026-01-01" },
    { title: "宏景科技（301396.SZ）", slug: "b", tags: ["宏景科技"], href: "r/b/", date: "2026-01-02" },
  ];
  expect(matchReportsLocally("宏景科技", entries)[0].slug).toBe("b");
});

test("buildSearchItems：清单命中排前，Pagefind 结果去重后接在后面", () => {
  const pf = [
    { url: "/r/2026-08-10_china-chip-supply-chain/", meta: { title: "国产替代芯片供应链的龙头企业" }, excerpt: "…江丰电子…" },
    { url: "/r/2026-07-14_jiangfeng-electronic-300666/", meta: { title: "江丰电子（300666.SZ）" }, excerpt: "…靶材…" },
  ];
  const items = buildSearchItems("江丰电子", ENTRIES, pf);
  expect(items[0].url).toBe("r/2026-07-14_jiangfeng-electronic-300666/"); // 直配的排第一
  expect(items.length).toBe(2);                                          // 同一篇不重复出现
  expect(items[1].url).toBe("/r/2026-08-10_china-chip-supply-chain/");
});

test("buildSearchItems：Pagefind 返回 0 条时，清单命中仍然显示（本次修的主症状）", () => {
  const items = buildSearchItems("江丰电子", ENTRIES, []);
  expect(items.map((i) => i.meta.title)).toEqual(["江丰电子（300666.SZ）"]);
  expect(items[0].excerpt).toContain("江丰电子"); // 摘要用标签兜底，不留空卡
});

test("buildSearchItems：清单无命中时退化为纯 Pagefind 结果", () => {
  const pf = [{ url: "/r/x/", meta: { title: "X" }, excerpt: "e" }];
  expect(buildSearchItems("完全没有的词", ENTRIES, pf)).toEqual(pf);
});

test("单个拉丁字符/纯标点不做子串匹配（否则会命中一大片、把全文结果挤出去）", () => {
  // slug 里到处是 'a'、'-'，标题里到处是 '.'（代码后缀），这类查询本地不该有命中
  expect(matchReportsLocally("a", ENTRIES)).toEqual([]);
  expect(matchReportsLocally("-", ENTRIES)).toEqual([]);
  expect(matchReportsLocally(".", ENTRIES)).toEqual([]);
  expect(matchReportsLocally("（", ENTRIES)).toEqual([]);
});

test("单个汉字仍然匹配（中文单字是有意义的查询）", () => {
  expect(matchReportsLocally("宏", ENTRIES).map((e) => e.slug)).toEqual(["hongjing-tech-301396"]);
});

test("两字以上的拉丁词照常匹配", () => {
  expect(matchReportsLocally("tech", ENTRIES).map((e) => e.slug)).toEqual(["hongjing-tech-301396"]);
});

test("单字符查询若与标签完全相同，仍算命中（精确匹配不受长度限制）", () => {
  const entries = [{ title: "某报告", slug: "x", tags: ["A"], href: "r/x/", date: "2026-01-01" }];
  expect(matchReportsLocally("a", entries).map((e) => e.slug)).toEqual(["x"]);
});
