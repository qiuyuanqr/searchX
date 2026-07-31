// services/runner/src/index.js
// 一键启动入口：bun run runner。装配真实依赖后跑 runOnce。
// 副作用集中在此（spawn claude / nodemailer / 文件系统 / 网络），不单测——逻辑都在被注入的纯函数里。

import nodemailer from "nodemailer";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, openSync, closeSync, writeSync, statSync, utimesSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { scanResearch } from "../../../web/build/scan.js";
import { loadRunnerConfig } from "./config.js";
import { buildChildEnv } from "./child-env.js";
import { sendEmail as sendEmailImpl } from "./email.js";
import { runOnce } from "./runner.js";
import { pollUntilOk } from "./verify-published.js";
import { withNetRetry } from "./net-retry.js";
import { writeFileAtomic } from "./atomic-write.js";
import { evaluateLock, formatLockFile, parseLockFile } from "./lock-policy.js";
import { nextQueueStreak, QUEUE_FETCH_CONFIRM_TICKS } from "./alert.js";

// —— 全局单实例锁 ——
// 保证「定时器自动跑」与「手机手动触发」永不并发：无论从哪个入口进来（launchd 定时、
// launchctl kickstart 手动、或直接 bun run runner），同一时刻只允许一个 runner 处理队列。
// 已有一轮在跑时本次直接跳过——跳过无损：一次运行会处理完整个 approved 队列，
// 漏网的新审批由下一个定时 tick 兜底。
// 用 O_EXCL 原子创建锁文件**并立即写入持有者 pid**（占位与标识在同一步内完成），杜绝
// 「mkdir 占位后、写 pid 前的窗口被第二个 runner 误判为残留锁而强占」的 TOCTOU 竞态。
// 回收策略保守——只有「读到一个明确已死的 pid」「pid 不可读且锁已超 1 小时」或「持有者仍判活
// 但锁已超远大于一次合法批次最长耗时的年龄上限」才回收，其余（含 pid 刚创建还没读到）一律
// 视为有人持有、本次跳过。
const HARD_CAP_MS = 8 * 3600_000; // 8h：单实例锁的绝对持有上限（与心跳无关，见 acquireLock 说明）
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
  // 第一行 pid，第二行建锁时刻：心跳会不断刷新 mtime，只有这个 startedAt 能表达「这把锁到底
  // 持有了多久」——没有它，进程「活着但卡死」时锁会被心跳无限续命、永远回收不了。
  try { writeSync(fd, formatLockFile(process.pid, Date.now())); } finally { closeSync(fd); }
  return true;
}
// 释放前核对锁里的 pid 还是不是自己：本进程若已被别人（超龄判定）抢过锁，锁文件里写的是抢锁者
// 的 pid，无条件删就会把仍在跑的那个实例的锁删掉，下一 tick 第三个实例又能进来，并发级联扩散。
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

// 心跳：批次期间周期性刷新锁文件 mtime。锁龄本来只在建锁时定格，而 runOnce 是串行处理整个
// approved 队列的——「单篇 claude 超时 + 30 分钟」这个上限对付得了单篇，对付不了一次审批两三条
// 的合法长批次：批次跑到第二篇时锁龄就越线，下一个 launchd tick 会把仍在跑的实例当成残锁抢走，
// 两个 claude 并发写同一 git 工作树、push 互顶。有心跳后「超龄」才真正只匹配死锁。
// 同时 git-sync.sh 的 6 小时锁龄闸也依赖 mtime 反映「还活着」，否则长批次期间 autopull 会
// 在 claude 正写 research/ 时对同一工作树 pull --rebase --autostash。
function startLockHeartbeat(path, intervalMs = 60_000) {
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
  // 锁已存在：判定持有者死活（拿不准就当有人在跑，保守跳过）
  let pid = NaN, startedAt = NaN;
  try { ({ pid, startedAt } = parseLockFile(readFileSync(path, "utf8"))); } catch {}
  let mtimeMs = NaN;
  try { mtimeMs = statSync(path).mtimeMs; } catch {}
  // 判定逻辑在 lock-policy.js（纯函数、有测试）：四种情形与各自要防的故障见那里的注释。
  // 关键一条：心跳会不断刷新 mtime，「活着但卡死」的进程靠锁龄永远判不出来，只有按建锁
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

// 原始产出目录清单：只走文件系统、不解析 notes.md。
// runner 判「研究有没有产出」必须用这个而不是 scanResearch——后者会把 frontmatter 解析失败的
// 目录整个滤掉，一个 YAML 语法错就让成功的一次研究被判成「未产出」，重跑三次后发一封假停跑信。
// mtimeMs 取 notes.md / report.html 中较新者：上次失败留下同名半成品、这次重跑就地覆写时，
// 目录名没变、diffNewDirs 看不到新增，只能靠「内容是不是本次运行期间写的」认出这次的产出。
function listResearchDirs(root) {
  const DIR_RE = /^\d{4}-\d{2}-\d{2}_/;
  let names = [];
  try { names = readdirSync(root); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!DIR_RE.test(name)) continue;
    try { if (!statSync(join(root, name)).isDirectory()) continue; } catch { continue; }
    let mtimeMs = 0;
    for (const f of ["notes.md", "report.html"]) {
      try { mtimeMs = Math.max(mtimeMs, statSync(join(root, name, f)).mtimeMs); } catch {}
    }
    // hasNotes / parked 让 runner 能区分「scanResearch 为什么没收录这个目录」：
    // 缺 notes.md（半成品，重跑能好）、frontmatter 语法错（重跑修不好，要人工订正）、
    // 被 park（另有分支处理）。不区分就会把三者一律报成「YAML 语法错」并永久停跑。
    out.push({
      dir: name,
      mtimeMs,
      hasNotes: existsSync(join(root, name, "notes.md")),
      parked: existsSync(join(root, name, ".parked")),
    });
  }
  return out;
}

