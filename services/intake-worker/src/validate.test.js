// services/intake-worker/src/validate.test.js
import { test, expect } from "bun:test";
import { validateSubmission } from "./validate.js";

const good = { title: "稳定币清结算", focus: "机制", email: "a@b.com", message: "谢谢" };

test("合法输入通过且回 clean", () => {
  const r = validateSubmission(good);
  expect(r.ok).toBe(true);
  expect(r.errors).toEqual([]);
  expect(r.clean.title).toBe("稳定币清结算");
});

test("缺题目/缺邮箱报错", () => {
  expect(validateSubmission({ ...good, title: "   " }).errors).toContain("title_required");
  expect(validateSubmission({ ...good, email: "" }).errors).toContain("email_required");
});

test("邮箱格式非法报错", () => {
  expect(validateSubmission({ ...good, email: "not-an-email" }).errors).toContain("email_invalid");
});

test("超长报错", () => {
  expect(validateSubmission({ ...good, title: "x".repeat(161) }).errors).toContain("title_too_long");
  expect(validateSubmission({ ...good, message: "x".repeat(1001) }).errors).toContain("message_too_long");
});

test("清洗掉控制字符但保留换行", () => {
  const r = validateSubmission({ ...good, focus: "第一行\n第二行坏" });
  expect(r.ok).toBe(true);
  expect(r.clean.focus).toBe("第一行\n第二行坏");
});

test("非字符串字段不抛异常", () => {
  const r = validateSubmission({ title: 123, email: null });
  expect(r.ok).toBe(false);
  expect(r.errors).toContain("title_required");
});
