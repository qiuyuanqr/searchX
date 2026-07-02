// services/check-runner/src/config.js
// 从 process.env 读 Check Runner 配置；缺必填即抛清晰错误（列出所有缺的键）。
// 机密只在本机环境变量 / 未入库的 .env，绝不入库。

const REQUIRED = [
  "CHECK_RUNNER_WORKER_URL",  // Worker 基址，形如 https://searchx-intake.qiuyuanqr.workers.dev
  "CHECK_RUNNER_SECRET",      // 与 Worker secret CHECK_RUNNER_SECRET 同值
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
    claudeArgs: (env.CHECK_RUNNER_CLAUDE_ARGS || "--permission-mode bypassPermissions")
      .split(/\s+/)
      .filter(Boolean),
    // 同一任务失败达此次数后退休（不再重试）；非法值回落默认 3
    maxAttempts: (() => {
      const n = parseInt(env.CHECK_RUNNER_MAX_ATTEMPTS, 10);
      return Number.isInteger(n) && n >= 1 ? n : 3;
    })(),
    // claude 子进程硬超时（分钟，默认 30）：挂死的子进程会让单实例锁一直被活进程持有、
    // 整条管道停摆，必须有到点强杀。非法值回落默认。
    claudeTimeoutMs: (() => {
      const n = parseInt(env.CHECK_RUNNER_TIMEOUT_MINUTES, 10);
      return (Number.isInteger(n) && n >= 1 ? n : 30) * 60_000;
    })(),
  };
}
