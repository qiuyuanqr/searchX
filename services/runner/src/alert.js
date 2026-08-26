// services/runner/src/alert.js
// 报警的纯逻辑：限频判定 + 邮件拼装 + 探活结果归纳。发送与文件读写在 alert-cli.js / probe-cli.js。
// 原则：流水线的失败必须到达作者邮箱（否则就是又一处「坏了不吭声」），
// 但 runner 每 5 分钟一个 tick，同一故障不能每 tick 轰一封——同 key 两封之间至少隔 MIN_INTERVAL_MS。

export const MIN_INTERVAL_MS = 6 * 3600_000; // 同类报警最短间隔：6 小时

// 纯函数：这次要不要发？prevMs = 上次发出的时间戳；无记录（NaN/undefined）→ 发。
export function shouldAlert(prevMs, nowMs, minIntervalMs = MIN_INTERVAL_MS) {
  if (!Number.isFinite(prevMs)) return true;
  return nowMs - prevMs >= minIntervalMs;
}

// 认不出类型时的兜底类型名。主题的回退判定与分类兜底共用这一个常量：
// 两处各写一份字面量的话，改了一处忘另一处，主题就会静默变回「未知错误」。
export const UNKNOWN_TYPE = "未知错误";

// 认类型时只看日志末尾这么多行。给得比现场日志宽（关键错误常在结论行前面几十行），
// 又不至于把 claude 跑一整篇调研的输出全扫进来。
export const CLASSIFY_SCAN_LINES = 60;

// 报警邮件里附带的「现场日志」行数：够看清最后发生了什么，又不至于把整轮日志塞进邮件。
export const LOG_TAIL_LINES = 8;

// 纯函数：拼报警邮件。只含运维信息（哪坏了、何时、去哪看日志），绝不含用户私人信息。
// 给了 logTail（本轮日志尾部）就走结构化正文：类型 / 关键错误行 / 怎么处理 / 现场日志，
// 类型同时进主题——手机推送只看得见主题，一眼能判断要不要马上爬起来处理。
// 不给 logTail 则保持旧格式：探活、搁置那些调用方的 detail 本来就写清了原因和处置办法。
export function composeAlert({ key, detail, authorEmail, fromEmail, when, logTail, logPath }) {
  const head = `searchX 半自动流水线自检发现故障（${when} 北京时间）：`;
  const foot = [
    "同类报警至少间隔 6 小时才会再发一封；未收到「恢复」不代表已恢复，请以排查结果为准。",
    "",
    "—— searchX 自检",
  ];

  if (!logTail) {
    const subject = `【searchX 报警·${key}】流水线出问题了`;
    return { from: fromEmail, to: authorEmail, subject, text: [head, "", detail, "", ...foot].join("\n") };
  }

  const { type, summary, hint } = classifyFailure(logTail);
  // 主题里放什么：认出类型就放类型；认不出来时放 detail——写「未知错误」当标题，
  // 比旧版那句「流水线出问题了」信息还少，等于把改造做成了退步（2026-08-26 自审抓到）。
  const subjectTail = type === UNKNOWN_TYPE ? (detail || type) : type;
  // 空行与 bun 报错里的 `^` 指示行不带信息，别占掉本就只有几行的现场预算。
  const tail = redactSecrets(logTail)
    .split("\n")
    .filter((l) => l.trim() && !/^[\s^~]+$/.test(l))
    .slice(-LOG_TAIL_LINES);
  const lines = [
    head,
    "",
    `【错误类型】${type}`,
    `【发生在】  ${detail}`,
    `【关键错误】${summary || "（日志里没找到明确的错误行）"}`,
    `【怎么处理】${hint}`,
    "",
    `【现场日志】（本轮末尾 ${tail.length} 行，已去除机密）`,
    ...tail.map((l) => `  ${l}`),
  ];
  if (logPath) lines.push("", `【完整日志】${logPath}`);
  lines.push("", ...foot);
  return {
    from: fromEmail,
    to: authorEmail,
    subject: `【searchX 报警·${key}】${subjectTail}`,
    text: lines.join("\n"),
  };
}

// 探活报警的连续失败确认阈值：同一目标连续断满这么多个 tick（每 tick 5 分钟，约 20 分钟）
// 才算真故障。为什么不单次即报：墙内到 Cloudflare / GitHub 的链路存在分钟级瞬时抖动
// （2026-07-06~09 实测：一周十余次「断 1~3 个 tick 即自愈」，每次都发了邮件但无一可行动）；
// 真故障（如 2026-07-03 workers.dev 全天 SNI 阻断）远超此阈值，20 分钟报警延迟无实际损失。
export const PROBE_CONFIRM_TICKS = 4;

