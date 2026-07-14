// services/runner/src/dedup.test.js
import { test, expect } from "bun:test";
import { findFreshReport, daysBetween, extractCodes } from "./dedup.js";

const verisilicon = {
  dir: "2026-06-08_verisilicon-688521",
  date: "2026-06-08",
  type: "股票",
  title: "芯原股份（688521.SH）",
  tldr: "国内半导体 IP 龙头",
  slug: "verisilicon-688521",
  tags: ["research", "芯原股份", "688521", "IP", "NPU"],
  href: "r/2026-06-08_verisilicon-688521/",
};
const orbbec = {
  dir: "2026-06-06_orbbec-688322",
  date: "2026-06-06",
  type: "股票",
  title: "奥比中光（688322.SH）",
  tldr: "机器人之眼",
  slug: "orbbec-688322",
  tags: ["research", "股票", "奥比中光", "688322", "3D视觉"],
  href: "r/2026-06-06_orbbec-688322/",
};
const concept = {
  dir: "2026-06-05_physical-ai-overview",
  date: "2026-06-05",
  type: "概念",
  title: "物理 AI（Physical AI）",
  tldr: "会动手的 AI",
  slug: "physical-ai-overview",
  tags: ["research", "概念", "物理AI", "机器人"],
  href: "r/2026-06-05_physical-ai-overview/",
};
const ENTRIES = [verisilicon, orbbec, concept];

test("daysBetween：日历天差，坏日期视为 Infinity", () => {
  expect(daysBetween("2026-06-08", "2026-06-10")).toBe(2);
  expect(daysBetween("2026-06-10", "2026-06-08")).toBe(-2);
  expect(daysBetween("2026-06-08", "2026-06-08")).toBe(0);
  expect(daysBetween("bad", "2026-06-08")).toBe(Infinity);
});

test("extractCodes：抽 6 位 A 股代码（含 .SH/.SZ 后缀形式）", () => {
  expect([...extractCodes("芯原股份 688521")]).toEqual(["688521"]);
  expect([...extractCodes("300476.SZ")]).toEqual(["300476"]);
  expect([...extractCodes("芯原股份")]).toEqual([]);
});

test("精确公司名命中（窗口内）→ 返回该报告", () => {
  const r = findFreshReport({ topic: "芯原股份", entries: ENTRIES, today: "2026-06-10", windowDays: 30 });
  expect(r).toBeTruthy();
  expect(r.entry.dir).toBe("2026-06-08_verisilicon-688521");
  expect(r.matchedBy).toBe("name");
  expect(r.ageDays).toBe(2);
});

test("代码命中（含 .SH 后缀）→ 命中 code", () => {
  const r = findFreshReport({ topic: "688521.SH", entries: ENTRIES, today: "2026-06-10", windowDays: 30 });
  expect(r).toBeTruthy();
  expect(r.entry.dir).toBe("2026-06-08_verisilicon-688521");
  expect(r.matchedBy).toBe("code");
});

test("命中但报告已过时效窗口 → null（允许重做）", () => {
  const r = findFreshReport({ topic: "芯原股份", entries: ENTRIES, today: "2026-09-01", windowDays: 30 });
  expect(r).toBeNull();
});

test("窗口边界：恰好 = windowDays 仍算命中；超 1 天则放行", () => {
  expect(findFreshReport({ topic: "芯原股份", entries: ENTRIES, today: "2026-07-08", windowDays: 30 })).toBeTruthy(); // 30 天
  expect(findFreshReport({ topic: "芯原股份", entries: ENTRIES, today: "2026-07-09", windowDays: 30 })).toBeNull();   // 31 天
});

test("不同股票 → 不命中", () => {
  expect(findFreshReport({ topic: "胜宏科技", entries: ENTRIES, today: "2026-06-10", windowDays: 30 })).toBeNull();
  expect(findFreshReport({ topic: "300476", entries: ENTRIES, today: "2026-06-10", windowDays: 30 })).toBeNull();
});

test("默认只查股票类型：同名概念报告不被当成股票去重", () => {
  // 概念报告（type=概念）即便名字命中也不参与股票查重
  const r = findFreshReport({ topic: "物理 AI", entries: ENTRIES, today: "2026-06-10", windowDays: 30 });
  expect(r).toBeNull();
});

test("多个命中取最新（ageDays 最小）", () => {
  const old = { ...verisilicon, dir: "2026-05-01_verisilicon-688521", date: "2026-05-01", href: "r/old/" };
  const r = findFreshReport({ topic: "芯原股份", entries: [old, verisilicon], today: "2026-06-10", windowDays: 60 });
  expect(r.entry.dir).toBe("2026-06-08_verisilicon-688521"); // 取新的那篇
});

test("名称变体：双方≥3字且一方包含另一方也算命中", () => {
  const r = findFreshReport({ topic: "芯原股份有限公司", entries: ENTRIES, today: "2026-06-10", windowDays: 30 });
  expect(r).toBeTruthy();
  expect(r.matchedBy).toBe("name");
});

test("报告日期在今天之后（异常）→ 不拦", () => {
  expect(findFreshReport({ topic: "芯原股份", entries: ENTRIES, today: "2026-06-01", windowDays: 30 })).toBeNull();
});

// 2026-07-14 线上误拦：国瓷材料报告带概念 tag "MLCC"，任何含 "MLCC" 的题目都被当成同一标的。
// 概念/行业 tag 不是标的名——名称匹配只认标题主名，tags 只用于抽代码。
const guoci = {
  dir: "2026-07-13_guoci-materials-300285",
  date: "2026-07-13",
  type: "股票",
  title: "国瓷材料（300285.SZ）— 未来约 13 周走势判断",
  tldr: "MLCC 介质粉龙头",
  slug: "guoci-materials-300285",
  tags: ["research", "国瓷材料", 300285, "MLCC", "介质粉", "固态电解质"],
  href: "r/2026-07-13_guoci-materials-300285/",
};

test("题目含概念 tag（MLCC）但非同一标的 → 不误拦", () => {
  expect(findFreshReport({ topic: "股票里面提到的MLCC是什么板块，干嘛的", entries: [guoci], today: "2026-07-14", windowDays: 30 })).toBeNull();
  expect(findFreshReport({ topic: "MLCC", entries: [guoci], today: "2026-07-14", windowDays: 30 })).toBeNull();
});

test("概念 tag 不当名字，但公司名/代码照常命中", () => {
  expect(findFreshReport({ topic: "国瓷材料", entries: [guoci], today: "2026-07-14", windowDays: 30 })).toBeTruthy();
  expect(findFreshReport({ topic: "国瓷材料的MLCC业务", entries: [guoci], today: "2026-07-14", windowDays: 30 })).toBeTruthy();
  expect(findFreshReport({ topic: "300285", entries: [guoci], today: "2026-07-14", windowDays: 30 })).toBeTruthy();
});

test("公司名只在 tags 不在标题时不再匹配（取舍：宁可漏拦）；纯数字 tag 仍抽为代码", () => {
  // tags 里的数字 tag（300285）仍参与代码匹配，即使标题没写代码
  const noCodeTitle = { ...guoci, title: "国瓷材料" };
  expect(findFreshReport({ topic: "300285.SZ", entries: [noCodeTitle], today: "2026-07-14", windowDays: 30 })).toBeTruthy();
});
