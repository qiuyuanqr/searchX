#!/usr/bin/env bun
// 给存量股票报告补上「申万行业」与「概念标签」两个维度。
//
// 为什么需要它：services/stocks-import 从 2026-08-17 起会给**新导入**的报告写这两项，
// 但此前已归档的 80 多篇没有。只覆盖未来等于功能做了一半，所以补一次存量。
//
// 幂等：已经有的会按当前库值**覆盖更新**（行业归属和概念标签本身会变），
// 没有的插入，查不到的**保持原样不动**——不写空字段、不编造。
//
//   bun run scripts/backfill-sectors.js --dry-run     # 只看会改哪些，不落盘
//   bun run scripts/backfill-sectors.js               # 真改
//   bun run scripts/backfill-sectors.js --dir <目录名> # 只改一篇
//
// 改完必须 `bun run build` 验证，再看一眼真浏览器（报头是视觉元素，纯函数测不到接线）。

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildSectorSql, groupSectorRows, pickConcepts } from "../services/stocks-import/src/sectors.js";
import { exchangeOf } from "../services/stocks-import/src/mapping.js";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ARCHIVE = join(REPO, "research");
const STOCKS_DB = process.env.STOCKS_DB || `${process.env.HOME}/Coding/Stocks/data/stocks.db`;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyDir = args[args.indexOf("--dir") + 1] && args.includes("--dir") ? args[args.indexOf("--dir") + 1] : null;

// ---- 找出所有股票报告及其代码 ----
// 双重判据：frontmatter 的 `type: 股票` **且** 目录 slug 末尾是 6 位数字。
// 只靠目录名会把 `..._some-topic-2025` 这种普通调研误当股票；只靠 type 则拿不到代码。
function stockDirs() {
  const out = [];
  for (const name of readdirSync(ARCHIVE)) {
    if (onlyDir && name !== onlyDir) continue;
    const dir = join(ARCHIVE, name);
    if (!existsSync(join(dir, "notes.md")) || !statSync(dir).isDirectory()) continue;
    const notes = readFileSync(join(dir, "notes.md"), "utf8");
    if (!/^type:\s*股票\s*$/m.test(notes)) continue;
    const m = name.match(/(\d{6})$/);
    if (!m) continue;
    out.push({ name, code: m[1] });
  }
  return out;
}

function querySectors(codes) {
  const sql = buildSectorSql(codes, exchangeOf);
  if (!sql) return {};
  const out = execFileSync("sqlite3", [STOCKS_DB, sql], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return groupSectorRows(out.split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l)));
}

const fmList = (list) => `[${list.map((s) => JSON.stringify(s)).join(", ")}]`;
const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---- notes.md：在 related: 行后写入两个字段 ----
function patchNotes(raw, industry, concepts) {
  let s = raw;
  // 先删掉旧值（幂等重跑时按当前库值覆盖），再插新值
  s = s.replace(/^sw_industry:.*\n/m, "").replace(/^concepts:.*\n/m, "");
  const add =
    (industry ? `sw_industry: ${JSON.stringify(industry)}\n` : "") +
    (concepts.length ? `concepts: ${fmList(concepts)}\n` : "");
  if (!add) return s;
  // 锚在 related: 那一行之后。所有归档 notes.md 都有这一行（buildNotes 固定输出）。
  const m = s.match(/^related:.*\n/m);
  if (!m) return s;                       // 没有锚点就不动，宁可不补也不写坏 frontmatter
  return s.slice(0, m.index + m[0].length) + add + s.slice(m.index + m[0].length);
}

// ---- report.html：在「来源 N 条」那个 span 前插入 ----
// 这个 span 所有报告都有（模板固定输出），是比「关联板块」更可靠的锚点——
// 板块为空的报告里那一格是空白，没有可锚的标签。
function patchHtml(raw, industry, concepts) {
  let s = raw;
  s = s.replace(/\s*<span><b>申万行业<\/b>[^<]*<\/span>/g, "")
       .replace(/\s*<span style="flex-basis:100%"><b>概念标签<\/b>[^<]*<\/span>/g, "");
  const parts = [
    industry ? `<span><b>申万行业</b> ${escapeHtml(industry)}</span>` : "",
    concepts.length ? `<span style="flex-basis:100%"><b>概念标签</b> ${escapeHtml(concepts.join(" · "))}</span>` : "",
  ].filter(Boolean);
  if (!parts.length) return s;
  const anchor = s.match(/(\s*)<span><b>来源<\/b>/);
  if (!anchor) return s;
  const indent = anchor[1] || "\n      ";
  return s.slice(0, anchor.index) + indent + parts.join(indent) + s.slice(anchor.index);
}

const dirs = stockDirs();
if (!dirs.length) { console.log("没有找到股票报告。"); process.exit(0); }
const sectors = querySectors(dirs.map((d) => d.code));

let changed = 0, missing = [];
for (const { name, code } of dirs) {
  const s = sectors[code];
  const industry = s?.industry || "";
  const concepts = pickConcepts(s?.concepts || []);
  if (!industry && !concepts.length) { missing.push(`${name}(${code})`); continue; }

  const notesPath = join(ARCHIVE, name, "notes.md");
  const htmlPath = join(ARCHIVE, name, "report.html");
  const notes0 = readFileSync(notesPath, "utf8");
  const html0 = readFileSync(htmlPath, "utf8");
  const notes1 = patchNotes(notes0, industry, concepts);
  const html1 = patchHtml(html0, industry, concepts);
  if (notes1 === notes0 && html1 === html0) continue;

  if (!dryRun) { writeFileSync(notesPath, notes1); writeFileSync(htmlPath, html1); }
  changed++;
  console.log(`  ${dryRun ? "会改" : "已改"} ${name}  申万：${industry || "（缺）"}  概念 ${concepts.length} 个`);
}

console.log(`\n共 ${dirs.length} 篇股票报告，${dryRun ? "会改" : "已改"} ${changed} 篇。`);
if (missing.length) console.log(`库里查不到行业与概念的 ${missing.length} 篇（保持原样未动）：${missing.join(" / ")}`);
if (!dryRun && changed) console.log("接下来跑 `bun run build` 验证，再看一眼真浏览器里的报头。");
