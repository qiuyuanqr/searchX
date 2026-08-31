// services/runner/src/probe-cli.js
// 墙内视角探活（跑在 Mac mini，由 scheduled-run.sh 每个 tick 顺带调用）：
// 站点首页 + Worker 主端点 + 备用端点，各带 10s 超时。
// 为什么必须在本机测：GitHub Actions 的探活（.github/workflows/probe.yml）在海外，
// 墙内 SNI 阻断类故障它测不到——2026-07-03 workers.dev 被断、巨轮智能提交静默丢失即此类。
// 报警规则见 alert.js 的 evaluateProbe：连续断满 PROBE_CONFIRM_TICKS 个 tick 才报警——
// 墙内瞬时抖动（断 1~3 tick 即自愈）是常态，单次失败即报只会轰炸邮箱（2026-07-06~09 实测）。
// 连续失败计数跨 tick 落盘（每个 tick 是独立进程）；发信走 alert-cli.js（同 key 6 小时限频）。
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { evaluateProbe, nextStreaks } from "./alert.js";
import { sendRateLimitedAlert, stateDir } from "./alert-cli.js";
import { classifyFetchError, probeLogLine, rollLines } from "./probe.js";

const TIMEOUT_MS = 10_000;

const streakFile = () => join(stateDir(), "probe-streaks.json");
function loadStreaks() {
  try { return JSON.parse(readFileSync(streakFile(), "utf8")); } catch { return {}; }
}
function saveStreaks(s) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(streakFile(), JSON.stringify(s));
  } catch (e) {
    // 写盘持续失败会让计数每 tick 从 1 重来、真故障永远达不到阈值——必须在日志里喊出来
    console.error(`✗ 探活连续失败计数写盘失败（真故障的报警会因此延迟或丢失）：${e.message}`);
  }
}

// 返回 { ok, reason }：ok 仍是报警判定唯一依据（口径一字未动），reason 只喂给历史记录。
// 分开的理由见 probe.js 顶部——「断」有好几种成因，混成一个布尔就没法事后判断该不该迁站。
async function reachable(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
    // 4xx 也算「可达」：链路通，只是请求本身不合法（探活不带凭证）
    return r.status < 500 ? { ok: true, reason: "ok" } : { ok: false, reason: `http-${r.status}` };
  } catch (e) {
    return { ok: false, reason: classifyFetchError(e) };
  }
}

const trim = (u) => (u || "").trim().replace(/\/+$/, "");
const site = trim(process.env.RUNNER_SITE_BASE) || "https://qiuyuanqr.github.io/searchX";
const primary = trim(process.env.RUNNER_WORKER_URL);
const fallback = trim(process.env.RUNNER_WORKER_FALLBACK_URL) || "https://searchx-intake.qiuyuanqr.workers.dev";

const [siteR, primaryR, fallbackR] = await Promise.all([
  reachable(site + "/"),
  primary ? reachable(primary + "/verify") : Promise.resolve({ ok: false, reason: "unconfigured" }),
  reachable(fallback + "/verify"),
]);
const [siteOk, primaryOk, fallbackOk] = [siteR.ok, primaryR.ok, fallbackR.ok];

// 历史记录：只写盘、不参与任何判定。写盘失败照旧只喊一声——监控的记录环节挂了，
// 不能连累探活本身与报警（同 saveStreaks 的处理）。
try {
  const f = join(stateDir(), "probe-log.jsonl");
  let existing = "";
  try { existing = readFileSync(f, "utf8"); } catch { /* 首次探活，无历史 */ }
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(f, rollLines(existing, probeLogLine({
    at: new Date().toISOString(),
    results: { site: siteR.reason, primary: primaryR.reason, fallback: fallbackR.reason },
  })));
} catch (e) {
  console.error(`✗ 探活历史写盘失败（不影响报警判定）：${e.message}`);
}

const streaks = nextStreaks(loadStreaks(), { siteOk, primaryOk });
saveStreaks(streaks);

const verdict = evaluateProbe({
  siteOk, primaryOk, fallbackOk,
  site, primary: primary || "（RUNNER_WORKER_URL 未配置）", fallback,
  streaks,
});
console.log(
  `探活：站点=${siteOk ? "通" : "断"} 主端点=${primaryOk ? "通" : "断"} 备用=${fallbackOk ? "通" : "断"}` +
  (verdict.detail === "全部可达" ? "" : ` → ${verdict.detail}`)
);
// 发信失败不该让探活以未捕获异常裸栈退出——探活本身是监控，监控挂了不能连累主链路的日志可读性。
// 与 alert-cli 的处理保持一致：打一行明确的错误就收工。
if (verdict.alert) {
  try {
    await sendRateLimitedAlert("probe", verdict.detail);
  } catch (e) {
    console.error(`✗ 探活报警发送失败：${e.message}`);
  }
}
