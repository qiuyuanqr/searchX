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
import { buildChildEnv } from "../../runner/src/child-env.js";
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

// maxAliveAgeMs：pid 有限，会被 OS 回收复用——断电残留锁若正好被复用给别的常驻进程（甚至
// 常驻 root 进程，pidAlive 把 EPERM 也当活），会让「持有者活着」这条永远成立，锁永久占死、
// 每 tick 静默跳过、无报警。传入远大于一次合法批次最长可能占锁时长的上限，超龄即强制回收；
// 真在跑的合法长批次锁龄远够不到这个上限，不会被误杀。
function acquireLock(maxAliveAgeMs) {
  const path = lockFile();
  mkdirSync(join(path, ".."), { recursive: true });
  if (createLockExclusive(path)) return makeRelease(path);
  let pid = NaN;
  try { pid = parseInt(readFileSync(path, "utf8").trim(), 10); } catch {}
  let ageMs = 0;
  try { ageMs = Date.now() - statSync(path).mtimeMs; } catch {}
  if (Number.isInteger(pid) && pidAlive(pid)) {
    if (ageMs < maxAliveAgeMs) return null;
  } else if (ageMs < STALE_MS) {
    return null;
  }
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

// 结论 + 完整结果 + 内容标题三个信号文件：/factcheck 按 prompt 指令分别写「一行结论」「整篇
// markdown」「一行简短标题」，runner 读后随 markDone 上报（结论回显手机列表 chip、整篇供详情视图
// 渲染、标题当手机列表那行标题）。与图片临时文件同目录，任一 cleanup 都会连目录一并清掉。读不到
// 各自降级（结论→空、整篇→null、标题→null），绝不影响核查主流程。
function prepareCheckVerdict(task) {
  const dir = join(tmpdir(), "searchx-check", task.id);
  mkdirSync(dir, { recursive: true });
  const verdictPath = join(dir, "verdict.txt");
  const resultPath = join(dir, "result.md");
  const titlePath = join(dir, "title.txt");
  return {
    verdictPath,
    resultPath,
    titlePath,
    // 只取第一行（防模型多写），读不到返回 null（runOnce 降级为无结论）
    readVerdict: () => {
      try { return readFileSync(verdictPath, "utf8").split("\n")[0].trim(); } catch { return null; }
    },
    // 整篇原样读，读不到返回 null（runOnce 降级为不回传 result，详情走兜底）
    readResult: () => {
      try { return readFileSync(resultPath, "utf8"); } catch { return null; }
    },
    // 只取第一行（防模型多写），读不到返回 null（runOnce 降级为不带标题，前端 fallback 旧摘要）
    readTitle: () => {
      try { return readFileSync(titlePath, "utf8").split("\n")[0].trim(); } catch { return null; }
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

  let config;
  try {
    config = loadCheckRunnerConfig(process.env);
  } catch (e) {
    console.error("✗ " + e.message);
    process.exit(1);
  }

  // 超龄上限给足余量（claude 超时 + kill 宽限 + 网络缓冲），远高于任何一次合法核查任务的真实
  // 耗时，只用来兜断电残留锁被复用 pid 判活的死锁——不会误杀正在跑的长任务。
  const release = acquireLock(config.claudeTimeoutMs + 30 * 60_000);
  if (!release) {
    console.log("⏭  已有一轮核查 runner 在运行，本次跳过。");
    process.exit(0);
  }
  process.on("exit", release);

  // 当前 spawn 的 claude 子进程句柄：SIGTERM/SIGINT 是「裸 kill runner 进程」场景（区别于下面
  // runFactcheck 内部 termTimer/killTimer 那条超时自杀路径）。没有这层，进程退出只会跑
  // process.on("exit", release) 删锁，但 Bun.spawn 出的 claude 不随父进程退出。
  let currentChild = null;
  function killChildAndExit(code) {
    if (currentChild) { try { currentChild.kill(9); } catch {} }
    process.exit(code);
  }
  process.on("SIGINT", () => killChildAndExit(130));
  process.on("SIGTERM", () => killChildAndExit(143));

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
      // 剥机密（RUNNER_* 与 CHECK_RUNNER_* 一起剥——共用同一个 .env，只剥一组等于白送另一组）
      // + 打 git-sync 哨兵防止子会话钩子把脏工作树推上公开仓：见 child-env.js。
      const proc = Bun.spawn(["claude", "-p", prompt, ...config.claudeArgs], {
        stdout: "inherit",
        stderr: "inherit",
        stdin: "ignore",
        env: buildChildEnv(process.env),
      });
      currentChild = proc; // 存句柄：裸 kill runner 进程时 SIGTERM/SIGINT 处理器据此一并杀子进程
      // 硬超时：claude 挂死会让单实例锁被活进程一直持有，后续 launchd tick 全部跳过、
      // 整条管道停摆。到点先 TERM、宽限 10 秒再 KILL；超时按失败计（attempts 接住、走退休）。
      let timedOut = false;
      const termTimer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch {} }, config.claudeTimeoutMs);
      const killTimer = setTimeout(() => { try { proc.kill(9); } catch {} }, config.claudeTimeoutMs + 10_000);
      const code = await proc.exited;
      currentChild = null;
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
