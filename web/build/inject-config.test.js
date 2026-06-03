import { test, expect } from "bun:test";
import { injectConfig } from "./inject-config.js";

test("把 {{KEY}} 占位替换为配置值", () => {
  const out = injectConfig(`a={{WORKER_URL}} b={{TURNSTILE_SITE_KEY}}`, {
    WORKER_URL: "https://w.example.dev",
    TURNSTILE_SITE_KEY: "0xSITEKEY",
  });
  expect(out).toBe("a=https://w.example.dev b=0xSITEKEY");
});

test("未知占位原样保留（避免误删模板里的别的花括号）", () => {
  expect(injectConfig("x={{UNKNOWN}}", { WORKER_URL: "y" })).toBe("x={{UNKNOWN}}");
});
