// services/check-runner/src/config.test.js
import { describe, it, expect } from "bun:test";
import { loadCheckRunnerConfig } from "./config.js";

const BASE = {
  CHECK_RUNNER_WORKER_URL: "https://worker.dev",
  CHECK_RUNNER_SECRET: "secret123",
};

describe("loadCheckRunnerConfig", () => {
  it("必填齐全时正常加载", () => {
    const cfg = loadCheckRunnerConfig(BASE);
    expect(cfg.workerUrl).toBe("https://worker.dev");
    expect(cfg.secret).toBe("secret123");
    expect(cfg.smtpEnabled).toBe(false);
    expect(cfg.claudeArgs).toEqual(["--permission-mode", "bypassPermissions"]);
  });

  it("缺 CHECK_RUNNER_WORKER_URL 抛错", () => {
    expect(() => loadCheckRunnerConfig({ CHECK_RUNNER_SECRET: "s" })).toThrow("CHECK_RUNNER_WORKER_URL");
  });

  it("缺 CHECK_RUNNER_SECRET 抛错", () => {
    expect(() => loadCheckRunnerConfig({ CHECK_RUNNER_WORKER_URL: "https://x.dev" })).toThrow("CHECK_RUNNER_SECRET");
  });

  it("两者都缺时错误里都有", () => {
    expect(() => loadCheckRunnerConfig({})).toThrow("CHECK_RUNNER_WORKER_URL");
  });

  it("URL 尾部斜杠被去掉", () => {
    const cfg = loadCheckRunnerConfig({ ...BASE, CHECK_RUNNER_WORKER_URL: "https://worker.dev/" });
    expect(cfg.workerUrl).toBe("https://worker.dev");
  });

  it("SMTP 两个都填时 smtpEnabled=true", () => {
    const cfg = loadCheckRunnerConfig({
      ...BASE,
      CHECK_RUNNER_SMTP_USER: "me@gmail.com",
      CHECK_RUNNER_SMTP_PASS: "pass",
    });
    expect(cfg.smtpEnabled).toBe(true);
    expect(cfg.smtpUser).toBe("me@gmail.com");
  });

  it("SMTP 只填一个时 smtpEnabled=false", () => {
    const cfg = loadCheckRunnerConfig({ ...BASE, CHECK_RUNNER_SMTP_USER: "me@gmail.com" });
    expect(cfg.smtpEnabled).toBe(false);
  });

  it("claudeArgs 可被环境变量覆盖", () => {
    const cfg = loadCheckRunnerConfig({ ...BASE, CHECK_RUNNER_CLAUDE_ARGS: "--dangerously-skip-permissions" });
    expect(cfg.claudeArgs).toEqual(["--dangerously-skip-permissions"]);
  });

  it("authorEmail 缺省同 smtpUser", () => {
    const cfg = loadCheckRunnerConfig({ ...BASE, CHECK_RUNNER_SMTP_USER: "me@gmail.com", CHECK_RUNNER_SMTP_PASS: "p" });
    expect(cfg.authorEmail).toBe("me@gmail.com");
  });

  it("authorEmail 可单独设置", () => {
    const cfg = loadCheckRunnerConfig({
      ...BASE,
      CHECK_RUNNER_SMTP_USER: "me@gmail.com",
      CHECK_RUNNER_SMTP_PASS: "p",
      CHECK_RUNNER_AUTHOR_EMAIL: "author@example.com",
    });
    expect(cfg.authorEmail).toBe("author@example.com");
  });

  it("maxAttempts 默认 3", () => {
    const cfg = loadCheckRunnerConfig(BASE);
    expect(cfg.maxAttempts).toBe(3);
  });

  it("maxAttempts 可被 CHECK_RUNNER_MAX_ATTEMPTS 覆盖", () => {
    const cfg = loadCheckRunnerConfig({ ...BASE, CHECK_RUNNER_MAX_ATTEMPTS: "5" });
    expect(cfg.maxAttempts).toBe(5);
  });

  it("maxAttempts 非法值（非数字 / <1）回落默认 3", () => {
    expect(loadCheckRunnerConfig({ ...BASE, CHECK_RUNNER_MAX_ATTEMPTS: "abc" }).maxAttempts).toBe(3);
    expect(loadCheckRunnerConfig({ ...BASE, CHECK_RUNNER_MAX_ATTEMPTS: "0" }).maxAttempts).toBe(3);
  });
});
