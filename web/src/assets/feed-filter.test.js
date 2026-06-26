import { test, expect } from "bun:test";
import { computeFeedView } from "./feed-filter.js";

// items：信息流里有序的项；kind 'sep' 是月分隔，'card' 是卡片。
const ITEMS = [
  { kind: "sep", month: "2026-06" },
  { kind: "card", type: "概念", boards: ["算力"] },
  { kind: "card", type: "股票", boards: ["算力", "机器人"] },
  { kind: "sep", month: "2026-05" },
  { kind: "card", type: "人物", boards: [] },
];

test("默认（全部/无板块）：所有卡片可见，所有分隔可见，计数=卡片数", () => {
  const { visible, count } = computeFeedView(ITEMS, { type: "all", board: null });
  expect(count).toBe(3);
  expect(visible).toEqual([true, true, true, true, true]);
});

test("按类型筛选：只留该类型卡片", () => {
  const { visible, count } = computeFeedView(ITEMS, { type: "股票", board: null });
  expect(count).toBe(1);
  expect(visible[2]).toBe(true);
  expect(visible[1]).toBe(false);
  expect(visible[4]).toBe(false);
});

test("按板块筛选：只留含该板块的卡片", () => {
  const { visible, count } = computeFeedView(ITEMS, { type: "all", board: "机器人" });
  expect(count).toBe(1);
  expect(visible[2]).toBe(true);
});

test("类型 + 板块叠加（AND）", () => {
  const { count } = computeFeedView(ITEMS, { type: "概念", board: "机器人" });
  expect(count).toBe(0); // 概念那条没有机器人板块
  const r2 = computeFeedView(ITEMS, { type: "股票", board: "机器人" });
  expect(r2.count).toBe(1);
});

test("没有可见卡片的月分隔要隐藏", () => {
  // 只剩五月那条人物可见 → 六月分隔(索引0)隐藏，五月分隔(索引3)可见
  const { visible } = computeFeedView(ITEMS, { type: "人物", board: null });
  expect(visible[0]).toBe(false);
  expect(visible[3]).toBe(true);
  expect(visible[4]).toBe(true);
});

test("全空时所有分隔都隐藏，计数=0", () => {
  const { visible, count } = computeFeedView(ITEMS, { type: "事件", board: null });
  expect(count).toBe(0);
  expect(visible).toEqual([false, false, false, false, false]);
});
