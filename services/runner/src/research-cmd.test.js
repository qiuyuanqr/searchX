// services/runner/src/research-cmd.test.js
import { test, expect } from "bun:test";
import { buildResearchPrompt } from "./research-cmd.js";

test("有侧重点 → 带 | 与 [轻量]", () => {
  expect(buildResearchPrompt({ topic: "稳定币清结算", focus: "清算所角色" }))
    .toBe("/research 稳定币清结算 | 清算所角色 [轻量]");
});

test("无侧重点 → 仅对象 + [轻量]", () => {
  expect(buildResearchPrompt({ topic: "CPO", focus: "" }))
    .toBe("/research CPO [轻量]");
});

test("首尾空白被去掉", () => {
  expect(buildResearchPrompt({ topic: "  X  ", focus: "  y " }))
    .toBe("/research X | y [轻量]");
});
