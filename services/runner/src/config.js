// services/runner/src/config.js
// 从 process.env 读 Runner 配置；缺必填即抛清晰错误（列出所有缺的键）。
// 机密只在本机环境变量 / 未入库的 .env，绝不入库。

const REQUIRED = [
  "RUNNER_GITHUB_TOKEN", // 作者 fine-grained PAT：仅 searchX、Issues 读写
  "RUNNER_WORKER_URL",   // 形如 https://searchx-intake.qiuyuanqr.workers.dev
  "RUNNER_SUB_SECRET",   // 与 Worker secret SUB_READ_SECRET 同值
  "RUNNER_SMTP_USER",    // Gmail 地址
  "RUNNER_SMTP_PASS",    // Gmail 应用专用密码
];

const t = (s) => String(s).trim();                 // 去首尾空白（防粘贴带空格导致静默 401）
const trimUrl = (u) => t(u).replace(/\/+$/, "");    // 去首尾空白 + 尾部斜杠

export function loadRunnerConfig(env) {
  const missing = REQUIRED.filter((k) => !env[k] || !String(env[k]).trim());
  if (missing.length) {
    throw new Error(
      `缺少 Runner 必需环境变量：${missing.join(", ")}（放进未入库的 .env 或 export，绝不入库）`
    );
  }
  return {
    githubToken: t(env.RUNNER_GITHUB_TOKEN),
    workerUrl: trimUrl(env.RUNNER_WORKER_URL),
    subSecret: t(env.RUNNER_SUB_SECRET),
    smtpUser: t(env.RUNNER_SMTP_USER),
    smtpPass: t(env.RUNNER_SMTP_PASS),
    owner: t(env.RUNNER_OWNER || "qiuyuanqr"),
    repo: t(env.RUNNER_REPO || "searchX"),
    authorEmail: t(env.RUNNER_AUTHOR_EMAIL || env.RUNNER_SMTP_USER), // 缺省=发信账号，不在代码里硬写个人邮箱
    siteBase: trimUrl(env.RUNNER_SITE_BASE || "https://qiuyuanqr.github.io/searchX"),
    claudeArgs: (env.RUNNER_CLAUDE_ARGS || "--permission-mode bypassPermissions")
      .split(/\s+/)
      .filter(Boolean),
  };
}
