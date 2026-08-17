// Stocks 项目的个股深度调研 → searchX 归档 + 公开站。
//
//   bun run stocks-import              # 增量导入（无人值守默认；只处理没导过的）
//   bun run stocks-import --dry-run    # 只报告要导哪几篇，不落盘
//   bun run stocks-import --since 2026-07-01
//   bun run stocks-import --id 25      # 只导一篇（排障用）
//
// ## 它做什么
//
// Stocks 那边把每份个股调研的 A–M 全文存在 `research_report` 表里（content_md）+ 一份
// 结构化摘要（summary_json：方向/置信度/驱动/风险/验证信号/三情景/操作提示）。本脚本：
//   1. **只读**查库（PRAGMA query_only=1，见下方对 mode=ro 的说明）；
//   2. 过一遍系统参数过滤器（src/sanitize.js）——这是本脚本存在的主要原因；
//   3. 按 searchX 的三件套产出 report.html / notes.md / sources.md，并往 INDEX.md 插行；
//   4. 有 Obsidian 库在位就顺手落一份中文名全文笔记（复用 scripts/report-to-obsidian.js）。
//
// ## 幂等怎么做的
//
// 不另存状态文件，**以归档目录本身为准**：每篇 notes.md 的 frontmatter 里写
// `stocks_report_id: <id>`，启动时扫一遍 research/ 收集已导过的 id。这样删掉目录＝允许重导，
// 手工改名/挪动也不会失配，不存在"状态文件与磁盘打架"这一类故障。
//
// ## 为什么查库不用 mode=ro
//
// CLAUDE.md 记着这条教训：`?mode=ro` 在这个 WAL 库上常态打不开（真实查询报错 14），
// 而 `SELECT 1` 不碰数据页照样成功，用它试连会得到"库能用"的假象。这里改用连接级
// 只读（PRAGMA query_only=1）——**保证弱一层**（打开级 vs 连接级），代价写在这里：
// 它拦得住本进程的写语句，拦不住"以读写方式打开"这件事本身。本脚本只跑 SELECT。

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { sanitize } from "./sanitize.js";
import { mdToHtml, escapeHtml, inline } from "./md-to-html.js";
import { metaOf, exchangeOf } from "./mapping.js";
import { buildSectorSql, groupSectorRows, pickConcepts, suggestBoards } from "./sectors.js";
import {
  pickOneLiner, pickMainBusiness, pickLinks, pickDate, pickTextSources,
  classifySource, SRC_CLASS, pickGlossary,
} from "./extract.js";

const REPO = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const ARCHIVE = join(REPO, "research");
const TEMPLATE = join(REPO, ".claude/skills/research/templates/report.html");
const OBSIDIAN_CONVERTER = join(REPO, "scripts/report-to-obsidian.js");

// 活库路径。装到别处时用环境变量覆盖，不要改这里的字面量。
const STOCKS_DB = process.env.STOCKS_DB || `${process.env.HOME}/Coding/Stocks/data/stocks.db`;
const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT || "/Volumes/SS_SSD/obsidian";

// ========== 查库 ==========

// 用 sqlite3 CLI 而不是 bun:sqlite：后者的 readonly 走的是 SQLITE_OPEN_READONLY，
// 与 mode=ro 同一个毛病（WAL 库上打不开）。CLI + query_only 是本仓库已验证可用的通道。
// 一行一条 JSON：content_md 里的换行被 json_object 转义成 \n，不会撑破行边界。
function queryReports() {
  const sql = `PRAGMA query_only=1;
SELECT json_object(
  'id', r.id, 'ts_code', r.ts_code, 'generated_at', r.generated_at,
  'name', COALESCE(b.name, r.ts_code),
  'content_md', r.content_md, 'summary_json', r.summary_json)
FROM research_report r
LEFT JOIN stock_basic b ON b.ts_code = r.ts_code
ORDER BY r.generated_at ASC, r.id ASC;`;
  const out = execFileSync("sqlite3", [STOCKS_DB, sql], {
    encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
  });
  return out.split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l));
}

