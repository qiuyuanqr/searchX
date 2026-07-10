// services/runner/src/alert-cli.js
// 给作者发一封限频报警邮件（同 key 6 小时内最多一封）。
// 用法：bun services/runner/src/alert-cli.js <key> <详情…>   （cwd=仓库根，Bun 自动加载 .env）
// 由 scheduled-run.sh 在 runner 退出码非 0 时调用；probe-cli.js 复用 sendRateLimitedAlert。
// 特意不走 loadRunnerConfig：报警路径依赖越少越好（其它配置缺了不该连累「报警发不出」），
// 只要 SMTP 两件套在就能发。
import nodemailer from "nodemailer";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { shouldAlert, composeAlert } from "./alert.js";

export function stateDir() {
  return join(homedir(), "Library", "Application Support", "searchx-runner");
}
function markerFile(key) {
  return join(stateDir(), `alert-${key}.last`);
}
function readPrev(key) {
  try { return parseInt(readFileSync(markerFile(key), "utf8").trim(), 10); } catch { return NaN; }
}
function writePrev(key, ms) {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(markerFile(key), String(ms));
}
function beijingNow() {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium",
  }).format(new Date());
}

// 发一封限频报警。返回是否真的发了。发送成功才落限频标记：发送失败下一 tick 还会再试。
export async function sendRateLimitedAlert(key, detail) {
  const user = (process.env.RUNNER_SMTP_USER || "").trim();
  const pass = (process.env.RUNNER_SMTP_PASS || "").trim();
  const to = (process.env.RUNNER_AUTHOR_EMAIL || user).trim();
  if (!user || !pass) {
    console.error(`✗ 报警发不出：缺 RUNNER_SMTP_USER / RUNNER_SMTP_PASS（key=${key}，detail=${detail}）`);
    return false;
  }
  const now = Date.now();
  if (!shouldAlert(readPrev(key), now)) {
    console.log(`⏭ 报警限频中（key=${key}，6 小时内已发过），本次不发。detail=${detail}`);
    return false;
  }
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass },
  });
  await transport.sendMail(composeAlert({ key, detail, authorEmail: to, fromEmail: user, when: beijingNow() }));
  writePrev(key, now);
  console.log(`✉️ 已发报警（key=${key}）：${detail}`);
  return true;
}

if (import.meta.main) {
  const [key, ...rest] = process.argv.slice(2);
  if (!key) {
    console.error("用法：bun services/runner/src/alert-cli.js <key> <详情…>");
    process.exit(2);
  }
  try {
    await sendRateLimitedAlert(key, rest.join(" ") || "(无详情)");
  } catch (e) {
    console.error("✗ 报警发送失败：", e.message);
    process.exit(1);
  }
}
