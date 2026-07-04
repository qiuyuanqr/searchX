import { test, expect } from "bun:test";
import { buildChildEnv } from "./child-env.js";

test("剥掉 RUNNER_* 与 CHECK_RUNNER_* 两组机密，其余原样保留", () => {
  const env = {
    RUNNER_GITHUB_TOKEN: "pat",
    RUNNER_SMTP_PASS: "gmail-app-pass",
    CHECK_RUNNER_SECRET: "check-secret",
    CHECK_RUNNER_SMTP_USER: "a@b.com",
    PATH: "/usr/bin",
    HOME: "/Users/x",
  };
  const child = buildChildEnv(env);
  expect(Object.keys(child).some((k) => k.startsWith("RUNNER_"))).toBe(false);
  expect(Object.keys(child).some((k) => k.startsWith("CHECK_RUNNER_"))).toBe(false);
  expect(child.PATH).toBe("/usr/bin");
  expect(child.HOME).toBe("/Users/x");
});

test("打上 SEARCHX_IN_RUNNER=1 哨兵（git-sync 钩子据此跳过自动 pull/push）", () => {
  expect(buildChildEnv({}).SEARCHX_IN_RUNNER).toBe("1");
  // 即使外层环境已带别的值也强制为 "1"
  expect(buildChildEnv({ SEARCHX_IN_RUNNER: "0" }).SEARCHX_IN_RUNNER).toBe("1");
});

test("不改动传入的原环境对象", () => {
  const env = { RUNNER_GITHUB_TOKEN: "pat", KEEP: "1" };
  buildChildEnv(env);
  expect(env.RUNNER_GITHUB_TOKEN).toBe("pat");
  expect(env.SEARCHX_IN_RUNNER).toBeUndefined();
});
