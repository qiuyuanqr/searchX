// services/stocks-import/src/series-prices.js
// 给「判断档案」页（web/build/render-archive.js）准备行情快照：research/_series/prices.json。
//
// 为什么在这里做：站点在 GitHub Actions 上构建，摸不到 Mac mini 上的 Stocks 库；stocks-import 本来就
// 每 5 分钟在 Mac mini 上跑、本来就带着一条验证过的只读查库通道（sqliteJsonLines：busy_timeout +
// query_only + 等锁重试）。所以由它把需要的收盘价写进仓库，CI 构建时读文件。
//
// **本模块是 prices.json 的唯一写入方**。别在 MacBook 上跑它再提交：MacBook 上的 Stocks 副本是过期的
// （CLAUDE.local.md），而且两台机各写各的会在自动同步里撞冲突。下面的「数据截止日只许前进」
// 是给误跑兜的底，不是允许两边都写。
//
// 收哪些票：与构建完全同一个口径——scanResearch + 跳过 .parked / 缺 report.html + annotateSeries，
// 拿到 archiveHref 的系列（6 位代码、两篇以上）。口径分家的话，会出现「有档案页却没行情」或反过来。
// 取多长：最早一次调研日往前 14 个自然日起，到库里最新交易日。只查白名单表 daily_kline。
//
//   bun run services/stocks-import/src/series-prices.js             # 更新快照（有变化才写）
//   bun run services/stocks-import/src/series-prices.js --porcelain # 只在写了文件时往 stdout 打一行 changed
//   bun run services/stocks-import/src/series-prices.js --dry-run   # 只报告会写什么，不落盘

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { scanResearch } from "../../../web/build/scan.js";
import { annotateSeries } from "../../../web/build/series.js";
import { sqliteJsonLines } from "./index.js";

const REPO = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const ARCHIVE = join(REPO, "research");
export const PRICES_PATH = join(ARCHIVE, "_series", "prices.json");
const STOCKS_DB = process.env.STOCKS_DB || `${process.env.HOME}/Coding/Stocks/data/stocks.db`;
export const LEAD_DAYS = 14;
export const SOURCE = "Stocks 库 daily_kline 收盘价（未复权）";

const CODE_RE = /^\d{6}$/;
const YMD_RE = /^\d{8}$/;

