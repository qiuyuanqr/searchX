import { test, expect } from "bun:test";
import {
  buildCheckPayload,
  validateCheckPayload,
  readKey,
  saveKey,
  clearKey,
  describeCheckResult,
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
  const r = describeCheckResult(200, true);
  expect(r.kind).toBe("success");
  expect(r.text).toContain("Obsidian");
});

test("describeCheckResult：其它非 2xx → error，可重试", () => {
  const r = describeCheckResult(500, false);
  expect(r.kind).toBe("error");
  expect(r.text).toContain("重试");
});