// 申万行业 + 同花顺概念，一条 SQL 查全部票（不做 N+1）。
// **查不到不阻断导入**：这两项是展示增强，缺了报告照样发，与 mapping 查表失败
// 一样走「降级不阻断上线」。库结构变了 / 表被改名，也只该少两行展示，不该拦住报告。
function querySectors(codes) {
  const sql = buildSectorSql(codes, exchangeOf);
  if (!sql) return {};
  try {
    const out = execFileSync("sqlite3", [STOCKS_DB, sql], {
      encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    });
    return groupSectorRows(
      out.split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l))
    );
  } catch (e) {
    log(`⚠️ 申万行业与概念标签查库失败（${String(e.message).split("\n")[0]}），本轮这两项不展示`);
    return {};
  }
}

// ========== 幂等：已导过哪些 ==========

export function importedIds(archiveRoot) {
  const ids = new Set();
  if (!existsSync(archiveRoot)) return ids;
  for (const dir of readdirSync(archiveRoot)) {
    const notes = join(archiveRoot, dir, "notes.md");
    if (!existsSync(notes)) continue;
    const m = readFileSync(notes, "utf8").match(/^stocks_report_id:\s*(\d+)\s*$/m);
    if (m) ids.add(Number(m[1]));
  }
  return ids;
}

// ========== 组装 ==========

// generated_at（库里是北京时间的朴素 ISO）→ 日期 / 带时区的 created
export function splitTime(generatedAt) {
  const s = String(generatedAt).trim();
  const date = s.slice(0, 10);
  const time = s.length > 10 ? s.slice(11, 19) : "00:00:00";
  return { date, created: `${date}T${time}+0800` };
}

// 首页卡片的导语 = notes.md 的「## 一句话结论」段。格式按 stock SKILL 钉死的写法：
// 第一句给方向（首页据此提炼 ↗/↘/↔），冒号后接差异化理由，再补风险。
// 全部零件来自报告自己的 summary_json 与 A 节原句，不新造判断。
export function buildTldr({ direction, confidence, oneLiner, drivers, risks }) {
  // ⚠️ 置信度不能紧跟在方向后面写成括号。web/build/extract-direction.js 认
  // 「震荡（xxx）」这种带括号的方向短语并把括号内容并进徽章，首页会渲染成
  // 「↔ 震荡·置信度中」——徽章位塞了一段与方向无关的话。用顿号分开即可。
  const dir = `未来约 13 周方向${direction}、置信度${confidence}`;
  const why = oneLiner ? `：${oneLiner.replace(/[。.]$/, "")}。` : "。";
  const d = (drivers || []).slice(0, 3).join("；");
  const r = (risks || []).slice(0, 3).join("；");
  let s = dir + why;
  if (d) s += `支撑在于${d}。`;
  if (r) s += `主要风险是${r}。`;
  return s;
}

