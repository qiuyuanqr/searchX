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

// 查重时效窗口（天）：默认 30；空 / 非法 / 负数都回退默认。股票报告是约 13 周时点快照，
// 30 天内的报告视为"现成可用、不重复调研"，更早的允许重做（行情/基本面多已变动）。
const DEFAULT_DEDUP_WINDOW_DAYS = 30;
function parseDedupWindow(raw) {
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_DEDUP_WINDOW_DAYS;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DEDUP_WINDOW_DAYS;
}

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
    dedupWindowDays: parseDedupWindow(env.RUNNER_DEDUP_WINDOW_DAYS),
    claudeArgs: (env.RUNNER_CLAUDE_ARGS || "--permission-mode bypassPermissions")
      .split(/\s+/)
      .filter(Boolean),
  };
}
