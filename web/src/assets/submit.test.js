import { test, expect } from "bun:test";
import { buildPayload, describeResult } from "./submit.js";

test("buildPayload 去空白并带上 turnstile token", () => {
  const p = buildPayload(
    { title: "  比特币挖矿  ", focus: " 能耗 ", email: " a@b.com ", message: "" },
    "TKN"
  );
  expect(p).toEqual({
    title: "比特币挖矿",
    focus: "能耗",
    email: "a@b.com",
    message: "",
    turnstile: "TKN",
  });
});

test("describeResult: ok=true 给成功文案", () => {
  expect(describeResult({ ok: true }).kind).toBe("success");
});

test("describeResult: 已知错误码给对应中文", () => {
  expect(describeResult({ ok: false, error: "turnstile_failed" }).text).toContain("人机验证");
  expect(describeResult({ ok: false, error: "email_rate_limited" }).text).toContain("邮箱");
});

test("describeResult: 未知错误给兜底文案", () => {
  expect(describeResult({ ok: false, error: "weird" }).kind).toBe("error");
  expect(describeResult(null).kind).toBe("error");
});
