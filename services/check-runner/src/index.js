// services/check-runner/src/index.js
// 核查 runner 装配入口：bun run check-runner。装配真实依赖后跑 runOnce。
// 副作用集中在此（spawn claude / nodemailer / 文件锁 / 网络），不单测——逻辑都在被注入的纯函数里。

import nodemailer from "nodemailer";
import { mkdirSync, openSync, closeSync, writeSync, writeFileSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { loadCheckRunnerConfig } from "./config.js";
import { fetchPendingChecks, markCheckDone, fetchCheckImage } from "./poll.js";
import { buildFactcheckPrompt } from "./factcheck-cmd.js";
import { runOnce } from "./runner.js";
import { sendEmail } from "../../runner/src/email.js";

// —— 全局单实例锁（锁文件与 research runner 不同，两者可并存）——
// 逻辑与 research runner 完全对称，只是锁文件路径和目录不同。
const STALE_MS = 3600_000;

function lockFile() {
  return join(homedir(), "Library", "Application Support", "searchx-check-runner", "check-runner.lock");
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

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
  let pid = NaN;
  try { pid = parseInt(readFileSync(path, "utf8").trim(), 10); } catch {}
  if (Number.isInteger(pid) && pidAlive(pid)) return null;
  let ageMs = 0;
  try { ageMs = Date.now() - statSync(path).mtimeMs; } catch {}
  if (!Number.isInteger(pid) && ageMs < STALE_MS) return null;
  try { rmSync(path, { recursive: true, force: true }); } catch {}
  return createLockExclusive(path) ? makeRelease(path) : null;
}

function extFromMime(mime) {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "bin";
}

// 把一条任务的图片逐张下载、落成本机临时文件，返回 { imagePaths, cleanup }。
// 无图返回空、空 cleanup。下载中途出错：先清半成品临时文件，再抛错（runOnce 据此把该条按失败重跑）。
async function prepareCheckImages(task, { workerUrl, secret }) {
  const imgs = Array.isArray(task.images) ? task.images : [];
  if (!imgs.length) return { imagePaths: [], cleanup: () => {} };
  const dir = join(tmpdir(), "searchx-check", task.id);
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  try {
    mkdirSync(dir, { recursive: true });
    const imagePaths = [];
    for (let n = 0; n < imgs.length; n++) {
      const { bytes, mime } = await fetchCheckImage({ workerUrl, secret, id: task.id, n });
      const p = join(dir, `${n}.${extFromMime(mime)}`);
      writeFileSync(p, bytes);
      imagePaths.push(p);
    }
    return { imagePaths, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// 核查完成通知邮件：只说"去 Obsidian 查"，绝不回显核查内容细节（隐私红线）。
function composeCheckDoneNotice({ authorEmail, fromEmail }) {
  return {
    from: fromEmail,
    to: authorEmail,
    subject: "【searchX 核查完成】有一条核查任务已完成",
    text: [
      "有一条私密核查任务已经完成。",
      "",
      "结果已保存至本机 Obsidian（Factcheck/ 目录），请在 Obsidian 中查看。",
      "",
      "—— searchX 核查 runner",
    ].join("\n"),
  };
}

async function main() {
  if (!Bun.which("claude")) {
    console.error("✗ 找不到 claude CLI（/factcheck 依赖它）");
    process.exit(1);
  }

  const release = acquireLock();
  if (!release) {
    console.log("⏭  已有一轮核查 runner 在运行，本次跳过。");
    process.exit(0);
  }
  process.on("exit", release);
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));

  let config;
  try {
    config = loadCheckRunnerConfig(process.env);
  } catch (e) {
    console.error("✗ " + e.message);
    process.exit(1);
  }

  let transport = null;
  if (config.smtpEnabled) {
    transport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: config.smtpUser, pass: config.smtpPass },
    });
  }

  const summary = await runOnce(config, {
    fetchPending: () =>
      fetchPendingChecks({ workerUrl: config.workerUrl, secret: config.secret }),
    markDone: (id) =>
      markCheckDone({ workerUrl: config.workerUrl, secret: config.secret, id }),
    prepareImages: (task) =>
      prepareCheckImages(task, { workerUrl: config.workerUrl, secret: config.secret }),
    buildPrompt: buildFactcheckPrompt,
    runFactcheck: async (prompt) => {
      console.log(`→ claude -p ${JSON.stringify(prompt)}`);
      // 剥掉 CHECK_RUNNER_* 机密：核查子进程不需要这些凭据，缩小提示注入爆炸半径。
      const childEnv = { ...process.env };
      for (const k of Object.keys(childEnv)) if (k.startsWith("CHECK_RUNNER_")) delete childEnv[k];
      const proc = Bun.spawn(["claude", "-p", prompt, ...config.claudeArgs], {
        stdout: "inherit",
        stderr: "inherit",
        stdin: "ignore",
        env: childEnv,
      });
      return proc.exited;
    },
    notify: transport
      ? async (_task) => {
          // 邮件正文绝不含核查内容明文（隐私红线）——只提示"去 Obsidian 看"
          const msg = composeCheckDoneNotice({ authorEmail: config.authorEmail, fromEmail: config.smtpUser });
          await sendEmail(msg, { transport });
        }
      : null,
    log: (m) => console.log(m),
  });

  process.exit(summary.fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("✗ 未捕获异常：", e);
  process.exit(1);
});
