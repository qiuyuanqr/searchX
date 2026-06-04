// services/runner/src/index.js
// 一键启动入口：bun run runner。装配真实依赖后跑 runOnce。
// 副作用集中在此（spawn claude / nodemailer / 文件系统 / 网络），不单测——逻辑都在被注入的纯函数里。

import nodemailer from "nodemailer";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { scanResearch } from "../../../web/build/scan.js";
import { loadRunnerConfig } from "./config.js";
import { sendEmail as sendEmailImpl } from "./email.js";
import { runOnce } from "./runner.js";

// —— 全局单实例锁 ——
// 保证「定时器自动跑」与「手机手动触发」永不并发：无论从哪个入口进来（launchd 定时、
// launchctl kickstart 手动、或直接 bun run runner），同一时刻只允许一个 runner 处理队列。
// 已有一轮在跑时本次直接跳过——跳过无损：一次运行会处理完整个 approved 队列，
// 漏网的新审批由下一个定时 tick 兜底。锁目录用 mkdir 原子占位，内含持有者 pid 以回收死锁。
function lockDir() {
  return join(homedir(), "Library", "Application Support", "searchx-runner", "runner.lock");
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
function acquireLock() {
  const lock = lockDir();
  mkdirSync(join(lock, ".."), { recursive: true });
  try {
    mkdirSync(lock); // 原子占位；已存在抛 EEXIST
  } catch {
    let pid = 0;
    try { pid = parseInt(readFileSync(join(lock, "pid"), "utf8").trim(), 10); } catch {}
    if (pid && pidAlive(pid)) return null; // 真有另一轮在跑
    // 残留锁（持有进程已退出）：回收后重占
    try { rmSync(lock, { recursive: true, force: true }); mkdirSync(lock); } catch { return null; }
  }
  writeFileSync(join(lock, "pid"), String(process.pid));
  let released = false;
  return () => { if (released) return; released = true; try { rmSync(lock, { recursive: true, force: true }); } catch {} };
}

async function main() {
  // 必须在仓库根跑（/research 写 research/、Step 6 的 git push 都依赖当前目录）
  if (!existsSync("research") || !existsSync(".git")) {
    console.error("✗ 请在 searchX 仓库根目录运行（缺 research/ 或 .git/）");
    process.exit(1);
  }
  if (!Bun.which("claude")) {
    console.error("✗ 找不到 claude CLI（headless /research 依赖它）");
    process.exit(1);
  }

  // 抢锁：抢不到说明已有一轮在跑 → 干净退出，绝不并发、不重复处理、不撞车
  const release = acquireLock();
  if (!release) {
    console.log("⏭  已有一轮 runner 在运行，本次跳过（它会处理完整个 approved 队列；新审批由下个定时 tick 兜底）。");
    process.exit(0);
  }
  process.on("exit", release);
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));

  let config;
  try {
    config = loadRunnerConfig(process.env);
  } catch (e) {
    console.error("✗ " + e.message);
    process.exit(1);
  }

  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: config.smtpUser, pass: config.smtpPass },
  });

  const summary = await runOnce(config, {
    fetchImpl: fetch,
    scanDirs: () => scanResearch("research"),
    runResearch: async (prompt) => {
      console.log(`→ claude -p ${JSON.stringify(prompt)}`);
      const proc = Bun.spawn(["claude", "-p", prompt, ...config.claudeArgs], {
        stdout: "inherit",
        stderr: "inherit",
        stdin: "ignore",
      });
      const code = await proc.exited;
      return code === 0;
    },
    sendEmail: (msg) => sendEmailImpl(msg, { transport }),
    log: (m) => console.log(m),
  });

  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("✗ 未捕获异常：", e);
  process.exit(1);
});
