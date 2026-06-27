import { test, expect } from "bun:test";
import {
  buildCheckPayload,
  validateCheckPayload,
  readKey,
  saveKey,
  clearKey,
  describeCheckResult,
  fitDimensions,
  validateCheckSubmission,
} from "./check.js";

// --- buildCheckPayload ---

test("buildCheckPayload：text 必填、link 可选（有值时加入）", () => {
  const p = buildCheckPayload("某条消息", "https://example.com");
  expect(p.text).toBe("某条消息");
  expect(p.link).toBe("https://example.com");
});

test("buildCheckPayload：link 为空串时不加入载荷", () => {
  const p = buildCheckPayload("某条消息", "");
  expect(p.text).toBe("某条消息");
  expect("link" in p).toBe(false);
});

test("buildCheckPayload：link 为 null/undefined 时不加入载荷", () => {
  expect("link" in buildCheckPayload("消息", null)).toBe(false);
  expect("link" in buildCheckPayload("消息", undefined)).toBe(false);
});

test("buildCheckPayload：trim 首尾空格", () => {
  const p = buildCheckPayload("  消息  ", "  https://x.com  ");
  expect(p.text).toBe("消息");
  expect(p.link).toBe("https://x.com");
});

// --- validateCheckPayload ---

test("validateCheckPayload：text 有内容 → ok", () => {
  expect(validateCheckPayload({ text: "消息" }).ok).toBe(true);
});

test("validateCheckPayload：text 为空 → not ok，有 reason", () => {
  const r = validateCheckPayload({ text: "" });
  expect(r.ok).toBe(false);
  expect(r.reason).toBeTruthy();
});

test("validateCheckPayload：payload 为 null → not ok", () => {
  expect(validateCheckPayload(null).ok).toBe(false);
});

// --- readKey / saveKey / clearKey ---

test("readKey / saveKey / clearKey 在 fake storage 上正常工作", () => {
  const store = new Map();
  const storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };

  expect(readKey(storage)).toBe("");       // 初始为空
  saveKey(storage, "MY_KEY");
  expect(readKey(storage)).toBe("MY_KEY"); // 存后读得到
  clearKey(storage);
  expect(readKey(storage)).toBe("");       // 清除后为空
});

// --- describeCheckResult ---

test("describeCheckResult：ok=true → success", () => {
  const r = describeCheckResult(true);
  expect(r.kind).toBe("success");
  expect(r.text).toContain("Obsidian");
});

test("describeCheckResult：ok=false → error，可重试", () => {
  const r = describeCheckResult(false);
  expect(r.kind).toBe("error");
  expect(r.text).toContain("重试");
});

// --- fitDimensions（手机端按长边缩放，保字迹优先）---

test("fitDimensions：长边 ≤ maxEdge → 原样返回", () => {
  expect(fitDimensions(1200, 800, 2000)).toEqual({ width: 1200, height: 800 });
});

test("fitDimensions：横图超限 → 等比缩到长边 = maxEdge", () => {
  expect(fitDimensions(4000, 2000, 2000)).toEqual({ width: 2000, height: 1000 });
});

test("fitDimensions：竖图超限 → 按高（长边）缩", () => {
  expect(fitDimensions(1500, 3000, 2000)).toEqual({ width: 1000, height: 2000 });
});

test("fitDimensions：退化输入（0）→ 原样、不崩", () => {
  expect(fitDimensions(0, 0, 2000)).toEqual({ width: 0, height: 0 });
});

// --- validateCheckSubmission（图片/文字/链接至少一项）---

test("validateCheckSubmission：三者全空 → not ok", () => {
  const r = validateCheckSubmission({ text: "", link: "", imageCount: 0 });
  expect(r.ok).toBe(false);
  expect(r.reason).toBeTruthy();
});

test("validateCheckSubmission：仅图片 → ok", () => {
  expect(validateCheckSubmission({ text: "", link: "", imageCount: 1 }).ok).toBe(true);
});

test("validateCheckSubmission：仅文字 → ok", () => {
  expect(validateCheckSubmission({ text: "消息", link: "", imageCount: 0 }).ok).toBe(true);
});

test("validateCheckSubmission：仅链接 → ok", () => {
  expect(validateCheckSubmission({ text: "", link: "https://x.com", imageCount: 0 }).ok).toBe(true);
});

test("validateCheckSubmission：纯空格文字 + 无图 → not ok", () => {
  expect(validateCheckSubmission({ text: "   ", link: "", imageCount: 0 }).ok).toBe(false);
});

test("validateCheckSubmission：text 超 4000 → not ok", () => {
  expect(validateCheckSubmission({ text: "a".repeat(4001), link: "", imageCount: 0 }).ok).toBe(false);
});

test("validateCheckSubmission：link 超 1000 → not ok", () => {
  expect(validateCheckSubmission({ text: "", link: "h".repeat(1001), imageCount: 0 }).ok).toBe(false);
});

test("validateCheckSubmission：图片超 9 张 → not ok", () => {
  expect(validateCheckSubmission({ text: "", link: "", imageCount: 10 }).ok).toBe(false);
});
