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
import { createAttemptsStore } from "./attempts.js";
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

// 结论信号文件：/factcheck 按 prompt 指令把一行结论写到这里，runner 读后随 markDone 上报，
// 回显到手机核查页。与图片临时文件同目录，任一 cleanup 都会连目录一并清掉。
function prepareCheckVerdict(task) {
  const dir = join(tmpdir(), "searchx-check", task.id);
  mkdirSync(dir, { recursive: true });
  const verdictPath = join(dir, "verdict.txt");
  return {
    verdictPath,
    // 只取第一行（防模型多写），读不到返回 null（runOnce 降级为无结论）
    readVerdict: () => {
      try { return readFileSync(verdictPath, "utf8").split("\n")[0].trim(); } catch { return null; }
    },
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
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

// 核查失败（退休）通知邮件：同样不回显核查内容明文，任务 id 不算内容、可带上便于查日志。
function composeCheckFailedNotice({ authorEmail, fromEmail, taskId, maxAttempts }) {
  return {
    from: fromEmail,
    to: authorEmail,
    subject: "【searchX 核查失败】有一条核查任务已停止重试",
    text: [
      `有一条私密核查任务连续失败 ${maxAttempts} 次，已停止重试（任务 ${taskId}）。`,
      "",
      "可在手机核查页重新提交一次；排查原因请看 Mac mini 日志：",
      "~/Library/Logs/searchx-check-runner/check-runner.log",
      "",
      "—— searchX 核查 runner",
    ].join("\n"),
  };
}

// attempts 失败计数的本机持久化：JSON 文件放在与锁文件同目录。
function makeAttemptsStore() {
  const path = join(homedir(), "Library", "Application Support", "searchx-check-runner", "attempts.json");
  mkdirSync(join(path, ".."), { recursive: true });
  return createAttemptsStore({
    load: () => JSON.parse(readFileSync(path, "utf8")), // 文件不存在 / 损坏 → store 内部按空表处理
    save: (map) => writeFileSync(path, JSON.stringify(map)),
  });
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
    markDone: (id, info = {}) =>
      markCheckDone({ workerUrl: config.workerUrl, secret: config.secret, id, ...info }),
    prepareImages: (task) =>
      prepareCheckImages(task, { workerUrl: config.workerUrl, secret: config.secret }),
    prepareVerdict: prepareCheckVerdict,
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
      // 硬超时：claude 挂死会让单实例锁被活进程一直持有，后续 launchd tick 全部跳过、
      // 整条管道停摆。到点先 TERM、宽限 10 秒再 KILL；超时按失败计（attempts 接住、走退休）。
      let timedOut = false;
      const termTimer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch {} }, config.claudeTimeoutMs);
      const killTimer = setTimeout(() => { try { proc.kill(9); } catch {} }, config.claudeTimeoutMs + 10_000);
      const code = await proc.exited;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      if (timedOut) {
        console.log(`✗ 核查超时（${Math.round(config.claudeTimeoutMs / 60_000)} 分钟），已终止 claude 子进程`);
        return 124; // 即使被 TERM 后进程以 0 退出，也按超时失败处理
      }
      return code;
    },
    attempts: makeAttemptsStore(),
    notify: transport
      ? async (_task) => {
          // 邮件正文绝不含核查内容明文（隐私红线）——只提示"去 Obsidian 看"
          const msg = composeCheckDoneNotice({ authorEmail: config.authorEmail, fromEmail: config.smtpUser });
          await sendEmail(msg, { transport });
        }
      : null,
    notifyFailure: transport
      ? async (task) => {
          const msg = composeCheckFailedNotice({
            authorEmail: config.authorEmail,
            fromEmail: config.smtpUser,
            taskId: task.id,
            maxAttempts: config.maxAttempts,
          });
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
