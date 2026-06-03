// services/runner/src/research-output.test.js
import { test, expect } from "bun:test";
import { diffNewDirs } from "./research-output.js";

test("返回 after 中新增的目录", () => {
  expect(diffNewDirs(["a", "b"], ["a", "b", "c"])).toEqual(["c"]);
});

test("无新增 → 空数组", () => {
  expect(diffNewDirs(["a"], ["a"])).toEqual([]);
});

test("顺序按 after 保留", () => {
  expect(diffNewDirs([], ["x", "y"])).toEqual(["x", "y"]);
});
