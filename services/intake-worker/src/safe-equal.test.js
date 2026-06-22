import { test, expect } from "bun:test";
import { safeEqual } from "./safe-equal.js";

test("等长相同 → true", () => expect(safeEqual("abc", "abc")).toBe(true));
test("等长不同 → false", () => expect(safeEqual("abc", "abd")).toBe(false));
test("不等长 → false（不抛）", () => expect(safeEqual("ab", "abc")).toBe(false));
test("非字符串入参被 String 化后比较", () => expect(safeEqual(123, "123")).toBe(true));
test("空串相等", () => expect(safeEqual("", "")).toBe(true));
