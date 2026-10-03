// services/check-runner/src/config.js
// 从 process.env 读 Check Runner 配置；缺必填即抛清晰错误（列出所有缺的键）。
// 机密只在本机环境变量 / 未入库的 .env，绝不入库。

import { homedir } from "os";
import { isAbsolute, join } from "path";

const REQUIRED = [
  "CHECK_RUNNER_WORKER_URL",  // Worker 基址，形如 https://searchx-intake.qiuyuanqr.workers.dev
  "CHECK_RUNNER_SECRET",      // 与 Worker secret CHECK_RUNNER_SECRET 同值
  "CHECK_RUNNER_OBSIDIAN_VAULT", // 宿主交付必须明确真实库根
];

const t = (s) => String(s).trim();
const trimUrl = (u) => t(u).replace(/\/+$/, "");

export function loadCheckRunnerConfig(env) {
  const missing = REQUIRED.filter((k) => !env[k] || !String(env[k]).trim());
  if (missing.length) {
    throw new Error(
      `缺少 Check Runner 必需环境变量：${missing.join(", ")}（放进未入库的 .env 或 export，绝不入库）`
    );
  }
  if (env.SEARCHX_CODEX_DELIVERY_ENABLED !== "1") {
    throw new Error("Codex 交付未启用：必须显式设置 SEARCHX_CODEX_DELIVERY_ENABLED=1，本轮不取队列");
  }
  const codexModel = t(env.SEARCHX_CODEX_MODEL || "gpt-6.1-sol");
  const codexEffort = t(env.SEARCHX_CODEX_EFFORT || "high");
  if (codexModel !== "gpt-6.1-sol" || !["high", "xhigh", "max", "ultra"].includes(codexEffort)) {
    throw new Error("Codex 必须使用 gpt-6.1-sol，推理档位至少 high；拒绝换模型或降级");
  }
  const codexStateRoot = t(env.SEARCHX_CODEX_STATE_ROOT || join(homedir(), "Library", "Application Support", "searchx-codex-jobs"));
  if (!isAbsolute(codexStateRoot) || !isAbsolute(t(env.CHECK_RUNNER_OBSIDIAN_VAULT))) {
    throw new Error("Codex stateRoot 与 CHECK_RUNNER_OBSIDIAN_VAULT 必须为绝对路径");
  }

  // SMTP 可选：全部填写才启用，否则 notify 关闭
  const smtpUser = t(env.CHECK_RUNNER_SMTP_USER || "");
  const smtpPass = t(env.CHECK_RUNNER_SMTP_PASS || "");
  const smtpEnabled = !!(smtpUser && smtpPass);

  return {
    workerUrl: trimUrl(env.CHECK_RUNNER_WORKER_URL),
    secret: t(env.CHECK_RUNNER_SECRET),
    smtpUser,
    smtpPass,
    smtpEnabled,
    authorEmail: t(env.CHECK_RUNNER_AUTHOR_EMAIL || smtpUser),
    // Bark 推送（可选）：CHECK_RUNNER_BARK_URL 形如 https://api.day.app/<device_key>，配了才发。
    // DETAIL=1 才把内容标题与一行结论带进推送（内容会经 Bark 服务器 / APNs 中转，默认不带）；
    // CHECK_PAGE_URL 配了则点推送直达核查页。
    barkUrl: trimUrl(env.CHECK_RUNNER_BARK_URL || ""),
    barkDetail: String(env.CHECK_RUNNER_BARK_DETAIL || "").trim() === "1",
    checkPageUrl: t(env.CHECK_RUNNER_CHECK_PAGE_URL || ""),
    codexModel,
    codexEffort,
    codexStateRoot,
    // 库根必须存在；宿主写入 Factcheck，模型只生成隔离产物。
    obsidianVault: t(env.CHECK_RUNNER_OBSIDIAN_VAULT || ""),
    claudeArgs: (env.CHECK_RUNNER_CLAUDE_ARGS || "--permission-mode bypassPermissions")
      .split(/\s+/)
      .filter(Boolean),
    // 同一任务失败达此次数后退休（不再重试）；非法值回落默认 3
    maxAttempts: (() => {
      const n = parseInt(env.CHECK_RUNNER_MAX_ATTEMPTS, 10);
      return Number.isInteger(n) && n >= 1 ? n : 3;
    })(),
    // 旧字段名仅保留接口兼容；实际限制整个 Codex workflow（含核验）。
    claudeTimeoutMs: (() => {
      const n = parseInt(env.CHECK_RUNNER_TIMEOUT_MINUTES, 10);
      return (Number.isInteger(n) && n >= 1 ? n : 30) * 60_000;
    })(),
  };
}