// 需要行情的票 → 最早一次调研日（YYYY-MM-DD）。与 web/build/build.js 的收录口径一致。
export function seriesTargets(archiveRoot = ARCHIVE) {
  const scanned = scanResearch(archiveRoot).filter(
    (e) => !existsSync(join(archiveRoot, e.dir, ".parked")) && existsSync(join(archiveRoot, e.dir, "report.html")),
  );
  const out = new Map();
  for (const e of annotateSeries(scanned)) {
    const href = e.series && e.series.archiveHref;
    if (!href) continue;
    const code = href.replace(/^s\//, "").replace(/\/$/, "");
    if (!CODE_RE.test(code)) continue;
    const prev = out.get(code);
    if (!prev || String(e.date) < prev) out.set(code, String(e.date));
  }
  return out;
}

// "2026-06-08" 往前 days 天 → "20260525"
export function startYmd(date, days = LEAD_DAYS) {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return new Date(t - days * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
}

// 拼 SQL。代码与日期都先过正则再内联——它们来自本仓库的目录与标题，不是外部输入，
// 但拼进 SQL 的东西一律先验形。daily_kline 的 ts_code 是 6 位裸码（stock SKILL §2.3 两格式陷阱）。
export function pricesSql(targets) {
  const conds = [];
  for (const [code, date] of [...targets].sort(([a], [b]) => a.localeCompare(b))) {
    const from = startYmd(date);
    if (!CODE_RE.test(code) || !from || !YMD_RE.test(from)) continue;
    conds.push(`(ts_code='${code}' AND trade_date>='${from}')`);
  }
  if (!conds.length) return null;
  return `SELECT json_object('c', ts_code, 'd', trade_date, 'p', close) FROM daily_kline WHERE ${conds.join(" OR ")} ORDER BY ts_code, trade_date;`;
}

export const AS_OF_SQL = "SELECT json_object('asOf', MAX(trade_date)) FROM daily_kline;";

// 查库结果 → 快照对象。代码排序、日期升序，丢掉形状不对的行（不编造、不补值）。
export function buildPrices({ asOf, rows }) {
  const codes = {};
  for (const r of rows || []) {
    const c = String(r.c ?? "");
    const d = String(r.d ?? "");
    const p = Number(r.p);
    if (!CODE_RE.test(c) || !YMD_RE.test(d) || !Number.isFinite(p) || p <= 0) continue;
    (codes[c] ||= []).push([d, Math.round(p * 1000) / 1000]);
  }
  const sorted = {};
  for (const c of Object.keys(codes).sort()) sorted[c] = codes[c].sort((a, b) => a[0].localeCompare(b[0]));
  return { asOf: String(asOf || ""), source: SOURCE, codes: sorted };
}

// 一只票一行：每天只追加一个点，diff 读得懂；键序固定，内容不变则字节不变（不产生空提交）。
export function serialize(data) {
  const lines = Object.entries(data.codes).map(([c, pts]) => `${JSON.stringify(c)}:${JSON.stringify(pts)}`);
  return `{"asOf":${JSON.stringify(data.asOf)},"source":${JSON.stringify(data.source)},"codes":{\n${lines.join(",\n")}\n}}\n`;
}

// 决定写不写。返回 { write: bool, reason }。
// 数据截止日只许前进：读到更早的库（误在 MacBook 过期副本上跑、库回滚）绝不覆盖更新的快照。
export function decideWrite(existingText, next) {
  if (!YMD_RE.test(next.asOf)) return { write: false, reason: `库里的数据截止日不对（${next.asOf || "空"}），不写` };
  let prev = null;
  if (existingText) {
    try { prev = JSON.parse(existingText); } catch { prev = null; }
  }
  if (prev && YMD_RE.test(String(prev.asOf)) && String(prev.asOf) > next.asOf) {
    return { write: false, reason: `现有快照截至 ${prev.asOf}，比库里的 ${next.asOf} 新——不许倒退，不写` };
  }
  const text = serialize(next);
  if (existingText === text) return { write: false, reason: "没有变化" };
  return { write: true, reason: prev ? "有更新" : "首次生成", text };
}

export function main(argv = process.argv.slice(2), {
  archiveRoot = ARCHIVE, pricesPath = PRICES_PATH, db = STOCKS_DB, query = sqliteJsonLines,
} = {}) {
  const porcelain = argv.includes("--porcelain");
  const dryRun = argv.includes("--dry-run");
  const say = (...s) => console.error(...s);   // 诊断一律走 stderr，stdout 只留给 --porcelain 的信号
  const targets = seriesTargets(archiveRoot);
  const asOfRows = query(db, AS_OF_SQL);
  const asOf = String((asOfRows[0] || {}).asOf ?? "");
  const sql = pricesSql(targets);
  const rows = sql ? query(db, sql, { maxBuffer: 64 * 1024 * 1024 }) : [];
  const next = buildPrices({ asOf, rows });
  const missing = [...targets.keys()].filter((c) => !next.codes[c]);
  if (missing.length) say(`⚠️ 判断档案行情：${missing.length} 只票在 daily_kline 里查不到（${missing.join(" ")}），档案页照出、不带行情`);
  const existing = existsSync(pricesPath) ? readFileSync(pricesPath, "utf8") : "";
  const d = decideWrite(existing, next);
  say(`判断档案行情：${targets.size} 只票，截至 ${asOf || "?"}——${d.reason}`);
  if (!d.write || dryRun) return 0;
  mkdirSync(dirname(pricesPath), { recursive: true });
  writeFileSync(pricesPath, d.text);
  if (porcelain) console.log("changed");
  return 0;
}

if (import.meta.main) process.exit(main());
