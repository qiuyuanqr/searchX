// services/check-runner/src/index.js
// 核查 runner 装配入口：bun run check-runner。装配真实依赖后跑 runOnce。
// 副作用集中在此（Codex workflow / nodemailer / 文件锁 / 网络），不单测——逻辑都在被注入的纯函数里。

import nodemailer from "nodemailer";
import { mkdirSync, openSync, closeSync, writeSync, writeFileSync, readFileSync, rmSync, statSync, lstatSync, utimesSync, realpathSync } from "fs";
import { join, resolve } from "path";
import { homedir, tmpdir } from "os";
import { loadCheckRunnerConfig } from "./config.js";
import { fetchPendingChecks, markCheckDone, fetchCheckImage, markCheckStart } from "./poll.js";
import { buildBarkRequest, sendBark } from "./bark.js";
import { buildFactcheckPrompt } from "./factcheck-cmd.js";
import { createAttemptsStore } from "./attempts.js";
import { runOnce } from "./runner.js";
import { signalsFromResult } from "./result-signals.js";
import { qcResult } from "./result-qc.js";
import { runWorkflow } from "../../codex-runtime/adapter.js";
import { assertDeliveryConfiguration, assertSafeDirectory, runCodexFactcheck } from "./codex-delivery.js";
import { writeFileAtomic } from "../../runner/src/atomic-write.js";
import { evaluateLock, formatLockFile, parseLockFile } from "../../runner/src/lock-policy.js";
import { sendEmail } from "../../runner/src/email.js";

// —— 全局单实例锁（锁文件与 research runner 不同，两者可并存）——
// 逻辑与 research runner 完全对称，只是锁文件路径和目录不同。
const HARD_CAP_MS = 4 * 3600_000; // 4h：单实例锁的绝对持有上限（与定期更新无关，见 acquireLock 说明）

function lockFile() {
  return join(homedir(), "Library", "Application Support", "searchx-check-runner", "check-runner.lock");
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function createLockExclusive(path) {
  let fd;
  try { fd = openSync(path, "wx"); } catch (e) { if (e.code === "EEXIST") return false; throw e; }
  // 第一行 pid，第二行建锁时刻：运行期间会不断更新锁的时间戳，只有这个 startedAt 能表达「这把锁到底
  // 持有了多久」——没有它，进程「活着但卡死」时锁会被定期更新锁时间戳无限续命、永远回收不了。
  try { writeSync(fd, formatLockFile(process.pid, Date.now())); } finally { closeSync(fd); }
  return true;
}

// 释放前核对锁里的 pid 还是不是自己：本进程若已被别人（超龄判定）抢过锁，锁文件里写的是抢锁者的
// pid，无条件删就会把还在跑的那个实例的锁删掉，下一 tick 第三个实例又能进来，并发级联扩散。
function makeRelease(path) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const owner = parseLockFile(readFileSync(path, "utf8")).pid;
      if (owner !== process.pid) return; // 锁已易主，不是我的，别动
    } catch { return; }
    try { rmSync(path, { recursive: true, force: true }); } catch {}
  };
}