// 「上线待确认」持久队列：研究已 push、但部署探活当轮没通过的条目存这里（本地 JSON）。
// 后续每轮 runner 启动时重新探活，一旦确认上线就自动补发提交者邮件，无需人工盯评论补发。
function pendingFile() {
  return join(homedir(), "Library", "Application Support", "searchx-runner", "pending-publish.json");
}
function loadPending() {
  try {
    const data = JSON.parse(readFileSync(pendingFile(), "utf8"));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}
function savePending(list) {
  const dir = join(homedir(), "Library", "Application Support", "searchx-runner");
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(pendingFile(), JSON.stringify(list, null, 2));
}

// 「连续失败计数」持久状态（issue 号 → 次数）：同一 Issue 连续「研究未产出」的次数，跨 tick
// 存本地 JSON。达 config.maxFailures（默认 3，RUNNER_MAX_FAILURES 可调）即自动贴 done 停跑
// 止损——否则 launchd 每 5 分钟一 tick，持续失败的 Issue 会被每 tick 全额重跑一次 /research。
function failuresFile() {
  return join(homedir(), "Library", "Application Support", "searchx-runner", "research-failures.json");
}
function loadFailures() {
  try {
    const data = JSON.parse(readFileSync(failuresFile(), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}
function saveFailures(map) {
  const dir = join(homedir(), "Library", "Application Support", "searchx-runner");
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(failuresFile(), JSON.stringify(map, null, 2));
}

// 「拉 approved 队列连续失败 tick 数」持久状态（跨 tick，每 tick 是独立进程）：外部瞬时故障
// （GitHub 抽风 / 墙内到 api.github.com 分钟级瞬断）的报警防抖用——推进逻辑见 alert.js
// nextQueueStreak，阈值见 QUEUE_FETCH_CONFIRM_TICKS。读失败一律当 0（宁可晚一 tick 报，不静默漏）。
function queueStreakFile() {
  return join(homedir(), "Library", "Application Support", "searchx-runner", "queue-fetch-streak");
}
function loadQueueStreak() {
  try { return parseInt(readFileSync(queueStreakFile(), "utf8").trim(), 10) || 0; } catch { return 0; }
}
function saveQueueStreak(n) {
  const dir = join(homedir(), "Library", "Application Support", "searchx-runner");
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(queueStreakFile(), String(n));
}

// 「因锁被占而连续跳过」的 tick 数：跳过是 exit 0，不会触发 scheduled-run.sh 的连败报警，
// 于是「持有者活着但卡死」这种永久停摆会完全静默。累计到阈值就以非零码退出，把它变成可见故障。
// 阈值按 launchd 每 5 分钟一 tick 计：36 次 ≈ 3 小时连续被占，远超正常的偶发撞车。
const SKIP_ALERT_TICKS = 36;
function skipStreakFile() {
  return join(homedir(), "Library", "Application Support", "searchx-runner", "lock-skip-streak");
}
function loadSkipStreak() {
  try { return parseInt(readFileSync(skipStreakFile(), "utf8").trim(), 10) || 0; } catch { return 0; }
}
function saveSkipStreak(n) {
  try {
    mkdirSync(join(homedir(), "Library", "Application Support", "searchx-runner"), { recursive: true });
    writeFileAtomic(skipStreakFile(), String(n));
  } catch {}
}
export function nextSkipStreak(prev) {
  const n = Number.isInteger(prev) && prev >= 0 ? prev : 0;
  return n + 1;
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
  writeFileAtomic(file, String(n));
  return { date, count: n };
}

// park 信号：上线前独立核验未过、报告被搁置时，skill 写仓库根 research/.parked.json（不 push）。
// runner 读到就发邮件通知作者 + 评论 + 贴 done；读完即删，杜绝泄漏到本批后续 Issue。
// （skill 在 runner 子进程里被剥掉了 RUNNER_* 机密，发不了信，故由持凭据的 runner 代发。）
function parkFile() {
  return "research/.parked.json"; // 相对仓库根；main() 已确保 cwd 在仓库根
}
function readParkSignal() {
  try {
    const data = JSON.parse(readFileSync(parkFile(), "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch { return null; }
}
function clearParkSignal() {
  try { rmSync(parkFile(), { force: true }); } catch {}
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

  // 先加载 config：抢锁的超龄回收上限要用到 config.claudeTimeoutMs（见下方 acquireLock）。
  let config;
  try {
    config = loadRunnerConfig(process.env);
  } catch (e) {
    console.error("✗ " + e.message);
    process.exit(1);
  }

  // 抢锁：抢不到说明已有一轮在跑 → 干净退出，绝不并发、不重复处理、不撞车。
  // 超龄上限给足余量（claude 超时 + kill 宽限 + push/网络缓冲），远高于任何一次合法批次的真实
  // 耗时，只用来兜断电残留锁被复用 pid 判活的死锁——不会误杀正在跑的长批次。
  const release = acquireLock(config.claudeTimeoutMs + 30 * 60_000);
  if (!release) {
    // 「跳过」本身也要被监控。正常情况下跳过很少见（手动触发撞上定时 tick），而一个卡死却
    // 活着的持有者会让每个 tick 都跳过——若跳过一律 exit 0，scheduled-run.sh 的连败报警
    // 永远达不到阈值，管线永久停摆且零信号。连续跳过够多次即以非零码退出触发报警。
    const n = nextSkipStreak(loadSkipStreak());
    saveSkipStreak(n);
    if (n >= SKIP_ALERT_TICKS) {
      console.error(`✗ 连续 ${n} 个 tick 都因「已有一轮在运行」而跳过（约 ${Math.round((n * 5) / 60)} 小时），疑似锁被卡死的进程占住 → exit 1 报警`);
      process.exit(1);
    }
    console.log(`⏭  已有一轮 runner 在运行，本次跳过（连续第 ${n}/${SKIP_ALERT_TICKS} 次；它会处理完整个 approved 队列，新审批由下个定时 tick 兜底）。`);
    process.exit(0);
  }
  saveSkipStreak(0); // 拿到锁 = 没被占住，清零
  const stopHeartbeat = startLockHeartbeat(lockFile());
  process.on("exit", () => { stopHeartbeat(); release(); });

  // 当前 spawn 的 claude 子进程句柄：SIGTERM/SIGINT 是「裸 kill runner 进程」场景（区别于下面
  // runResearch 内部 termTimer/killTimer 那条超时自杀路径）。没有这层，进程退出只会跑
  // process.on("exit", release) 删锁，但 Bun.spawn 出的 claude 不随父进程退出——锁没了、claude
  // 还在写 research/ 并将 push，下个 tick 新 runner 会对同一 Issue 再 spawn 一次，两边并发写
  // 同一工作树、重复消耗额度、push 互顶。
  let currentChild = null;
  function killChildAndExit(code) {
    if (currentChild) { try { currentChild.kill(9); } catch {} }
    process.exit(code);
  }
  process.on("SIGINT", () => killChildAndExit(130));
  process.on("SIGTERM", () => killChildAndExit(143));

  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: config.smtpUser, pass: config.smtpPass },
  });

  const summary = await runOnce(config, {
    // 瞬时网络抖动（TLS 握手失败等）自动重试 + 单次硬超时，单次失败不打崩整轮、不误报警；
    // 持续故障重试用尽仍抛错 → exit=1 照常报警。
    fetchImpl: withNetRetry(fetch, { log: (m) => console.log(m) }),
    // 查重与卡片元信息用解析过的条目；但**要剔除本地未发布的目录**：被 park 搁置（带 .parked
    // 标记）或半成品目录只存在于本机、从没上过站，拿它当「已有报告」会给提交者回一个 404 链接
    // 并把 Issue 贴 done——那条调研就此永远不会再跑。
    scanDirs: () => scanResearch("research").filter((e) => !existsSync(join("research", e.dir, ".parked"))),
    // 「有没有产出」只看文件系统，不看解析结果（frontmatter 语法错不等于没产出）。
    // mtime 取 notes.md / report.html 里较新的那个，用来识别「重跑覆写了同名目录」。
    listOutputDirs: () => listResearchDirs("research"),
    runResearch: async (prompt) => {
      console.log(`→ claude -p ${JSON.stringify(prompt)}`);
      // 剥机密 + 打 git-sync 哨兵：见 child-env.js（与 check-runner 共用同一套装配）。
      const proc = Bun.spawn(["claude", "-p", prompt, ...config.claudeArgs], {
        stdout: "inherit",
        stderr: "inherit",
        stdin: "ignore",
        env: buildChildEnv(process.env),
      });
      currentChild = proc; // 存句柄：裸 kill runner 进程时 SIGTERM/SIGINT 处理器据此一并杀子进程
      // 硬超时：claude 挂死会让单实例锁被活进程一直持有，后续 launchd tick 全部 exit 0
      // 跳过（不触发 scheduled-run 报警），公开流水线静默停摆。到点先 TERM、宽限 10 秒再
      // KILL；超时按「研究未产出」计入失败退避（连续达阈值自动贴 done 停跑并专信作者）。
      let timedOut = false;
      const termTimer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch {} }, config.claudeTimeoutMs);
      const killTimer = setTimeout(() => { try { proc.kill(9); } catch {} }, config.claudeTimeoutMs + 10_000);
      const code = await proc.exited;
      currentChild = null;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      if (timedOut) {
        console.log(`✗ 研究超时（${Math.round(config.claudeTimeoutMs / 60_000)} 分钟），已终止 claude 子进程`);
        return false;
      }
      return code === 0;
    },
    // 部署探活：Step6 push 后 GitHub Actions 才 build+deploy（约 1–2 分钟）；偶发 Pages 5xx
    // 会打掉部署 → 报告子页 404。轮询报告 URL 直到 200（含单次硬超时，防连接卡死永久占锁）。
    verifyPublished: async (url) => {
      console.log(`→ 探活（等部署上线，最多 8 分钟）：${url}`);
      return pollUntilOk(url, { log: (m) => console.log(m) });
    },
    // 「上线待确认」队列的复探：每 5 分钟一 tick 都会重探一次，没必要每次陪跑到 8 分钟——
    // 迟迟不上线本就会在下一轮再探。给一次远短的时限，省得多条串行叠加拖慢新 Issue 处理。
    verifyPublishedQuick: async (url) => {
      console.log(`→ 复探（待确认队列，最多 20 秒）：${url}`);
      return pollUntilOk(url, { deadlineMs: 20_000, intervalMs: 10_000, perTryMs: 8_000, log: (m) => console.log(m) });
    },
    sendEmail: (msg) => sendEmailImpl(msg, { transport }),
    log: (m) => console.log(m),
    // 查重时效用「北京时间」当天判定，与全项目时间口径一致。
    today: () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date()),
    bumpDailyCount,
    loadPending,
    savePending,
    readParkSignal,
    clearParkSignal,
    loadFailures,
    saveFailures,
  });

  // 拉 approved 队列因外部瞬时故障失败：跨 tick 防抖（同探活）——连续断满 QUEUE_FETCH_CONFIRM_TICKS
  // 个 tick 才判真故障 exit 1 报警（经 scheduled-run→alert-cli，同 key 6 小时限频）；未达阈值 exit 0
  // 静默跳过、下个 tick 自动重试。分钟级墙内网络抖动就此不再误发 runner-failed（2026-07-15/17 教训）。
  // 报警后不清零：靠 exit 1→alert-cli 的 6 小时限频兜住重复，与探活「断则持续累加、通才清零」同构。
  if (summary.queueUnreachable) {
    const streak = nextQueueStreak(loadQueueStreak(), true);
    saveQueueStreak(streak);
    if (streak >= QUEUE_FETCH_CONFIRM_TICKS) {
      console.error(`✗ 拉 approved 队列连续 ${streak} 个 tick 不可达，判为持续故障 → exit 1 报警`);
      process.exit(1);
    }
    console.log(`⏭ 拉 approved 队列网络不可达（连续第 ${streak}/${QUEUE_FETCH_CONFIRM_TICKS} 次，瞬时抖动，本轮静默跳过；达 ${QUEUE_FETCH_CONFIRM_TICKS} 次才报警）`);
    process.exit(0);
  }
  // 正常拉到队列 → 连续失败计数清零（连续语义：偶发抖动不累计，只有真·持续故障才达阈值）
  saveQueueStreak(0);
  if (summary.stateUnwritable) {
    console.error("✗ 本机状态文件写入失败（磁盘满/权限？）——止损闸与待补发队列已不可靠 → exit 1 报警");
    process.exit(1);
  }
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("✗ 未捕获异常：", e);
  process.exit(1);
});
