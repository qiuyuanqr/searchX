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
