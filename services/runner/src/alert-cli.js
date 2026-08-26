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
import { shouldAlert, composeAlert, classifyFailure, parseAlertArgs } from "./alert.js";

export function stateDir() {
  return join(homedir(), "Library", "Application Support", "searchx-runner");
}
function markerFile(key) {
  return join(stateDir(), `alert-${key}.last`);
}
function readPrev(key) {
  try { return parseInt(readFileSync(markerFile(key), "utf8").trim(), 10); } catch { return NaN; }
}
// 返回是否成功落盘。**绝不抛**：这一步在邮件已经发出去之后，抛出去会被 main 的 catch
// 当成「报警发送失败」（日志谎报），而限频标记又没落上 → 下个 tick 原样再发一封。
// 本项目有过一周 8 封误报轰炸的前科，这条路径必须是「宁可日志吵，也不重复发信」。
function writePrev(key, ms) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(markerFile(key), String(ms));
    return true;
  } catch (e) {
    console.error(`⚠️ 限频标记写盘失败（key=${key}：${e.message}）——报警已发出，但下个 tick 可能重复发。`);
    return false;
  }
}
function beijingNow() {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium",
  }).format(new Date());
}

// 发一封限频报警。返回是否真的发了。发送成功才落限频标记：发送失败下一 tick 还会再试。
// opts.logTail 给了就走结构化正文（类型/关键行/处置/现场日志），见 composeAlert。
export async function sendRateLimitedAlert(key, detail, { logTail = "", logPath = "" } = {}) {
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
  await transport.sendMail(composeAlert({ key, detail, authorEmail: to, fromEmail: user, when: beijingNow(), logTail, logPath }));
  writePrev(key, now);
  // 日志里也带上识别出的类型：翻日志时不必再跟邮件对照。
  const kind = logTail ? `[${classifyFailure(logTail).type}] ` : "";
  console.log(`✉️ 已发报警（key=${key}）：${kind}${detail}`);
  return true;
}

if (import.meta.main) {
  const { key, detail, logPath, logStdin } = parseAlertArgs(process.argv.slice(2));
  if (!key) {
    console.error("用法：bun services/runner/src/alert-cli.js <key> <详情…> [--log-path <完整日志路径>] [--log-stdin]");
    process.exit(2);
  }
  // --log-stdin：本轮日志尾部走管道喂进来（三个 scheduled-run.sh 的失败分支）。
  // isTTY 时不读：手动在终端敲这条命令排障时，读 stdin 会等一个永远不来的输入、看着像卡死；
  // 管道与重定向下 isTTY 都是 false，正常路径不受影响。读不到就退回旧格式，照常发信。
  const logTail = logStdin && !process.stdin.isTTY ? await Bun.stdin.text() : "";
  try {
    await sendRateLimitedAlert(key, detail || "(无详情)", { logTail, logPath });
  } catch (e) {
    console.error("✗ 报警发送失败：", e.message);
    process.exit(1);
  }
}