// ========== 价位红线的逐条改写 ==========
//
// 本站对股票报告有一条硬规矩（stock SKILL §4.9 / §6，scripts/research-qc.js 机器把关）：
// **操作触发条件与情景走势里不得出现具体价位**——写「跌破 5.50 元」等于变相给目标价。
// Stocks 那边的 summary_json 里有几处踩线，逐条列在这里改写，**只把价位换成它在原文里
// 本来就有的定性锚**（分位筹码成本、基准日收盘价、回购方案上限），不改判断、不改方向。
// 列成明表而不是写个通用正则：改的是别人报告里的字，每一处都该看得见、可复核。
// 新报告若出现新的踩线，会被每日任务的 QC 闸拦下并搁置（.parked），不会静默上线。
// 每条都写清「删掉的那个数字在原文里对应哪个定性锚」——因为改的是别人报告里的字，
// 读者与复核者都该能一眼看出改动没有改变判断。
const PRICE_REDLINE_FIXES = [
  // ① summary_json（→ notes.md）
  { id: 5, from: "跌破93.86元", to: "跌破基准日收盘价", why: "93.86 元即本篇基准日（2026-07-31）收盘价，原文 B 节已列明" },
  { id: 14, from: "回测6月17日曾出现的28.26元一线", to: "回测 6 月 17 日曾出现的低点一线", why: "去掉预测性价位，保留同一时点锚" },
  { id: 16, from: "回落至公司回购方案上限60元/股以下", to: "回落至公司回购方案的价格上限以下", why: "上限数值属公司披露、正文已列；此处是待观察信号，不重复价位" },
  { id: 25, from: "跌破5.50元后向PB1.3~1.4倍寻找支撑", to: "跌破 15% 分位筹码成本后向 PB 1.3~1.4 倍寻找支撑", why: "5.50 元即原文所述 15% 分位筹码成本" },
  // ② 正文（→ report.html）。改的都是 K 节走势 / L 节触发 / I 节待观察信号里的价位，
  //    而「这个价位是多少」在同一篇的事实段里原样保留，信息没丢。
  {
    id: 14, from: "股价回测 2026-06-17 曾出现的 28.26 元一线（该价为旧快照，仅作参考锚点）",
    to: "股价回测 2026-06-17 曾出现的低点一线（该低点为旧快照，仅作参考锚点）",
    why: "K 节悲观路径不给具体价位；28.26 元作为历史快照仍在 H 节原样保留",
  },
  {
    id: 16, from: "意味着回购在股价回落到 60 元以下之前无法继续执行",
    to: "意味着回购在股价回落至该上限以下之前无法继续执行",
    why: "上一句刚写明「回购方案上限 60 元/股」，此处指代即可",
  },
  {
    id: 16, from: "在股价回落到 60 元以下之前，这份回购方案实际上无法继续执行。",
    to: "在股价回落至该回购价格上限以下之前，这份回购方案实际上无法继续执行。",
    why: "同上，同段已列明上限数值",
  },
  {
    id: 16, from: "（若股价已回落至 60 元以下，回购能否恢复执行是可核验的公司态度信号）",
    to: "（若股价已回落至回购价格上限以下，回购能否恢复执行是可核验的公司态度信号）",
    why: "I 节 W13 待观察信号，不需要复述价位",
  },
  {
    id: 23, from: "跌破库内资金筹码给出的 85% 分位筹码成本 = 70.20 元**（2026-08-07 筹码口径）",
    to: "跌破库内资金筹码给出的 85% 分位筹码成本**（2026-08-07 筹码口径，具体刻度见 H 节）",
    why: "L 节操作触发条件不给具体价位；70.20 元在 H 节筹码分布里原样保留",
  },
];