// 纯函数：推进「连续失败 tick 数」。通 → 清零；断 → +1。历史缺失/损坏一律从零起算。
// 跨 tick 的落盘读写由 probe-cli.js 负责（每个 tick 是独立进程，状态必须落盘才能延续）。
export function nextStreaks(prev, { siteOk, primaryOk }) {
  const base = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
  const p = prev && typeof prev === "object" ? prev : {};
  return {
    site: siteOk ? 0 : base(p.site) + 1,
    primary: primaryOk ? 0 : base(p.primary) + 1,
  };
}

// —— runner 主体「拉 approved 队列」的网络防抖 ——
// 与探活同理：Mac mini（墙内）到 api.github.com 的链路存在分钟级瞬时抖动（2026-07-15、07-17
// 实测：断几分钟即自愈）。拉队列失败若每 tick 都 exit 1 报警就是又一轮误报轰炸——连续断满
// QUEUE_FETCH_CONFIRM_TICKS 个 tick 才判真故障报警，与 PROBE_CONFIRM_TICKS 同量级（约 20 分钟）。
export const QUEUE_FETCH_CONFIRM_TICKS = 4;

// 纯函数：拉队列的错误是否属「外部瞬时故障」（该防抖，而非立即报警）。
// - fetch 自身抛错（连接/TLS/超时）：无 HTTP 响应、无 status → 瞬时（如 07-15 的 TimeoutError）。
// - 拿到响应但 5xx（GitHub 服务端错，如 07-17 返回的错误页 HTML）→ 瞬时。
// - 4xx（401 PAT 失效 / 403 限流 / 404 仓库错配）：配置问题，防抖会掩盖 6 小时 → 立即报警。
export function isTransientQueueError(err) {
  const status = err?.status;
  if (!Number.isFinite(status)) return true;
  return status >= 500;
}

// 纯函数：推进拉队列的「连续失败 tick 数」。失败 +1、成功清零；历史缺失/损坏一律从零起算。
// 跨 tick 的落盘读写由 index.js 负责（每个 tick 是独立进程，状态必须落盘才能延续）。
export function nextQueueStreak(prev, failed) {
  const base = Number.isInteger(prev) && prev > 0 ? prev : 0;
  return failed ? base + 1 : 0;
}

// 纯函数：把一轮墙内探活结果归纳成「要不要报警 + 文案」。
// 规则：站点 / Worker 主端点连续断满 PROBE_CONFIRM_TICKS 个 tick → 报警（主备全挂时额外
// 注明链路已完全断）；未达阈值 → 不报警只留痕（瞬时抖动，见上）。
// 仅备用端点（workers.dev）挂 → 不报警：主链路仍通，且 workers.dev 在墙内间歇被 SNI 阻断
// 是已知常态（2026-07-03 实测），报了也不可行动，只在日志留痕。
// streaks 缺失（旧调用方 / 状态文件读失败）→ 视为已达阈值：报警路径宁多报不静默。
export function evaluateProbe(
  { siteOk, primaryOk, fallbackOk, site, primary, fallback, streaks },
  confirmTicks = PROBE_CONFIRM_TICKS
) {
  const siteStreak = streaks?.site ?? confirmTicks;
  const primaryStreak = streaks?.primary ?? confirmTicks;
  const broken = [];   // 达连续阈值，要报警
  const watching = []; // 断了但未达阈值，只留痕
  if (!siteOk) {
    (siteStreak >= confirmTicks ? broken : watching).push(
      siteStreak >= confirmTicks
        ? `站点首页不可达：${site}（已连续 ${siteStreak} 次探活失败）`
        : `站点首页不可达（连续第 ${siteStreak} 次，连续 ${confirmTicks} 次才报警）：${site}`
    );
  }
  if (!primaryOk) {
    const fullBreak = !fallbackOk ? `；备用端点也不可达：${fallback}（提交链路已完全断）` : "";
    (primaryStreak >= confirmTicks ? broken : watching).push(
      primaryStreak >= confirmTicks
        ? `Worker 主端点不可达：${primary}（已连续 ${primaryStreak} 次探活失败）${fullBreak}`
        : `Worker 主端点不可达（连续第 ${primaryStreak} 次，连续 ${confirmTicks} 次才报警）：${primary}${fullBreak}`
    );
  }
  if (broken.length) return { alert: true, detail: broken.concat(watching).join("\n") };
  if (watching.length) return { alert: false, detail: watching.join("\n") };
  if (!fallbackOk) return { alert: false, detail: `仅备用端点不可达（主链路正常，不报警只留痕）：${fallback}` };
  return { alert: false, detail: "全部可达" };
}

