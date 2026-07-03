// services/runner/src/probe-cli.js
// 墙内视角探活（跑在 Mac mini，由 scheduled-run.sh 每个 tick 顺带调用）：
// 站点首页 + Worker 主端点 + 备用端点，各带 10s 超时。
// 为什么必须在本机测：GitHub Actions 的探活（.github/workflows/probe.yml）在海外，
// 墙内 SNI 阻断类故障它测不到——2026-07-03 workers.dev 被断、巨轮智能提交静默丢失即此类。
// 报警规则见 alert.js 的 evaluateProbe；发信走 alert-cli.js（同 key 6 小时限频）。
import { evaluateProbe } from "./alert.js";
import { sendRateLimitedAlert } from "./alert-cli.js";

const TIMEOUT_MS = 10_000;

async function reachable(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
    return r.status < 500; // 4xx 也算「可达」：链路通，只是请求本身不合法（探活不带凭证）
  } catch {
    return false;
  }
}

const trim = (u) => (u || "").trim().replace(/\/+$/, "");
const site = trim(process.env.RUNNER_SITE_BASE) || "https://qiuyuanqr.github.io/searchX";
const primary = trim(process.env.RUNNER_WORKER_URL);
const fallback = trim(process.env.RUNNER_WORKER_FALLBACK_URL) || "https://searchx-intake.qiuyuanqr.workers.dev";

const [siteOk, primaryOk, fallbackOk] = await Promise.all([
  reachable(site + "/"),
  primary ? reachable(primary + "/verify") : Promise.resolve(false),
  reachable(fallback + "/verify"),
]);

const verdict = evaluateProbe({
  siteOk, primaryOk, fallbackOk,
  site, primary: primary || "（RUNNER_WORKER_URL 未配置）", fallback,
});
console.log(
  `探活：站点=${siteOk ? "通" : "断"} 主端点=${primaryOk ? "通" : "断"} 备用=${fallbackOk ? "通" : "断"}` +
  (verdict.detail === "全部可达" ? "" : ` → ${verdict.detail}`)
);
if (verdict.alert) await sendRateLimitedAlert("probe", verdict.detail);