export function applyPriceFixes(obj, reportId) {
  const fixes = PRICE_REDLINE_FIXES.filter((f) => f.id === reportId);
  if (!fixes.length) return { value: obj, applied: [] };
  const applied = [];
  const walk = (v) => {
    if (typeof v === "string") {
      let s = v;
      for (const f of fixes) {
        if (s.includes(f.from)) { s = s.split(f.from).join(f.to); applied.push(f.from); }
      }
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return { value: walk(obj), applied };
}

function fm(list) {
  return `[${list.map((s) => JSON.stringify(s)).join(", ")}]`;
}

export function buildNotes({ meta, summary, tldr, oneLiner, sourceCount, dir }) {
  const boards = meta.boards.map((b) => `[[${b}]]`);
  const tags = ["research", "股票", meta.name, meta.code, ...meta.boards];
  const sc = summary.scenarios || {};
  const scenarioRow = (label, key) => {
    const s = sc[key];
    if (!s) return "";
    return `- **${label}**｜触发：${s.trigger}｜路径：${s.path}\n`;
  };
  return `---
date: ${meta.date}
created: ${meta.created}
type: 股票
tags: ${fm(tags)}
related: ${fm(boards)}
${meta.industry ? `sw_industry: ${JSON.stringify(meta.industry)}\n` : ""}${(meta.concepts || []).length ? `concepts: ${fm(meta.concepts)}\n` : ""}source_count: ${sourceCount}
archive: "research/${dir}/"
source_system: stocks
stocks_report_id: ${meta.reportId}
---

# ${meta.title}

## 一句话结论

${tldr}

## 核心驱动

${(summary.drivers || []).map((d) => `- ${d}`).join("\n")}

## 核心风险

${(summary.risks || []).map((d) => `- ${d}`).join("\n")}

## 三情景（K）

${scenarioRow("乐观", "optimistic")}${scenarioRow("基准", "base")}${scenarioRow("悲观", "pessimistic")}
## 最该盯的验证信号

${(summary.verify_signals || []).map((d) => `- ${d}`).join("\n")}

## 操作触发条件（条件式，不含具体价位）

${summary.action_hint || "（本篇未给出条件式操作提示）"}

## 出处与局限

- 本篇是**个股深度投研档案**，全文见同目录 report.html；判断口径为「未来约 13 周」，不给目标价、不给买卖评级，操作一律条件式。
- 行情 / 估值 / 财务基准数字取自本地行情库（信息截止 ${meta.date}），政策、产业链、预期差、事件时点四类为联网补充并逐条标注来源。
- 报告随时间失效：所有"当前""目前"类表述均以信息截止日为准，此后的变化未反映在本文中。
`;
}

export function buildSources({ meta, links, textSources }) {
  const groups = new Map();
  for (const l of links) {
    const kind = classifySource(l.text, l.url);
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(l);
  }
  const order = ["监管", "披露", "研究", "媒体", "社区"];
  const body = order
    .filter((k) => groups.has(k))
    .map((k) => {
      const rows = groups.get(k).map((l) => {
        const d = pickDate(l.text);
        return `- [${k}] ${l.text} — ${l.url}${d ? ` — ${d}` : ""}`;
      });
      return `## ${k}\n\n${rows.join("\n")}\n`;
    })
    .join("\n");
  const textBlock = textSources.length
    ? `\n## 正文以文字标注、未附链接的出处\n\n${textSources.map((s) => `- ${s}`).join("\n")}\n`
    : "";
  const empty = !body && !textBlock
    ? "（本篇正文未引用外部来源：结论全部建立在库内行情 / 财务数据上。）\n" : "";
  return `# 来源清单 · ${meta.title}

> 信息截止日期：${meta.date}（北京时间）
> 行情 / 估值 / 财务基准数据取自本地行情库；本清单只列报告正文引用过的**联网来源**。
> 排序：按可信度优先级（监管 → 披露 → 研究 → 媒体 → 社区）。

${body}${textBlock}${empty}`;
}

export function buildReportHtml({ template, meta, summary, tldr, bodyHtml, links, textSources, plain, glossary }) {
  const linkRows = links.map((l) => {
    const kind = classifySource(l.text, l.url);
    const d = pickDate(l.text);
    return `<li><span class="src-tag ${SRC_CLASS[kind]}">${kind}</span> <a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.text)}</a>${d ? ` <em>${d}</em>` : ""}</li>`;
  });
  // 文字出处没有链接可点，但仍是可追溯线索——照样列进清单，并标明「未附链接」。
  const textRows = textSources.map((t) => {
    const kind = classifySource(t, "");
    const d = pickDate(t);
    return `<li><span class="src-tag ${SRC_CLASS[kind]}">${kind}</span> ${escapeHtml(t)}${d ? ` <em>${d}</em>` : ""} — 原文以文字标注出处，未附链接</li>`;
  });
  const sources = [...linkRows, ...textRows].join("\n      ");
  const findings = (summary.drivers || []).map((d) => `<li>${inline(d)}</li>`).join("\n      ");
  const risks = (summary.risks || []).map((d) => `<li>${inline(d)}</li>`).join("\n      ");
  const glossaryHtml = glossary.length
    ? `<section class="glossary"><h2>名词小抄</h2><dl>${glossary
        .map(([t, d]) => `<dt>${escapeHtml(t)}</dt><dd>${escapeHtml(d)}</dd>`)
        .join("")}</dl></section>`
    : "";
  // 报头的三个标签维度性质不同，分开陈述：
  //   关联板块 = 作者自己的五大关注框架（人工判断）
  //   申万行业 = 客观唯一的行业归属（库里只有二级，见 sectors.js）
  //   概念标签 = 市场热点标记，已剔除交易属性类噪音并按特异度排序
  // 概念那行独占一整行（flex-basis:100%）：它比另两项长得多，混排会把报头挤乱。
  // inline style 是允许的——报告页 CSP 为 `style-src 'unsafe-inline'`。
  const boards = [
    meta.boards.length ? `<span><b>关联板块</b> ${escapeHtml(meta.boards.join(" · "))}</span>` : "",
    meta.industry ? `<span><b>申万行业</b> ${escapeHtml(meta.industry)}</span>` : "",
    (meta.concepts || []).length
      ? `<span style="flex-basis:100%"><b>概念标签</b> ${escapeHtml(meta.concepts.join(" · "))}</span>`
      : "",
  ].filter(Boolean).join("\n      ");
  const limitation = `<div class="limitation">本篇为个股深度投研档案，判断口径「未来约 13 周」，<b>不给目标价、不给买卖评级</b>，操作倾向一律为可核验的条件式表述。行情 / 估值 / 财务基准数字取自本地行情库（信息截止 ${meta.date}），政策、产业链、预期差、事件时点四类为联网补充并逐条标注来源与日期；两者在正文中严格分开陈述。报告随时间失效——文中"当前""目前"均以信息截止日为准。</div>`;

  // 模板开头那段「填充说明」注释里本身就写着 {{TITLE}} / {{TOKEN}} 等占位符样例。
  // 不先剥掉的话：① 样例会被一起替换成真值，注释变成一段莫名其妙的对照表；
  // ② 说明文字里的字面 {{TOKEN}} 没有对应替换、会被 validate-report.js 当成
  //    「残留未替换的占位符」直接让整站构建失败（第一次跑 build 就是这么挂的）。
  // 手写报告的 /research 流程里作者会顺手删掉它，机器填就得显式做这一步。
  return String(template)
    .replace(/^<!doctype html>\s*<!--[\s\S]*?-->\s*/i, "<!doctype html>\n")
    .replace(/\{\{TITLE\}\}/g, escapeHtml(meta.title))
    .replace(/\{\{TYPE\}\}/g, "股票")
    .replace(/\{\{DATE\}\}/g, meta.date)
    .replace(/\{\{PLAIN\}\}/g, plain)
    .replace(/\{\{TLDR\}\}/g, escapeHtml(tldr))
    .replace(/\{\{KEY_FINDINGS\}\}/g, findings)
    .replace(/\{\{BODY\}\}/g, bodyHtml)
    .replace(/\{\{LIMITATION_BLOCK\}\}/g, limitation)
    .replace(/\{\{GLOSSARY\}\}/g, glossaryHtml)
    .replace(/\{\{RISKS\}\}/g, risks || "<li>暂无显著风险项</li>")
    .replace(/\{\{SOURCES\}\}/g, sources || "<li>本篇正文未引用外部链接</li>")
    .replace(/\{\{SOURCE_COUNT\}\}/g, String(links.length + textSources.length))
    .replace(/\{\{MASTHEAD_BOARDS\}\}/g, boards);
}

// 「先说人话」：给完全不懂这行的人。只用报告里现成的主营描述 + A 节那句一句话逻辑，
// 抽不到主营就退成不带业务描述的版本——宁可少一句，不替公司编业务。
export function buildPlain({ meta, mainBusiness, oneLiner, direction }) {
  const who = mainBusiness
    ? `${meta.name}（${meta.code}）主要做的是${mainBusiness.replace(/[。.]$/, "")}。`
    : `${meta.name}（${meta.code}）是一家 A 股上市公司。`;
  const what = "这份报告不预测具体股价，只回答一件事：往后约三个月，哪些**可以核验的事实**会决定它往哪边走，以及什么情况出现时该重新想一遍。";
  const now = oneLiner ? `眼下的处境一句话说完——${oneLiner}` : `当前判断的方向是${direction}。`;
  // 三段都要走 inline()：漏掉任何一段，段里的 **强调** 会以字面星号直出到页面上
  //（第一版漏了中间那句，浏览器里当场看见 `**可以核验的事实**`）。
  return `${inline(who)}${inline(what)}${inline(now)}`;
}

// ========== INDEX.md ==========

// 新行按日期倒序插进表里。同日期的新行排在已有同日行**之前**（与 INDEX 表头写的
// 「新行置顶按日期倒序」一致）。找不到表头就抛错——宁可失败也不要把行追到文件末尾，
// 那样它不在表里、谁也看不见。
// 已经有这个归档目录的行了吗？重导（删掉目录让它重跑，README 里就是这么教的）时，
// 目录会被逐字节重建、git 看不出差异，但 INDEX 会**再插一行**——线上就出现两张一模一样的
// 卡片。2026-08-16 端到端演练当场撞到，且它已经被自动提交推送了一次。
export function hasIndexRow(indexMd, dir) {
  return String(indexMd).includes(`\`${dir}\``);
}

export function insertIndexRow(indexMd, row, date) {
  const lines = String(indexMd).split("\n");
  const sep = lines.findIndex((l) => /^\|\s*---/.test(l));
  if (sep < 0) throw new Error("INDEX.md 里找不到表格分隔行，拒绝插入");
  let at = sep + 1;
  while (at < lines.length && /^\|/.test(lines[at])) {
    const d = (lines[at].split("|")[1] || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d <= date) break;
    at++;
  }
  lines.splice(at, 0, row);
  return lines.join("\n");
}

// ========== 主流程 ==========

function parseArgs(argv) {
  const a = { dryRun: false, since: null, only: null, porcelain: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") a.dryRun = true;
    else if (argv[i] === "--porcelain") a.porcelain = true;
    else if (argv[i] === "--since") a.since = argv[++i];
    else if (argv[i] === "--id") a.only = Number(argv[++i]);
  }
  return a;
}

function log(...s) { console.log(...s); }

export function importOne(row, { template, dryRun, sector }) {
  const code = String(row.ts_code).padStart(6, "0");
  const { date, created } = splitTime(row.generated_at);
  const { slug, boards, known } = metaOf(code);
  const dir = `${date}_${slug}`;
  const parsedSummary = JSON.parse(row.summary_json || "{}");
  const { value: summary, applied: priceFixes } = applyPriceFixes(parsedSummary, row.id);
  // 申万行业与概念标签：查不到就是空，展示层按空处理（不显示那一行），不编造。
  const industry = sector?.industry || "";
  const concepts = pickConcepts(sector?.concepts || []);
  const meta = {
    name: row.name, code, date, created, boards, reportId: row.id, industry, concepts,
    title: `${row.name}（${code}.${exchangeOf(code)}）`,
  };

  const raw = sanitize(row.content_md);
  const { value: md, applied: bodyFixes } = applyPriceFixes(raw.md, row.id);
  const dropped = raw.dropped;
  const oneLiner = pickOneLiner(md);
  const links = pickLinks(md);
  const textSources = pickTextSources(md, links.map((l) => l.text));
  const tldr = buildTldr({
    direction: summary.direction || "震荡",
    confidence: summary.confidence || "中",
    oneLiner, drivers: summary.drivers, risks: summary.risks,
  });
  // 正文去掉 H1（模板报头已经有标题了，正文再来一遍是重复的大标题）
  const bodyMd = md.replace(/^#\s+.+$/m, "").trim();
  const bodyHtml = mdToHtml(bodyMd);
  const html = buildReportHtml({
    template, meta, summary, tldr, bodyHtml, links, textSources,
    plain: buildPlain({ meta, mainBusiness: pickMainBusiness(md), oneLiner, direction: summary.direction || "震荡" }),
    glossary: pickGlossary(md),
  });
  const sourceCount = links.length + textSources.length;
  const notes = buildNotes({ meta, summary, tldr, oneLiner, sourceCount, dir });
  const sources = buildSources({ meta, links, textSources });

  if (!dryRun) {
    const outDir = join(ARCHIVE, dir);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "report.html"), html);
    writeFileSync(join(outDir, "notes.md"), notes);
    writeFileSync(join(outDir, "sources.md"), sources);

    const indexPath = join(ARCHIVE, "INDEX.md");
    const indexMd = readFileSync(indexPath, "utf8");
    if (!hasIndexRow(indexMd, dir)) {
      const shortTldr = tldr.length > 220 ? tldr.slice(0, 218) + "…" : tldr;
      const row2 = `| ${date} | ${meta.title} | 股票 | ${boards.length ? boards.join(" / ") : "—"} | ${shortTldr.replace(/\|/g, "｜")} | \`${dir}\` |`;
      writeFileSync(indexPath, insertIndexRow(indexMd, row2, date));
    }
  }

  return {
    dir, dropped: dropped.length, links: sourceCount, known, title: meta.title,
    priceFixes: [...priceFixes, ...bodyFixes],
    industry, concepts,
    // 只是建议，不写进 mapping.js——由人确认（2026-08-17 用户拍板）。
    suggestedBoards: suggestBoards(concepts),
  };
}

function toObsidian(dir, title) {
  if (!existsSync(OBSIDIAN_VAULT)) return "库未挂载，跳过";
  try {
    execFileSync("bun", [
      "run", OBSIDIAN_CONVERTER, join(ARCHIVE, dir),
      "--vault", OBSIDIAN_VAULT, "--name", title,
    ], { cwd: REPO, encoding: "utf8", stdio: "pipe" });
    return "已落库";
  } catch (e) {
    return `失败（${String(e.stderr || e.message).split("\n")[0]}）`;
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const template = readFileSync(TEMPLATE, "utf8");
  const done = importedIds(ARCHIVE);
  let rows = queryReports().filter((r) => !done.has(r.id));
  if (args.since) rows = rows.filter((r) => r.generated_at.slice(0, 10) >= args.since);
  if (args.only != null) rows = rows.filter((r) => r.id === args.only);

  // --porcelain：只吐新建的目录名，一行一个，给 scheduled-run.sh 逐篇过质检用。
  // 定时任务不靠解析人读的日志判断「导了哪几篇」——那种解析一改文案就悄悄失灵。
  if (!rows.length) {
    if (!args.porcelain) log("没有新的深度调研报告可导入。");
    return 0;
  }
  if (!args.porcelain) log(`发现 ${rows.length} 篇新报告${args.dryRun ? "（dry-run，不落盘）" : ""}：`);

  // 申万行业与概念标签一次查完，避免每篇一次 sqlite 调用。
  const sectors = querySectors(rows.map((r) => String(r.ts_code).padStart(6, "0")));

  const unknown = [];
  const suggestions = [];
  for (const r of rows) {
    const code0 = String(r.ts_code).padStart(6, "0");
    const res = importOne(r, { template, dryRun: args.dryRun, sector: sectors[code0] });
    if (!res.known) {
      unknown.push(code0);
      if (res.suggestedBoards.length) suggestions.push(`${code0}（${res.title}）→ ${res.suggestedBoards.join(" / ")}`);
    }
    const obs = args.dryRun ? "-" : toObsidian(res.dir, res.title);
    if (args.porcelain) { console.log(res.dir); continue; }
    const pf = res.priceFixes.length ? ` · 价位红线改写 ${res.priceFixes.length} 处` : "";
    log(`  ✓ ${res.dir}  来源 ${res.links} 条 · 过滤系统参数句 ${res.dropped} 条${pf} · Obsidian ${obs}`);
  }
  if (args.porcelain) return 0;
  if (unknown.length) {
    log(`\n⚠️ 这些代码不在 src/mapping.js 的元数据表里，已用 stock-<代码> 兜底命名、板块留空：${unknown.join(" / ")}`);
    log("   请补进表里（slug 一旦上线就不该再改；板块按「确有关联才挂」的口径人工判断）。");
    if (suggestions.length) {
      log("   按同花顺概念标签给出的板块建议（**仅供参考，需人工确认后再写进表里**）：");
      for (const s of suggestions) log(`     · ${s}`);
      log("   注意这份建议既可能多挂也可能漏挂：概念标签泛化时会带出无关板块，而海光信息这类");
      log("   标的的标签里根本没有「算力」字样、必然漏报。判断权在人，别直接照抄。");
    }
  }
  log(`\n完成。接下来跑 \`bun run build\` 检查，再 push 上线。`);
  return 0;
}

if (import.meta.main) process.exit(main());
