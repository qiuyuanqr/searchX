// services/runner/src/index.js
// 一键启动入口：bun run runner。装配真实依赖后跑 runOnce。
// 副作用集中在此（spawn claude / nodemailer / 文件系统 / 网络），不单测——逻辑都在被注入的纯函数里。

import nodemailer from "nodemailer";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, openSync, closeSync, writeSync, statSync } from "fs";
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
// 漏网的新审批由下一个定时 tick 兜底。
// 用 O_EXCL 原子创建锁文件**并立即写入持有者 pid**（占位与标识在同一步内完成），杜绝
// 「mkdir 占位后、写 pid 前的窗口被第二个 runner 误判为残留锁而强占」的 TOCTOU 竞态。
// 回收策略保守——只有「读到一个明确已死的 pid」或「pid 不可读且锁已超 1 小时」才回收，
// 其余（含 pid 刚创建还没读到）一律视为有人持有、本次跳过。
const STALE_MS = 3600_000; // 1h：pid 损坏/没写好的锁，超此年龄才敢回收，兜底永久死锁
function lockFile() {
  return join(homedir(), "Library", "Application Support", "searchx-runner", "runner.lock");
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
// 原子创建锁文件（O_CREAT|O_EXCL）+ 立即写 pid；已被占抛 EEXIST → 返回 false。
function createLockExclusive(path) {
  let fd;
  try { fd = openSync(path, "wx"); } catch (e) { if (e.code === "EEXIST") return false; throw e; }
  try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
  return true;
}
function makeRelease(path) {
  let released = false;
  return () => { if (released) return; released = true; try { rmSync(path, { recursive: true, force: true }); } catch {} };
}
function acquireLock() {
  const path = lockFile();
  mkdirSync(join(path, ".."), { recursive: true });
  if (createLockExclusive(path)) return makeRelease(path);
  // 锁已存在：判定持有者死活（拿不准就当有人在跑，保守跳过）
  let pid = NaN;
  try { pid = parseInt(readFileSync(path, "utf8").trim(), 10); } catch {}
  if (Number.isInteger(pid) && pidAlive(pid)) return null;        // 持有者活着 → 跳过
  let ageMs = 0;
  try { ageMs = Date.now() - statSync(path).mtimeMs; } catch {}
  if (!Number.isInteger(pid) && ageMs < STALE_MS) return null;     // pid 没写好/损坏但锁很新 → 视为刚起的另一轮，跳过
  // 确证持有者已死，或损坏锁已超时 → 回收并原子重建（重建失败=被别人抢先 → 跳过）
  try { rmSync(path, { recursive: true, force: true }); } catch {}
  return createLockExclusive(path) ? makeRelease(path) : null;
}

// 当日完成计数：按「北京时间」分日存一个计数文件，每完成一篇 +1，返回 { date, count }。
// 供作者汇总邮件报「今日累计完成几篇」。纯本地文件、零额外 API。
function bumpDailyCount() {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date()); // YYYY-MM-DD
  const dir = join(homedir(), "Library", "Application Support", "searchx-runner");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `daily-${date}.count`);
  let n = 0;
  try { n = parseInt(readFileSync(file, "utf8").trim(), 10) || 0; } catch {}
  n += 1;
  writeFileSync(file, String(n));
  return { date, count: n };
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
      // 给研究子进程一个「剥掉 RUNNER_* 机密」的环境：PAT / SMTP 密码 / 共享密钥不进这个
      // 全权限（bypassPermissions）会话，缩小提示注入的爆炸半径（它本不需要这些密钥）。
      // 同时打哨兵 SEARCHX_IN_RUNNER=1：让两机 git-sync 钩子在 runner 跑研究期间自动跳过，
      // 避免会话级 pull/push 与 /research Step6 的 push 并发写同一工作树。
      const childEnv = { ...process.env, SEARCHX_IN_RUNNER: "1" };
      for (const k of Object.keys(childEnv)) if (k.startsWith("RUNNER_")) delete childEnv[k];
      const proc = Bun.spawn(["claude", "-p", prompt, ...config.claudeArgs], {
        stdout: "inherit",
        stderr: "inherit",
        stdin: "ignore",
        env: childEnv,
      });
      const code = await proc.exited;
      return code === 0;
    },
    // 部署探活：Step6 push 后 GitHub Actions 才 build+deploy（约 1–2 分钟）；偶发 Pages 5xx
    // 会打掉部署 → 报告子页 404。轮询报告 URL 直到 200（新路径 200 即代表已上线）或超时。
    verifyPublished: async (url) => {
      const DEADLINE_MS = 8 * 60_000, INTERVAL_MS = 15_000;
      const deadline = Date.now() + DEADLINE_MS;
      console.log(`→ 探活（等部署上线，最多 ${DEADLINE_MS / 60000} 分钟）：${url}`);
      for (let n = 1; ; n++) {
        try {
          const res = await fetch(url, { redirect: "follow" });
          if (res.ok) { console.log(`✓ 已确认上线（第 ${n} 次探测 200）`); return true; }
        } catch {}
        if (Date.now() >= deadline) { console.log("✗ 超时未确认上线（疑似 Pages 部署故障）"); return false; }
        await new Promise((r) => setTimeout(r, INTERVAL_MS));
      }
    },
    sendEmail: (msg) => sendEmailImpl(msg, { transport }),
    log: (m) => console.log(m),
    bumpDailyCount,
  });

  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("✗ 未捕获异常：", e);
  process.exit(1);
});