// 定期更新锁时间戳：批次期间周期性刷新锁文件 mtime。锁龄本来只在建锁时定格，而 runOnce 是串行处理整个
// 队列的——一批多条合法任务的总时长轻松超过「单条任务超时 + 余量」这个上限，于是下一个
// launchd tick 会把仍在跑的实例判成超龄残锁抢走，两个实例并发跑 Codex、并发写同一临时目录。
// 有了这个定期更新，「超龄」才真正只匹配死锁（进程没了自然不再刷新）。
function startLockRefresh(path, intervalMs = 60_000) {
  const timer = setInterval(() => {
    try {
      const owner = parseLockFile(readFileSync(path, "utf8")).pid;
      if (owner === process.pid) utimesSync(path, new Date(), new Date());
    } catch {}
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// maxAliveAgeMs：pid 有限，会被 OS 回收复用——断电残留锁若正好被复用给别的常驻进程（甚至
// 常驻 root 进程，pidAlive 把 EPERM 也当活），会让「持有者活着」这条永远成立，锁永久占死、
// 每 tick 静默跳过、无报警。传入远大于一次合法批次最长可能占锁时长的上限，超龄即强制回收；
// 真在跑的合法长批次锁龄远够不到这个上限，不会被误杀。
function acquireLock(maxAliveAgeMs) {
  const path = lockFile();
  mkdirSync(join(path, ".."), { recursive: true });
  if (createLockExclusive(path)) return makeRelease(path);
  let pid = NaN, startedAt = NaN;
  try { ({ pid, startedAt } = parseLockFile(readFileSync(path, "utf8"))); } catch {}
  let mtimeMs = NaN;
  try { mtimeMs = statSync(path).mtimeMs; } catch {}
  // 判定逻辑在 lock-policy.js（纯函数、有测试）：四种情形与各自要防的故障见那里的注释。
  // 关键一条：运行期间会不断更新锁的时间戳，「活着但卡死」的进程靠锁龄永远判不出来，只有按建锁
  // 时刻算的硬上限兜得住——否则每个 tick 静默 exit 0 跳过，管线停摆且零报警。
  const verdict = evaluateLock(
    { pid, startedAt, mtimeMs, alive: Number.isInteger(pid) && pidAlive(pid), now: Date.now() },
    { maxAliveAgeMs, hardCapMs: HARD_CAP_MS }
  );
  if (!verdict.takeover) return null;
  console.log(`↻ 回收锁（判定：${verdict.reason}）`);
  try { rmSync(path, { recursive: true, force: true }); } catch {}
  return createLockExclusive(path) ? makeRelease(path) : null;
}

// 任务 id 会被 join 进临时目录、并且那个目录会被 rm -rf，还会被拼进 Worker 的 URL。
// id 由 Worker 端 crypto.randomUUID 生成，正常形态就是 [0-9a-f-]；但 runner 是照单全收地
// 信任远端返回的字段，一旦拿到 "../../x" 这种，rm -rf 就会删到目录外面去。这里当硬断言处理。
const SAFE_TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
export function assertSafeTaskId(id) {
  if (!SAFE_TASK_ID.test(String(id || ""))) throw new Error(`任务 id 形态非法，拒绝处理：${JSON.stringify(id)}`);
  return id;
}

function taskTmpDir(id) {
  return join(realpathSync(tmpdir()), "searchx-check", assertSafeTaskId(id));
}

function cleanupTaskTmpDir(dir) {
  try {
    assertSafeDirectory(dir); // 不跟随后来出现的目录软链清理别处文件。
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function writeTaskInput(path, bytes) {
  assertSafeDirectory(join(path, ".."));
  try {
    const previous = lstatSync(path);
    if (previous.isSymbolicLink() || !previous.isFile()) throw new Error("核查输入文件含软链或不是普通文件");
    rmSync(path); // 先移除残留普通文件，不能截断可能与别处共享的硬链接。
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
}

function extFromMime(mime) {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "bin";
}

// 把一条任务的图片逐张下载、落成本机临时文件，返回 { imagePaths, parentImagePaths, cleanup }。
// 无图返回空、空 cleanup。本任务的图下载中途出错：先清半成品临时文件，再抛错（runOnce 据此把该条按失败重跑）。
// 补证据重查（task.parentId + parentClaim.imageCount>0）时顺带取父任务的截图落成 prev-<n>.<ext>——
// 父任务是纯截图时这是它唯一的原始内容。父图 404（已过 7 天 TTL）**不算失败**：跳过、返回空的
// parentImagePaths，prompt 会写明「已过期不可用」——按失败重跑只会在同一个 404 上撞 3 次退休；
// 404 之外的错误（超时、5xx）照常抛，任务按失败留待重跑，别把网络抖动写成「已过期」。
async function prepareCheckImages(task, { workerUrl, secret }) {
  const imgs = Array.isArray(task.images) ? task.images : [];
  const pc = task.parentClaim && typeof task.parentClaim === "object" ? task.parentClaim : null;
  const parentCount = task.parentId && pc && Number.isInteger(pc.imageCount) && pc.imageCount > 0 ? pc.imageCount : 0;
  if (!imgs.length && !parentCount) return { imagePaths: [], parentImagePaths: [], cleanup: () => {} };
  const dir = taskTmpDir(task.id);
  const cleanup = () => cleanupTaskTmpDir(dir);
  try {
    assertSafeDirectory(dir, { create: true });
    const imagePaths = [];
    for (let n = 0; n < imgs.length; n++) {
      const { bytes, mime } = await fetchCheckImage({ workerUrl, secret, id: task.id, n });
      const p = join(dir, `${n}.${extFromMime(mime)}`);
      writeTaskInput(p, bytes);
      imagePaths.push(p);
    }
    const parentImagePaths = [];
    if (parentCount) {
      const parentId = assertSafeTaskId(task.parentId);
      for (let n = 0; n < parentCount; n++) {
        let got;
        try {
          got = await fetchCheckImage({ workerUrl, secret, id: parentId, n });
        } catch (err) {
          if (err && err.message === "image 404") {
            console.log(`父任务附图已过期（${parentId} 第 ${n} 张 404），prompt 里写明不可用`);
            continue;
          }
          throw err;
        }
        const p = join(dir, `prev-${n}.${extFromMime(got.mime)}`);
        writeTaskInput(p, got.bytes);
        parentImagePaths.push(p);
      }
    }
    return { imagePaths, parentImagePaths, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// 结果信号文件：/factcheck 按 prompt 指令把整篇笔记（含 frontmatter）原样写到 result.md，runner 读后
// 随 markDone 上报——整篇供详情视图渲染，frontmatter 的 summary 回显成手机列表的一行结论、title 当
// 那行标题。2026-09-17 起原先的 verdict.txt / title.txt 并入这一份（结论与标题本就该是笔记的一部分），
// prompt 少两段指令、少两个"漏写就降级"的口子；旧的两个文件若还被写了（老版本 skill）照旧兜底读。
// 与图片临时文件同目录，任一 cleanup 都会连目录一并清掉。读不到各自降级（结论→空、整篇→null、
// 标题→空），绝不影响核查主流程。
function prepareCheckVerdict(task) {
  const dir = taskTmpDir(task.id);
  assertSafeDirectory(dir, { create: true });
  const resultPath = join(dir, "result.md");
  const legacyVerdictPath = join(dir, "verdict.txt");
  const legacyTitlePath = join(dir, "title.txt");
  const previousPath = join(dir, "previous.md");
  // 先清掉上一轮的残留：runOnce 的 cleanup 在 async finally 里，裸 kill（launchd bootout / 关机）
  // 走 process.exit 会跳过它，信号文件留在原地。下一轮同一任务重跑时若 claude 没写，
  // 读到的就是上一轮的旧全文，被当成本轮结果 markDone 上报。
  for (const p of [resultPath, legacyVerdictPath, legacyTitlePath, previousPath]) {
    try { rmSync(p, { force: true }); } catch {}
  }
  // 补证据重查：父任务整篇（Worker 随 pending 下发）落成 previous.md，prompt 让 skill 读它当前作。
  // 父结果已过期（null）就不写、不给路径——skill 只拿到分隔线内的父任务原始内容。
  let hasPrevious = false;
  if (typeof task.parentResult === "string" && task.parentResult.trim()) {
    writeTaskInput(previousPath, task.parentResult);
    hasPrevious = true;
  }
  const readResult = () => {
    try { return readFileSync(resultPath, "utf8"); } catch { return null; }
  };
  // 只取第一行（防模型多写），读不到返回 null
  const firstLine = (p) => {
    try { return readFileSync(p, "utf8").split("\n")[0].trim(); } catch { return null; }
  };
  return {
    resultPath,
    ...(hasPrevious ? { previousPath } : {}),
    // 一行结论：result.md 的 frontmatter summary 优先；空则兜底读老版本 skill 可能还在写的 verdict.txt
    readVerdict: () => signalsFromResult(readResult()).summary || firstLine(legacyVerdictPath),
    // 整篇原样读，读不到返回 null（runOnce 降级为不回传 result，详情走兜底）
    readResult,
    // 内容标题：frontmatter title 优先，兜底 title.txt；都没有返回 null（前端 fallback 旧摘要）
    readTitle: () => signalsFromResult(readResult()).title || firstLine(legacyTitlePath),
    cleanup: () => cleanupTaskTmpDir(dir),
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
      "可在手机核查页对这条点「再试一次」；排查原因请看 Mac mini 日志：",
      "~/Library/Logs/searchx-check-runner/check-runner.log",
      "",
      "—— searchX 核查 runner",
    ].join("\n"),
  };
}

// 「因锁被占而连续跳过」的 tick 数：跳过是 exit 0、不触发 scheduled-run.sh 的连败报警，
// 于是「持有者卡死」这种永久停摆会完全静默。累计到阈值就以非零码退出，把它变成可见故障。
// launchd 每 5 分钟一 tick，24 次 ≈ 2 小时连续被占。
const SKIP_ALERT_TICKS = 24;
function skipStreakFile() {
  return join(homedir(), "Library", "Application Support", "searchx-check-runner", "lock-skip-streak");
}
function loadSkipStreak() {
  try { return parseInt(readFileSync(skipStreakFile(), "utf8").trim(), 10) || 0; } catch { return 0; }
}
function saveSkipStreak(n) {
  try {
    mkdirSync(join(homedir(), "Library", "Application Support", "searchx-check-runner"), { recursive: true });
    writeFileAtomic(skipStreakFile(), String(n));
  } catch {}
}

// attempts 失败计数的本机持久化：JSON 文件放在与锁文件同目录。
function makeAttemptsStore() {
  const path = join(homedir(), "Library", "Application Support", "searchx-check-runner", "attempts.json");
  mkdirSync(join(path, ".."), { recursive: true });
  return createAttemptsStore({
    load: () => JSON.parse(readFileSync(path, "utf8")), // 文件不存在 / 损坏 → store 内部按空表处理
    save: (map) => writeFileAtomic(path, JSON.stringify(map)),
  });
}

// 已核查完成但回传失败的结果缓存：让下一轮只补 markDone，不重跑 /factcheck（否则 Obsidian
// 里会多出一份重复笔记）。与 attempts 同目录的小 JSON，读写失败一律降级为「没有缓存」。
function makeDoneCache() {
  const path = join(homedir(), "Library", "Application Support", "searchx-check-runner", "pending-done.json");
  mkdirSync(join(path, ".."), { recursive: true });
  const load = () => { try { return JSON.parse(readFileSync(path, "utf8")) || {}; } catch { return {}; } };
  const save = (map) => { try { writeFileAtomic(path, JSON.stringify(map)); } catch {} };
  return {
    get: (id) => load()[id] || null,
    set: (id, payload) => { const m = load(); m[id] = payload; save(m); },
    clear: (id) => { const m = load(); delete m[id]; save(m); },
  };
}

async function main() {
  let config;
  try {
    config = loadCheckRunnerConfig(process.env);
  } catch (e) {
    console.error("✗ " + e.message);
    process.exit(1);
  }

  // 启用门禁、模型档位、库挂载和仓外状态目录必须在取队列之前通过。
  const repoRoot = resolve(import.meta.dir, "../../..");
  try {
    assertDeliveryConfiguration(config, repoRoot);
    for (const [key, fallback] of [["SEARCHX_CODEX_BIN", "codex"], ["SEARCHX_PYTHON_BIN", "python3"], ["SEARCHX_BUN_BIN", "bun"]]) {
      if (!Bun.which(process.env[key] || fallback)) throw new Error(`执行器不可用：${key}`);
    }
  } catch (error) {
    console.error(`✗ Codex 交付启动检查失败：${error.message} → 本轮不取队列`);
    process.exit(1);
  }

  // 超龄上限给足余量（Codex 超时 + kill 宽限 + 网络缓冲），远高于任何一次合法核查任务的真实
  // 耗时，只用来兜断电残留锁被复用 pid 判活的死锁——不会误杀正在跑的长任务。
  const release = acquireLock(config.claudeTimeoutMs + 30 * 60_000);
  if (!release) {
    // 跳过也要被监控：跳过是 exit 0，scheduled-run.sh 的连败报警按退出码统计，于是
    // 「持有者活着但卡死」造成的永久停摆会完全静默（手机上的任务一路 pending 到 7 天 TTL）。
    const n = (loadSkipStreak() || 0) + 1;
    saveSkipStreak(n);
    if (n >= SKIP_ALERT_TICKS) {
      console.error(`✗ 连续 ${n} 个 tick 都因「已有一轮在运行」而跳过，疑似锁被卡死的进程占住 → exit 1 报警`);
      process.exit(1);
    }
    console.log(`⏭  已有一轮核查 runner 在运行，本次跳过（连续第 ${n}/${SKIP_ALERT_TICKS} 次）。`);
    process.exit(0);
  }
  saveSkipStreak(0);
  const stopLockRefresh = startLockRefresh(lockFile());
  process.on("exit", () => { stopLockRefresh(); release(); });

  // 当前 Codex workflow 子进程句柄：SIGTERM/SIGINT 是「裸 kill runner 进程」场景（区别于下面
  // 适配器内部的绝对超时终止路径）。没有这层，进程退出只会跑
  // process.on("exit", release) 删锁，但 Codex workflow 子进程 不随父进程退出。
  let currentChild = null;
  let stopping = false;
  async function killChildAndExit(code) {
    if (stopping) return;
    stopping = true;
    // workflow 的 Python 宿主收到 TERM 后负责回收 Codex 进程组；给它原有的 10 秒宽限。
    const child = currentChild;
    if (child) {
      try { child.kill("SIGTERM"); } catch {}
      let timer;
      const exited = await Promise.race([
        Promise.resolve(child.exited).then(() => true, () => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), 10_000); }),
      ]);
      clearTimeout(timer);
      if (!exited) { try { child.kill("SIGKILL"); } catch {} }
    }
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
    markStart: (id) => markCheckStart({ workerUrl: config.workerUrl, secret: config.secret, id }),
    prepareImages: (task) =>
      prepareCheckImages(task, { workerUrl: config.workerUrl, secret: config.secret }),
    prepareVerdict: prepareCheckVerdict,
    buildPrompt: buildFactcheckPrompt,
    // 旧 prompt 只保留 deps 接口兼容；Codex 仅收到明确 JSON 请求和本任务输入白名单。
    runFactcheck: async (_prompt, context) => runCodexFactcheck(context, config, {
      runWorkflow,
      repoRoot,
      env: process.env,
      onChild: (child) => { currentChild = child; },
      isCancelled: () => stopping,
      log: (message) => console.log(message),
    }),
    attempts: makeAttemptsStore(),
    doneCache: makeDoneCache(),
    qcResult,   // 结果文件轻量质检：问题只进日志（见 runner.js）
    // 通知：邮件（配了 SMTP）+ Bark 推送（配了 CHECK_RUNNER_BARK_URL），各自 best-effort、互不影响。
    // 邮件正文绝不含核查内容明文（隐私红线）——只提示"去看"；Bark 默认同样不带内容，
    // 只有 CHECK_RUNNER_BARK_DETAIL=1 才带内容标题与一行结论（见 bark.js 顶部的取舍说明）。
    notify: transport || config.barkUrl
      ? async (_task, payload = {}) => {
          const errs = [];
          if (transport) {
            try {
              const msg = composeCheckDoneNotice({ authorEmail: config.authorEmail, fromEmail: config.smtpUser });
              await sendEmail(msg, { transport });
            } catch (e) { errs.push(`邮件：${e.message}`); }
          }
          if (config.barkUrl) {
            try {
              await sendBark(buildBarkRequest({ barkUrl: config.barkUrl, outcome: "done", title: payload.title, summary: payload.summary, detail: config.barkDetail, checkPageUrl: config.checkPageUrl }));
            } catch (e) { errs.push(`Bark：${e.message}`); }
          }
          if (errs.length) throw new Error(errs.join("；"));
        }
      : null,
    notifyFailure: transport || config.barkUrl
      ? async (task, payload = {}) => {
          const errs = [];
          if (transport) {
            try {
              const msg = composeCheckFailedNotice({
                authorEmail: config.authorEmail,
                fromEmail: config.smtpUser,
                taskId: task.id,
                maxAttempts: config.maxAttempts,
              });
              await sendEmail(msg, { transport });
            } catch (e) { errs.push(`邮件：${e.message}`); }
          }
          if (config.barkUrl) {
            try {
              await sendBark(buildBarkRequest({ barkUrl: config.barkUrl, outcome: "failed", title: payload.title, detail: config.barkDetail, checkPageUrl: config.checkPageUrl }));
            } catch (e) { errs.push(`Bark：${e.message}`); }
          }
          if (errs.length) throw new Error(errs.join("；"));
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
