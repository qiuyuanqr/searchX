import { describe, expect, it } from "bun:test";
import { canonicalFactcheckNote, factcheckFilename } from "./factcheck-note.js";

describe("canonicalFactcheckNote", () => {
  it("只替换note字段，正文、其他frontmatter和换行原样保留", () => {
    const input = '\uFEFF---\r\ntitle: "某截图：政策/传闻"\r\nsummary: "不实（高）：消息不成立"\r\nnote: "Factcheck/模型自行命名.md"\r\nsource_count: 2\r\nrelated: [AI应用]\r\n---\r\n\r\n## 真相直述\r\n正文含 note: 不替换。\r\n';
    const expected = input.replace('note: "Factcheck/模型自行命名.md"', 'note: "Factcheck/某截图：政策 传闻--task-1.md"');
    const result = canonicalFactcheckNote(input, "task-1");
    expect(result).toBe(expected);
    expect(canonicalFactcheckNote(result, "task-1")).toBe(result);
  });

  it("缺note时补入frontmatter，标题清洗来自共享文件名函数", () => {
    const input = '---\ntitle: "../不安全/标题"\nother: unchanged\n---\n正文\n';
    const filename = factcheckFilename("../不安全/标题", "t0");
    expect(canonicalFactcheckNote(input, "t0")).toBe(input.replace('other: unchanged\n', `other: unchanged\nnote: "Factcheck/${filename}"\n`));
    expect(canonicalFactcheckNote('---\nsummary: "一句话"\n---\n原文', "t0")).toContain('note: "Factcheck/私密事实核查--t0.md"');
  });

  it("无frontmatter、未闭合、重复note及多行歧义拒绝", () => {
    expect(() => canonicalFactcheckNote("只有正文", "t0")).toThrow("frontmatter");
    expect(() => canonicalFactcheckNote("前言\n---\ntitle: title\n---\n正文", "t0")).toThrow("frontmatter");
    expect(() => canonicalFactcheckNote("---\ntitle: title", "t0")).toThrow("未闭合");
    for (const value of [
      'note: one\nnote: two', 'note: one\n"note": two',
      'note: |\n  multiline', 'note: >-\n  multiline', 'note:\n  continuation',
      'note: "open\n  continuation"', 'note: plain\n\n  continuation',
    ]) {
      expect(() => canonicalFactcheckNote(`---\ntitle: title\n${value}\n---\n正文`, "t0")).toThrow();
    }
  });

  it("任务id穿越拒绝，正文中同名字段不影响规范化", () => {
    const input = '---\ntitle: 标题\nnote: old\n---\nnote: 正文\n';
    expect(() => canonicalFactcheckNote(input, "../t0")).toThrow("任务 id");
    expect(canonicalFactcheckNote(input, "t0")).toEndWith("---\nnote: 正文\n");
  });
});
