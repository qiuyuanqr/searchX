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

test("齐全 → 返回配置；URL 去尾斜杠；含默认 owner/repo/siteBase/claudeArgs", () => {
  const c = loadRunnerConfig(FULL);
  expect(c.githubToken).toBe("ghp_x");
  expect(c.workerUrl).toBe("https://w.workers.dev");
  expect(c.owner).toBe("qiuyuanqr");
  expect(c.repo).toBe("searchX");
  expect(c.authorEmail).toBe("me@gmail.com"); // 缺省回退到 RUNNER_SMTP_USER
  expect(c.siteBase).toBe("https://qiuyuanqr.github.io/searchX");
  expect(c.claudeArgs).toEqual(["--permission-mode", "bypassPermissions"]);
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
