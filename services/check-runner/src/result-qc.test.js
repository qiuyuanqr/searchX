import { describe, it, expect } from "bun:test";
import { qcResult, countSourceItems } from "./result-qc.js";

const GOOD = `---
date: 2026-09-17
created: 2026-09-17T16:43:52+0800
type: 核查
title: "网传iPhone 17全系国行版取消实体SIM卡槽"
summary: "不实（高）：国行三款仍是双实体卡槽，唯独 Air 无卡槽"
verdict: 不实
confidence: 高
source_credibility: 中
input_type: 文本
tags: [factcheck, iPhone17]
related: []
source_count: 2
note: "Factcheck/2026-09-17_iPhone17国行版实体SIM卡槽传闻.md"
---

## 真相直述

不实。

## 来龙去脉

- 时间线。

## 逐条核查

| # | 原子说法 | 裁定（把握度） | 关键证据 | 来源 |
|---|---|---|---|---|
| 1 | 说法 | 🔴 不实（高） | 证据 | [1] |

## 核查结论与可信度

**事实裁定：🔴 不实（高）**。

## 局限

- 无。

## 来源

1. [A — 媒体 (2025-09-10)](https://a.example/1)
2. [B — Apple](https://b.example/2)
`;

describe("qcResult", () => {
  it("规范笔记零问题", () => {
    expect(qcResult(GOOD)).toEqual([]);
  });

  it("空输入 → 结果为空", () => {
    expect(qcResult("")).toEqual(["结果文件为空"]);
    expect(qcResult(null)).toEqual(["结果文件为空"]);
  });

  it("source_count 与来源节条数对不上（2026-09-18 存量实测：写 7 列 9）", () => {
    const md = GOOD.replace("source_count: 2", "source_count: 7");
    expect(qcResult(md)).toEqual(["source_count 写 7、来源节实际 2 条"]);
  });

  it("缺必填字段逐个点名；缺 frontmatter 单独一条", () => {
    const md = GOOD.replace('note: "Factcheck/2026-09-17_iPhone17国行版实体SIM卡槽传闻.md"\n', "").replace("verdict: 不实\n", "");
    const issues = qcResult(md);
    expect(issues).toContain("frontmatter 缺 note");
    expect(issues).toContain("frontmatter 缺 verdict");
    expect(qcResult("## 真相直述\n\nx")).toContain("缺 frontmatter（文件不以 --- 开头）");
  });

  it("summary 带 emoji 前缀 / 括号里没有把握度 → 手机页解析不了，要点出", () => {
    expect(qcResult(GOOD.replace('summary: "不实（高）：', 'summary: "🔴 不实（高）：'))).toContain("summary 不符合「裁定（高|中|低）：一句话」格式，手机页会退回「已完成」灰标");
    expect(qcResult(GOOD.replace('summary: "不实（高）：', 'summary: "不实：'))).toContain("summary 不符合「裁定（高|中|低）：一句话」格式，手机页会退回「已完成」灰标");
  });

  it("括号里把握度后带附注（真跑写过「大体属实（高，补证据重查维持不变）：」）算合格", () => {
    const md = GOOD.replace('summary: "不实（高）：', 'summary: "不实（高，补证据重查维持不变）：');
    expect(qcResult(md)).toEqual([]);
  });

  it("summary 开头裁定与 verdict 不一致", () => {
    expect(qcResult(GOOD.replace("verdict: 不实", "verdict: 半真"))).toContain("summary 开头的裁定「不实」与 verdict「半真」不一致");
  });

  it("verdict / confidence / source_credibility 取值越界", () => {
    expect(qcResult(GOOD.replace("verdict: 不实", "verdict: 假的"))).toContain("verdict 不在七档内：假的");
    expect(qcResult(GOOD.replace("confidence: 高", "confidence: 很高"))).toContain("confidence 不是 高/中/低：很高");
    expect(qcResult(GOOD.replace("source_credibility: 中", "source_credibility: 无"))).toContain("source_credibility 不是 高/中/低/不适用：无");
    expect(qcResult(GOOD.replace("source_credibility: 中", "source_credibility: 不适用"))).toEqual([]);
  });

  it("六节缺一节 / 顺序颠倒 / 出现 H1", () => {
    expect(qcResult(GOOD.replace("## 局限\n\n- 无。\n\n", ""))).toContain("缺「## 局限」节");
    const swapped = GOOD.replace("## 局限\n\n- 无。\n\n## 来源", "## 来源").replace("## 来龙去脉", "## 局限\n\n- 无。\n\n## 来龙去脉");
    expect(qcResult(swapped)).toContain("「## 局限」节顺序不对");
    expect(qcResult(GOOD.replace("## 真相直述", "# 标题\n\n## 真相直述"))).toContain("正文出现 H1 大标题（文件名即标题，不该有）");
  });

  it("来源用无序列表 / reference-style：点出", () => {
    const ul = GOOD.replace("1. [A — 媒体 (2025-09-10)](https://a.example/1)\n2. [B — Apple](https://b.example/2)", "- [A](https://a.example/1)\n- [B](https://b.example/2)");
    expect(qcResult(ul)).toContain("来源节没有编号列表条目");
    const ref = GOOD.replace("2. [B — Apple](https://b.example/2)", "2. [B — Apple][b]\n\n[b]: https://b.example/2");
    expect(qcResult(ref)).toContain("来源用了 reference-style 写法（[标签]: url），Obsidian 解析不出");
  });

  it("逐条核查表缺固定表头 / note 形式不对 / title 超长", () => {
    expect(qcResult(GOOD.replace("| # | 原子说法 | 裁定（把握度） | 关键证据 | 来源 |", "| 说法 | 裁定 |"))).toContain("逐条核查表缺固定 5 列表头（| # | 原子说法 | 裁定（把握度） | 关键证据 | 来源 |）");
    expect(qcResult(GOOD.replace('note: "Factcheck/2026-09-17_iPhone17国行版实体SIM卡槽传闻.md"', 'note: "2026-09-17_x.md"'))).toContain("note 不是 Factcheck/<文件名>.md 形式：2026-09-17_x.md");
    expect(qcResult(GOOD.replace('title: "网传iPhone 17全系国行版取消实体SIM卡槽"', `title: "${"字".repeat(41)}"`))).toContain("title 超 40 字（Worker 会截断）：41 字");
  });

  it("countSourceItems：无来源节 → null；只数编号行，到下一节为止", () => {
    expect(countSourceItems("## 局限\n\n1. x")).toBeNull();
    expect(countSourceItems("## 来源\n\n1. a\n2. b\n\n## 附\n\n3. c")).toBe(2);
  });
});
