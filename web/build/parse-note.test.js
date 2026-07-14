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

test("parseNote 容错：related / tags 写成 YAML 标量（非数组）不崩，归一化成数组", () => {
  const e = parseNote("---\ntype: 股票\nrelated: 算力\ntags: 半导体\n---\n\n# 某股", "2026-06-05_x");
  expect(e.boards).toEqual(["算力"]);
  expect(e.tags).toEqual(["半导体"]);
});

test("parseNote 标题也清洗 markdown 噪声（卡片是纯文本展示层）", () => {
  const e = parseNote("---\ntype: 概念\n---\n\n# 标题 **粗** 与 [[双链]] 和 `代码`", "2026-06-05_t");
  expect(e.title).toBe("标题 粗 与 双链 和 代码");
});

test("parseNote 清洗 tldr 里的 markdown 噪声（纸感卡片用纯文本）", () => {
  const raw = "---\ntype: 板块\n---\n\n# 标题\n\n" +
    "> 衔接 [[other-note]] 的 **重点**，参考 `code` 与 [链接](https://x.com)。\n";
  const e = parseNote(raw, "2026-06-03_demo");
  expect(e.tldr).toBe("衔接 other-note 的 重点，参考 code 与 链接。");
});

test("parseNote 清洗 tldr 里漏进的 HTML 标签（卡片是纯文本展示层）", () => {
  const raw = "---\ntype: 股票\n---\n\n# 晋拓股份\n\n" +
    "> 「压铸老兵」组合，但 <strong>实控人</strong> 5 个月套现 3 亿。\n";
  const e = parseNote(raw, "2026-06-24_jintuo");
  expect(e.tldr).toBe("「压铸老兵」组合，但 实控人 5 个月套现 3 亿。");
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

// 优先级：「## 一句话/TL;DR」标题下的段落是作者显式标注的结论，优先于标题前的引用块——
// 标题前的引用块常是免责声明/基准数据（如股票报告的"基准日收盘价…"），不是真结论。
test("parseNote 优先取「## 一句话」标题下的段落，标题前的引用块让位", () => {
  const raw =
    "---\ntype: 股票\n---\n\n# 某股\n\n> 引用块结论。\n\n## 一句话\n\n段落结论。\n";
  const e = parseNote(raw, "2026-06-05_x");
  expect(e.tldr).toBe("段落结论。");
});

test("parseNote：「## 一句话」标题下若是引用块（而非段落），也取该引用块", () => {
  const raw =
    "---\ntype: 股票\n---\n\n# 某股\n\n> 标题前的免责声明。\n\n## 一句话结论\n\n> 标题下的引用块结论。\n";
  const e = parseNote(raw, "2026-06-05_x2");
  expect(e.tldr).toBe("标题下的引用块结论。");
});

// 回归：即使真正的结论段落在文档里位置更靠前，"一句话/TL;DR"标题命中仍优先于
// 之后才出现的正文中部引用块（原 bug：正文中部引用会顶掉已标注的结论）。
test("parseNote：「## 一句话」标题段落优先于其后才出现的正文中部引用块", () => {
  const raw =
    "---\ntype: 概念\n---\n\n# 某主题\n\n## 背景\n正文段落。\n\n" +
    "## 一句话本质\n\n这是真正的结论段落。\n\n" +
    "## 别的小节\n更多内容\n\n> 正文中部的旁注引用，不是导语。\n";
  const e = parseNote(raw, "2026-06-05_mid");
  expect(e.tldr).toBe("这是真正的结论段落。");
});

// 回归：标题中部含"一句话"字样（如"## 公司一句话定位"）不应误命中 TL;DR 优先级——
// 真正的 TL;DR 类标题必须以"一句话"/"TL;DR"开头。
test("parseNote：标题中部含「一句话」字样的（如「## 公司一句话定位」）不误命中，落回导语位置引用块", () => {
  const raw =
    "---\ntype: 股票\n---\n\n# 某股\n\n> 导语位置的真结论。\n\n" +
    "## 公司一句话定位\n\n公司背景介绍，不是方向结论。\n";
  const e = parseNote(raw, "2026-06-05_pos");
  expect(e.tldr).toBe("导语位置的真结论。");
});

// 第二档结论标题（一屏结论/核心结论/结论先行）：作者标注的结论段，优先于标题前的引用块——
// 标题前引用块常是免责声明/基准价数据（存量 10 篇正是这样拿到「本笔记是精简版」类套话导语的）。
test("parseNote：「## 核心结论（BLUF）」段落优先于标题前的免责声明引用块", () => {
  const raw =
    "---\ntype: 股票\n---\n\n# 某股\n\n> 信息截止 2026-06-05，不构成投资建议。\n\n" +
    "## 核心结论（BLUF）\n\n方向震荡偏弱，题材已透支。\n";
  const e = parseNote(raw, "2026-06-05_bluf");
  expect(e.tldr).toBe("方向震荡偏弱，题材已透支。");
});

test("parseNote：「## A 核心结论」带节号前缀也认；「## 一屏结论」同理", () => {
  const a = parseNote("---\ntype: 股票\n---\n\n# 甲\n\n## A 核心结论（BLUF）\n\n甲的结论。\n", "2026-06-05_a");
  expect(a.tldr).toBe("甲的结论。");
  const b = parseNote("---\ntype: 股票\n---\n\n# 乙\n\n## 一屏结论\n\n乙的结论。\n", "2026-06-05_b");
  expect(b.tldr).toBe("乙的结论。");
});

// 两档并存时「一句话/TL;DR」赢——即便它在文档里出现得更晚（更接近卡片导语的体裁）。
test("parseNote：「## 一句话」标题晚于「## 核心结论」出现时仍优先", () => {
  const raw =
    "---\ntype: 股票\n---\n\n# 某股\n\n## 核心结论\n\n长版结论段。\n\n## 一句话结论\n\n短版一句话。\n";
  const e = parseNote(raw, "2026-06-05_two");
  expect(e.tldr).toBe("短版一句话。");
});

test("source_count 强转数字：字符串带标记归 0（不让恶意 frontmatter 直通首页）、数字字符串正常收", () => {
  const mk = (v) => parseNote(`---\nsource_count: ${v}\n---\n# T\n> d\n`, "2026-06-01_x");
  expect(mk('"<b>9</b>"').sourceCount).toBe(0);
  expect(mk('"12"').sourceCount).toBe(12);
  expect(mk("15").sourceCount).toBe(15);
  expect(mk('"abc"').sourceCount).toBe(0);
});
