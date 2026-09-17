import { describe, it, expect } from "bun:test";
import { parseFrontmatterScalars, signalsFromResult } from "./result-signals.js";

const NOTE = `---
date: 2026-09-17
created: 2026-09-17T13:00:00+0800
type: 核查
title: "SK海力士重启大连NAND二号厂扩产"
summary: "属实（高）：截图为真实财联社快讯，SK海力士确已重启大连 2 号厂"
verdict: 属实
confidence: 高
source_credibility: 中
input_type: 图片
tags: [factcheck, SK海力士]
related: ["[[算力]]"]
source_count: 6
---

## 真相直述

截图里的这条快讯是真的。
`;

describe("parseFrontmatterScalars", () => {
  it("解出标量键值，去掉成对引号，数组原样留作字符串", () => {
    const fm = parseFrontmatterScalars(NOTE);
    expect(fm.title).toBe("SK海力士重启大连NAND二号厂扩产");
    expect(fm.summary).toBe("属实（高）：截图为真实财联社快讯，SK海力士确已重启大连 2 号厂");
    expect(fm.verdict).toBe("属实");
    expect(fm.tags).toBe("[factcheck, SK海力士]");
  });

  it("无 frontmatter / 空输入 / 非字符串 → 空对象", () => {
    expect(parseFrontmatterScalars("## 真相直述\n没有头")).toEqual({});
    expect(parseFrontmatterScalars("")).toEqual({});
    expect(parseFrontmatterScalars(null)).toEqual({});
  });

  it("CRLF 与 BOM 都能解", () => {
    const fm = parseFrontmatterScalars("﻿---\r\ntitle: 甲\r\nsummary: 乙\r\n---\r\n正文");
    expect(fm).toEqual({ title: "甲", summary: "乙" });
  });

  it("不带引号、值里含中文冒号也照常", () => {
    const fm = parseFrontmatterScalars("---\nsummary: 不实（高）：该截图系旧闻拼接\n---\n");
    expect(fm.summary).toBe("不实（高）：该截图系旧闻拼接");
  });
});

describe("signalsFromResult", () => {
  it("取 summary / title 两个信号", () => {
    expect(signalsFromResult(NOTE)).toEqual({
      summary: "属实（高）：截图为真实财联社快讯，SK海力士确已重启大连 2 号厂",
      title: "SK海力士重启大连NAND二号厂扩产",
    });
  });

  it("缺字段 → 空串（调用方按空降级，不是 undefined）", () => {
    expect(signalsFromResult("---\nverdict: 属实\n---\n正文")).toEqual({ summary: "", title: "" });
    expect(signalsFromResult(null)).toEqual({ summary: "", title: "" });
  });

  it("值首尾空白被去掉；引号只在成对时才剥（单边引号原样保留，不崩）", () => {
    expect(signalsFromResult('---\ntitle:    带空白的标题   \n---\n').title).toBe("带空白的标题");
    expect(signalsFromResult('---\ntitle: "半个引号\n---\n').title).toBe('"半个引号');
  });
});
