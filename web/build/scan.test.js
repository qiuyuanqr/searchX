import { test, expect } from "bun:test";
import { scanResearch, compareByNewest } from "./scan.js";

const ROOT = "web/build/fixtures/research";

// 排序比较器：新生成的排最上面
const order = (arr) => [...arr].sort(compareByNewest).map((e) => e.dir);

test("compareByNewest：同一天按 created 精确时间降序（新生成的在上）", () => {
  const same = [
    { dir: "d_runze",  date: "2026-06-04", created: "2026-06-04T17:42:07+08:00" },
    { dir: "d_lens",   date: "2026-06-04", created: "2026-06-04T22:53:24+08:00" },
    { dir: "d_left",   date: "2026-06-04", created: "2026-06-04T20:22:18+08:00" },
  ];
  expect(order(same)).toEqual(["d_lens", "d_left", "d_runze"]);
});

test("compareByNewest：日期是主序，created 不跨天颠倒顺序", () => {
  const arr = [
    { dir: "old_late",  date: "2026-06-02", created: "2026-06-03T23:00:00+08:00" }, // 旧日期但提交时刻晚
    { dir: "new_early", date: "2026-06-04", created: "2026-06-04T08:00:00+08:00" },
  ];
  expect(order(arr)).toEqual(["new_early", "old_late"]); // 仍按日期：06-04 在上
});

test("compareByNewest：缺 created 退化——同日有 created 的在上，都缺则目录名降序", () => {
  const arr = [
    { dir: "a_has", date: "2026-06-04", created: "2026-06-04T10:00:00+08:00" },
    { dir: "b_none", date: "2026-06-04", created: "" },
    { dir: "c_none", date: "2026-06-04", created: "" },
  ];
  expect(order(arr)).toEqual(["a_has", "c_none", "b_none"]); // 有时间的最上；都缺按 dir 降序
});

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
