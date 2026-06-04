import { test, expect } from "bun:test";
import { parseNote } from "./parse-note.js";

const SAMPLE = `---
date: 2026-06-03
type: 板块
tags: [research, CPO, 硅光]
related: ["[[光模块]]", "[[算力]]"]
source_count: 14
archive: "research/2026-06-03_cpo-silicon-photonics-supply-chain/"
---

# CPO / 硅光产业链

> AI 算力撞上"功耗墙+带宽墙"后，光通信被迫往芯片身边搬家。

## 正文小节
内容……`;

test("parseNote 提取全部字段", () => {
  const e = parseNote(SAMPLE, "2026-06-03_cpo-silicon-photonics-supply-chain");
  expect(e.dir).toBe("2026-06-03_cpo-silicon-photonics-supply-chain");
  expect(e.date).toBe("2026-06-03");
  expect(e.slug).toBe("cpo-silicon-photonics-supply-chain");
  expect(e.type).toBe("板块");
  expect(e.title).toBe("CPO / 硅光产业链");
  expect(e.tldr).toContain("光通信被迫往芯片身边搬家");
  expect(e.tags).toEqual(["research", "CPO", "硅光"]);
  expect(e.boards).toEqual(["光模块", "算力"]);
  expect(e.sourceCount).toBe(14);
  expect(e.href).toBe("r/2026-06-03_cpo-silicon-photonics-supply-chain/");
});

test("parseNote 容错：缺字段不崩", () => {
  const e = parseNote("---\ntype: 概念\n---\n\n正文无标题", "2026-06-02_x");
  expect(e.title).toBe("x");        // 退化为 slug
  expect(e.tldr).toBe("");
  expect(e.boards).toEqual([]);
  expect(e.sourceCount).toBe(0);
});

test("parseNote 清洗 tldr 里的 markdown 噪声（纸感卡片用纯文本）", () => {
  const raw = "---\ntype: 板块\n---\n\n# 标题\n\n" +
    "> 衔接 [[other-note]] 的 **重点**，参考 `code` 与 [链接](https://x.com)。\n";
  const e = parseNote(raw, "2026-06-03_demo");
  expect(e.tldr).toBe("衔接 other-note 的 重点，参考 code 与 链接。");
});

// 回退：部分报告（如股票）用「## 一句话」标题段落而非 > 引用块作结论，导语不该为空。
test("parseNote 回退：无 > 引用块时取「## 一句话」段落作导语", () => {
  const raw =
    "---\ntype: 股票\n---\n\n# 三花智控\n\n" +
    "## 一句话\n\n未来 13 周方向 **震荡偏弱**：制冷连两季负增长。\n\n" +
    "## 先说人话\n别的内容";
  const e = parseNote(raw, "2026-06-05_sanhua");
  expect(e.tldr).toBe("未来 13 周方向 震荡偏弱：制冷连两季负增长。");
});

test("parseNote 回退：「## TL;DR（一句话）」标题段落也认", () => {
  const raw =
    "---\ntype: 股票\n---\n\n# 蓝思科技\n\n" +
    "## TL;DR（一句话）\n\n未来 13 周 **震荡偏强为基准**。\n";
  const e = parseNote(raw, "2026-06-04_lens");
  expect(e.tldr).toBe("未来 13 周 震荡偏强为基准。");
});

// 优先级：同时有 > 引用块和「## 一句话」时，引用块优先（既有行为不变）。
test("parseNote 优先用 > 引用块，不被后面的「## 一句话」覆盖", () => {
  const raw =
    "---\ntype: 股票\n---\n\n# 某股\n\n> 引用块结论。\n\n## 一句话\n\n段落结论。\n";
  const e = parseNote(raw, "2026-06-05_x");
  expect(e.tldr).toBe("引用块结论。");
});
