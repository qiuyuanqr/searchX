#!/usr/bin/env bun
// 看探活历史：各目标的成功率与失败类型分布。
// 用途见 services/runner/src/probe.js 顶部——判断「站点时快时慢」是链路被干扰还是真故障，
// 以及攒够样本后决定要不要把主站从 github.io 迁到自有域名。
//
// 历史落在跑 runner 的那台机器（Mac mini）上，本机通常是空的：
//   ssh mac-mini 'cd ~/Coding/searchX && bun run probe:stats'
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { summarizeProbeLog } from "../services/runner/src/probe.js";

const args = process.argv.slice(2);
const sinceArg = args.indexOf("--since");
const since = sinceArg !== -1 ? args[sinceArg + 1] : null;
const file = process.env.PROBE_LOG_FILE ||
  join(homedir(), "Library", "Application Support", "searchx-runner", "probe-log.jsonl");

let text = "";
try {
  text = readFileSync(file, "utf8");
} catch {
  console.log(`探活历史还没有：${file}`);
  console.log("（本机不跑 runner 就是空的——历史在 Mac mini 上，见本文件顶部注释）");
  process.exit(0);
}

const s = summarizeProbeLog(text, since ? { since } : {});
if (!s.rows) {
  console.log(`探活历史里没有可统计的记录${since ? `（--since ${since} 之后）` : ""}：${file}`);
  process.exit(0);
}

console.log(`📶 探活历史 · ${s.rows} 次采样（${s.from} → ${s.to}）`);
for (const [name, t] of Object.entries(s.targets)) {
  const pct = (t.failRate * 100).toFixed(1);
  const reasons = Object.entries(t.reasons).sort((a, b) => b[1] - a[1]);
  const detail = reasons.length ? reasons.map(([k, v]) => `${k}×${v}`).join(" ") : "无失败";
  console.log(`  ${name.padEnd(9)} 失败率 ${pct.padStart(5)}%（${t.total - t.ok}/${t.total}）  ${detail}`);
}
// 判读提示写在输出里：攒数据的人和当初排查的人可能不是同一次会话。
console.log("");
console.log("判读：tls / reset 占比高 → 链路被干扰（迁到自有域名可解）；");
console.log("      timeout 为主且三个目标同时高 → 出口网络本身的问题；");
console.log("      http-5xx → 对端真故障，与链路无关。");
