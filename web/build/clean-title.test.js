import { test, expect } from "bun:test";
import { cleanStockTitle } from "./clean-title.js";

// 覆盖存量 27 个股票标题的全部真实格式（2026-07-14 盘点）
const REAL_CASES = [
  ["国瓷材料（300285.SZ）— 未来约 13 周走势判断", "国瓷材料", "300285.SZ"],
  ["经纬辉开（300120）— 单只股票深度投研", "经纬辉开", "300120.SZ"],
  ["黄河旋风（600172）— 未来约 13 周投研", "黄河旋风", "600172.SH"],
  ["巨轮智能 002031", "巨轮智能", "002031.SZ"],
  ["特变电工 600089.SH", "特变电工", "600089.SH"],
  ["铜冠铜箔（301217.SZ）深度投研", "铜冠铜箔", "301217.SZ"],
  ["阳光电源 300274.SZ · 深度调研", "阳光电源", "300274.SZ"],
  ["海光信息（688041.SH）· 13 周展望", "海光信息", "688041.SH"],
  ["新易盛 300502.SZ · 13 周深度调研", "新易盛", "300502.SZ"],
  ["维谛技术 Vertiv Holdings (NYSE: VRT) · 调研笔记", "维谛技术 Vertiv Holdings", "NYSE: VRT"],
  ["菲利华（300395.SZ）", "菲利华", "300395.SZ"],
  ["新莱福（301323.SZ）— 13 周方向偏涨但波动放大", "新莱福", "301323.SZ"],
  ["京北方（002987.SZ）· 股票深度调研", "京北方", "002987.SZ"],
  ["胜宏科技（300476.SZ / 02476.HK）", "胜宏科技", "300476.SZ / 02476.HK"],
  ["芯原股份（688521.SH）· 13 周走势判断与触发条件", "芯原股份", "688521.SH"],
  ["北特科技（603009.SH）— 单只股票深度研究（13 周走势 + 条件式操作）", "北特科技", "603009.SH"],
  ["三花智控（002050.SZ / 02050.HK）", "三花智控", "002050.SZ / 02050.HK"],
  ["蓝思科技（300433.SZ / 6613.HK）— 13 周走势情景与买卖点", "蓝思科技", "300433.SZ / 6613.HK"],
  ["润泽科技（300442）", "润泽科技", "300442.SZ"],
];

test("cleanStockTitle 覆盖存量全部真实标题格式", () => {
  for (const [raw, name, codes] of REAL_CASES) {
    expect(cleanStockTitle(raw)).toEqual({ name, codes });
  }
});

test("裸 A 股代码按首位补交易所后缀（6→SH、0/3→SZ、4/8→BJ）", () => {
  expect(cleanStockTitle("某公司 600001").codes).toBe("600001.SH");
  expect(cleanStockTitle("某公司 000001").codes).toBe("000001.SZ");
  expect(cleanStockTitle("某公司 300001").codes).toBe("300001.SZ");
  expect(cleanStockTitle("某公司 830001").codes).toBe("830001.BJ");
});

test("解析不出代码 / 只有代码没名称 → null（调用方原样展示）", () => {
  expect(cleanStockTitle("Serenity 分析股票的方法")).toBe(null);
  expect(cleanStockTitle("左侧交易 vs 右侧交易")).toBe(null);
  expect(cleanStockTitle("600172")).toBe(null);
});

test("概念类标题里的中文括号不被误当代码（调用方只对股票卡调用，此为兜底）", () => {
  expect(cleanStockTitle("物理 AI（Physical AI）")).toBe(null);
});

test("代码后的套话后缀一律不进结果", () => {
  const r = cleanStockTitle("奥比中光（688322.SH）— 未来 13 周走势研判");
  expect(r.name).toBe("奥比中光");
  expect(r.codes).toBe("688322.SH");
});