// —— 报警正文：把「本轮日志尾部」读成「错误类型 + 关键行 + 怎么处理」——
// 由来：2026-08-26 的 401 事故，报警邮件全文只有「定时 runner 退出码 1」，真因（GitHub PAT 被
// 重新生成）只躺在 Mac mini 的日志里，每次都得 ssh 上去翻才知道该干什么。更坏的一例是 08-24：
// 邮件报「连续 3 次研究未产出」，而日志里明写着 `OAuth session expired`（claude 登录过期）——
// 笼统的类型会把真因盖掉，所以分类顺序必须「具体根因优先，笼统症状垫底」。

// 纯函数：把日志里可能出现的机密打码。报警邮件走 SMTP 外发，日志片段必须先过这一层。
export function redactSecrets(text) {
  return String(text ?? "")
    .replace(/github_pat_[A-Za-z0-9_]{10,}/g, "github_pat_***")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{10,}/g, "gh*_***")
    .replace(/(Bearer\s+)\S+/gi, "$1***")
    // 只打码「全大写环境变量名 = 值」这一种形态：宽松的大小写不敏感规则会把日志里正常的
    // `key=runner-failed` 也抹掉（连同后面的字），现场日志反而更难读（2026-08-26 自审实测）。
    .replace(/\b([A-Z][A-Z0-9_]*(?:PASS|PASSWORD|SECRET|TOKEN|KEY)\s*[=:]\s*)\S+/g, "$1***");
}

// 最后一条像「错」的行：兜底用，保证认不出类型时给的信息也不比旧版少。
function lastMeaningfulLine(lines) {
  return [...lines].reverse().find((l) => l.trim()) || "";
}

