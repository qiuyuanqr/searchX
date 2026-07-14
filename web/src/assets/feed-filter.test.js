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
