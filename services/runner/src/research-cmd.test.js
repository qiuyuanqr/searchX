// services/runner/src/research-cmd.test.js
import { test, expect } from "bun:test";
import { buildResearchPrompt } from "./research-cmd.js";

test("有侧重点 → 带 |", () => {
  expect(buildResearchPrompt({ topic: "稳定币清结算", focus: "清算所角色" }))
    .toBe("/research 稳定币清结算 | 清算所角色");
});

test("无侧重点 → 仅对象", () => {
  expect(buildResearchPrompt({ topic: "CPO", focus: "" }))
    .toBe("/research CPO");
});

test("首尾空白被去掉", () => {
  expect(buildResearchPrompt({ topic: "  X  ", focus: "  y " }))
    .toBe("/research X | y");
});
