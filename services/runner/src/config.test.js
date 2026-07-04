// services/runner/src/config.test.js
import { test, expect } from "bun:test";
import { loadRunnerConfig } from "./config.js";

const FULL = {
  RUNNER_GITHUB_TOKEN: "ghp_x",
  RUNNER_WORKER_URL: "https://w.workers.dev/",
  RUNNER_SUB_SECRET: "sek",
  RUNNER_SMTP_USER: "me@gmail.com",
  RUNNER_SMTP_PASS: "app-pass",
};

test("齐全 → 返回配置；URL 去尾斜杠；含默认 owner/repo/siteBase/claudeArgs/dedupWindowDays", () => {
  const c = loadRunnerConfig(FULL);
  expect(c.githubToken).toBe("ghp_x");
  expect(c.workerUrl).toBe("https://w.workers.dev");
  expect(c.owner).toBe("qiuyuanqr");
  expect(c.repo).toBe("searchX");
  expect(c.authorEmail).toBe("me@gmail.com"); // 缺省回退到 RUNNER_SMTP_USER
  expect(c.siteBase).toBe("https://qiuyuanqr.github.io/searchX");
  expect(c.dedupWindowDays).toBe(30); // 默认查重时效窗口 30 天
  expect(c.claudeArgs).toEqual(["--permission-mode", "bypassPermissions"]);
});

test("dedupWindowDays：可被 RUNNER_DEDUP_WINDOW_DAYS 覆盖；空/非法/负数回退 30", () => {
  expect(loadRunnerConfig({ ...FULL, RUNNER_DEDUP_WINDOW_DAYS: "7" }).dedupWindowDays).toBe(7);
  expect(loadRunnerConfig({ ...FULL, RUNNER_DEDUP_WINDOW_DAYS: "0" }).dedupWindowDays).toBe(0);
  expect(loadRunnerConfig({ ...FULL, RUNNER_DEDUP_WINDOW_DAYS: "" }).dedupWindowDays).toBe(30);
  expect(loadRunnerConfig({ ...FULL, RUNNER_DEDUP_WINDOW_DAYS: "abc" }).dedupWindowDays).toBe(30);
  expect(loadRunnerConfig({ ...FULL, RUNNER_DEDUP_WINDOW_DAYS: "-5" }).dedupWindowDays).toBe(30);
});

test("maxFailures：默认 3；可被 RUNNER_MAX_FAILURES 覆盖；空/非法/小于 1 回退 3", () => {
  expect(loadRunnerConfig(FULL).maxFailures).toBe(3); // 默认：连续 3 次研究未产出即停跑止损
  expect(loadRunnerConfig({ ...FULL, RUNNER_MAX_FAILURES: "5" }).maxFailures).toBe(5);
  expect(loadRunnerConfig({ ...FULL, RUNNER_MAX_FAILURES: "1" }).maxFailures).toBe(1);
  expect(loadRunnerConfig({ ...FULL, RUNNER_MAX_FAILURES: "" }).maxFailures).toBe(3);
  expect(loadRunnerConfig({ ...FULL, RUNNER_MAX_FAILURES: "abc" }).maxFailures).toBe(3);
  expect(loadRunnerConfig({ ...FULL, RUNNER_MAX_FAILURES: "0" }).maxFailures).toBe(3); // 0=从不尝试，不合法
  expect(loadRunnerConfig({ ...FULL, RUNNER_MAX_FAILURES: "-2" }).maxFailures).toBe(3);
});

test("claudeTimeoutMs：默认 180 分钟；可被 RUNNER_TIMEOUT_MINUTES 覆盖；空/非法/小于 1 回退默认", () => {
  expect(loadRunnerConfig(FULL).claudeTimeoutMs).toBe(180 * 60_000); // 默认：全力档研究给足余量
  expect(loadRunnerConfig({ ...FULL, RUNNER_TIMEOUT_MINUTES: "120" }).claudeTimeoutMs).toBe(120 * 60_000);
  expect(loadRunnerConfig({ ...FULL, RUNNER_TIMEOUT_MINUTES: "" }).claudeTimeoutMs).toBe(180 * 60_000);
  expect(loadRunnerConfig({ ...FULL, RUNNER_TIMEOUT_MINUTES: "abc" }).claudeTimeoutMs).toBe(180 * 60_000);
  expect(loadRunnerConfig({ ...FULL, RUNNER_TIMEOUT_MINUTES: "0" }).claudeTimeoutMs).toBe(180 * 60_000); // 0=立即杀，不合法
});

test("缺必填 → 抛错且列出缺的键", () => {
  expect(() => loadRunnerConfig({ ...FULL, RUNNER_SMTP_PASS: "" })).toThrow(/RUNNER_SMTP_PASS/);
});

test("可覆盖默认（siteBase 去尾斜杠、claudeArgs 按空白切分）", () => {
  const c = loadRunnerConfig({
    ...FULL,
    RUNNER_SITE_BASE: "https://x.dev/searchX/",
    RUNNER_CLAUDE_ARGS: "--permission-mode acceptEdits",
  });
  expect(c.siteBase).toBe("https://x.dev/searchX");
  expect(c.claudeArgs).toEqual(["--permission-mode", "acceptEdits"]);
});