// 关键错误行 = 命中行 + 紧随其后的 JSON 续行。GitHub 的错误体是多行 JSON，命中行往往只到
// `... failed: 401 {`，最有用的 "message": "Bad credentials" 在下一行——只取单行会把它切掉
// （2026-08-26 实测发现：测试夹具把两者写在同一行，所以夹具全绿也看不出来）。
// 只吸收看着像 JSON 片段的续行（引号/花括号/逗号开头），堆栈行那种噪音不要。
const KEY_LINE_MAX = 140;
function keyErrorLine(lines, hitIndex) {
  const parts = [lines[hitIndex].trim()];
  for (let i = hitIndex + 1; i < lines.length && parts.length <= 2; i++) {
    const t = lines[i].trim();
    if (!/^["}\],]/.test(t)) break;
    parts.push(t);
  }
  const joined = parts.join(" ").replace(/\s+/g, " ");
  return joined.length > KEY_LINE_MAX ? joined.slice(0, KEY_LINE_MAX) + "…" : joined;
}

// 已知故障模式表：**从具体到笼统**，命中即返回。顺序是这张表的核心——
// 「研究未产出」「未知错误」这种笼统症状必须垫底，否则会盖住写在同一段日志里的真因
// （2026-08-24 实例：真因 claude 登录过期，邮件却只报「连续 3 次研究未产出」）。
// 状态码一律要求与 `xxx failed:` 同行匹配：探活日志里也会出现裸的 404 / 403，不能误伤。
const FAILURE_PATTERNS = [
  {
    re: /OAuth session expired|Failed to authenticate/i,
    type: "claude 登录过期",
    hint: "无人值守跑不了交互登录。去 Mac mini 上跑一次 claude 重新登录（claude /login），登录后下个 tick 自动恢复。",
  },
  {
    re: /fetch submitter email failed:\s*40[13]/,
    type: "Worker /sub 端点鉴权失败",
    hint: "runner 与 Worker 的共享密钥对不上。核对 .env 的 RUNNER_SUB_SECRET 与 Worker 端 SUB_READ_SECRET 是否一致（与 GitHub token 是两把不同的钥匙）。",
  },
  {
    re: /Bad credentials|(?:list issues|get issue|add label|comment) failed:\s*401/,
    type: "GitHub 凭据失效（HTTP 401）",
    hint: "PAT 被重新生成或已过期。更新 .env 里的 RUNNER_GITHUB_TOKEN——两台机各存一份（MacBook 与 Mac mini），只改一台等于没改；改完不必重启 launchd，下个 5 分钟 tick 自动生效。",
  },
  {
    re: /failed:\s*403[^\n]*(?:rate limit|API rate)/i,
    type: "GitHub 限流（HTTP 403）",
    hint: "调用频次超了，通常一小时内自行恢复，下个 tick 会自动重试。若持续不恢复，查是否有别的程序在用同一个 token 高频调用。",
  },
  {
    re: /failed:\s*403/,
    type: "GitHub 权限不足（HTTP 403）",
    hint: "token 能用但权限不够（改标签/评论需要 Issues 读写）。去 token 设置页确认仓库范围与 Issues 权限。",
  },
  {
    re: /failed:\s*404/,
    type: "GitHub 仓库或路径不对（HTTP 404）",
    hint: "核对 .env 的 RUNNER_OWNER / RUNNER_REPO；仓库改过名、转过私有、或 token 的仓库范围没勾上这个仓库都会是 404。",
  },
  {
    re: /缺少 Runner 必需环境变量|缺 RUNNER_/,
    type: "配置缺失",
    hint: "对应机器的 .env 少了必填项，补齐后下个 tick 自动生效。",
  },
  {
    re: /找不到 claude CLI/,
    type: "找不到 claude CLI",
    hint: "claude 不在 PATH 里或没装。检查 Mac mini 上 ~/.local/bin/claude 是否还在（scheduled-run.sh 已显式补 PATH）。",
  },
  {
    re: /研究超时/,
    type: "研究超时",
    hint: "单篇 /research 超过了时限被终止。题目过大或 claude 卡住都可能，看日志里那篇的输出；连续 3 次会自动停跑止损。",
  },
  {
    re: /因「已有一轮在运行」而跳过/,
    type: "锁疑似被卡死的进程占住",
    hint: "runner.lock 长时间被一个活着但没进展的进程持有。去 Mac mini 看锁文件里的 pid（~/Library/Application Support/searchx-runner/runner.lock），确认无进展后 kill 掉。",
  },
  {
    re: /状态文件写入失败|ENOSPC/,
    type: "本机状态文件写不进去",
    hint: "磁盘满或权限不对，止损计数与待补发队列都会不可靠。先看 Mac mini 的磁盘余量。",
  },
  {
    re: /database is locked/,
    type: "Stocks 库被占（database is locked）",
    hint: "Stocks 侧正在写库、等锁超时。下个 tick 会自动重试；若整天反复出现，查 Stocks 那边有没有长事务。",
  },
  {
    re: /push 失败/,
    type: "git push 失败",
    hint: "内容已在本地提交、没有丢。多为网络或远端拒绝，下个 tick 会重试；持续失败就手动 push 一次看真实报错。",
  },
  {
    re: /研究未产出/,
    type: "研究未产出",
    hint: "claude 跑完了但没落下新报告目录。连续 3 次会自动贴 done 停跑止损，日志里那段 claude 输出是判断根因的地方。",
  },
];

// 纯函数：识别失败类型。返回 { type, summary, hint }。
// type 进邮件主题（手机通知一眼可判）、summary 是日志里那条关键错误行、hint 是处置办法。
// 认不出来也必须给出日志末尾——分类失败时给的信息不能比「只报退出码」的旧版还少。
export function classifyFailure(logTail) {
  const all = String(logTail ?? "").split("\n");
  // 只在末尾这一段里认类型：runner 把 claude 的 stdout 整个 inherit 进日志，一次调研里
  // claude 顺手打印的 `database is locked` / `401` 之类会劫持分类，而本轮真正的失败结论
  // 总在末尾。认不出来仍退回「未知错误」+ 日志末尾，不会比旧版给的少。
  const lines = all.slice(-CLASSIFY_SCAN_LINES);
  for (const { re, type, hint } of FAILURE_PATTERNS) {
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) return { type, summary: redactSecrets(keyErrorLine(lines, i)), hint };
  }
  return {
    type: UNKNOWN_TYPE,
    summary: redactSecrets(lastMeaningfulLine(lines).trim()),
    hint: "没匹配到已知故障模式，请打开完整日志排查。",
  };
}

// 纯函数：拆 alert-cli 的命令行参数。`--log-path <路径>` 指完整日志位置，`--log-stdin` 表示
// 本轮日志尾部从标准输入喂进来（走管道，避免超长参数与 shell 引号地狱）。
// 不带这两个开关时行为与旧版完全一致：剩下的都当详情，老调用方一个字都不用改。
export function parseAlertArgs(argv) {
  const [key, ...rest] = argv;
  const detail = [];
  let logPath = "";
  let logStdin = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--log-stdin") { logStdin = true; continue; }
    if (rest[i] === "--log-path") { logPath = rest[++i] ?? ""; continue; }
    detail.push(rest[i]);
  }
  return { key: key || "", detail: detail.join(" "), logPath, logStdin };
}
