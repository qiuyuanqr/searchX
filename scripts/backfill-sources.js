// 回填 sources.md：把「正文引用了、但清单没记」的来源补进去。
//
// 两类分开处理，绝不事后编造元信息：
//   A 类：URL 出现在 report.html 自己的 <section class="sources"> 里 → 类型/标题/日期/摘要
//         原样照搬，无损。
//   B 类：只在正文行内出现 → 标题取正文引用处的锚文本（这是作者当时给它的标签，可追溯），
//         类型只在域名能唯一确定时才判（交易所/监管/公告库/已知社区平台），否则标「待归类」；
//         发布日期与摘要当时没记，就写「未记录」，不去猜、不去抓页面。
//
// 补进去的条目单独归入「回填补记」小节并注明日期，与当时如实记录的来源区分开。
//
//   bun run scripts/backfill-sources.js            # 演练，打印将写入的内容
//   bun run scripts/backfill-sources.js --write    # 实写
//
// 2026-07-31 用它补齐了历史欠账的 107 条（30 个归档）。幂等：已有回填小节会整段替换、不叠加。
// 日常不该用到它——新报告按 SKILL 的「清单 ⊇ 正文引用」规则当场写全即可。
import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { extractUrls, normalizeUrl } from "./check-sources.js";

const ROOT = "research";
const WRITE = process.argv.includes("--write");
const STAMP = "2026-07-31";
const HEADING = `## 回填补记（${STAMP}）`;

// 类型判定：不靠我猜，靠项目自己已有的 47 份 sources.md 学。
// 关键事实：同一域名在既有清单里会被标成不同类型（finance.sina.com.cn 有 120 次「媒体」、
// 24 次「披露」、9 次「研究」）——类型是**内容决定的、不是域名决定的**。
// 所以只在某域名的既有标注呈压倒性多数（≥5 次且占比 ≥80%）时才沿用，否则老实标「待归类」，
// 绝不为了让清单好看而给一条来源安一个可能抬高其可信度的标签
//（SKILL 的弱来源规则是按类型分级的，标错会误导后来的读者）。
function learnTypeByHost(root) {
  const tally = new Map();
  for (const dir of readdirSync(root)) {
    const sp = join(root, dir, "sources.md");
    if (!/^\d{4}-\d{2}-\d{2}_/.test(dir) || !existsSync(sp)) continue;
    for (const line of readFileSync(sp, "utf8").split("\n")) {
      const m = line.match(/^-\s*\[([^\]]+)\][\s\S]*?(https?:\/\/[^\s—]+)/);
      if (!m) continue;
      const type = m[1].trim();
      if (!["监管", "披露", "媒体", "研究", "社区"].includes(type)) continue;
      let host = "";
      try { host = new URL(m[2]).hostname.replace(/^www\./, "").toLowerCase(); } catch { continue; }
      if (!tally.has(host)) tally.set(host, new Map());
      const t = tally.get(host);
      t.set(type, (t.get(type) || 0) + 1);
    }
  }
  const decided = new Map();
  for (const [host, t] of tally) {
    const total = [...t.values()].reduce((a, b) => a + b, 0);
    const [top, n] = [...t.entries()].sort((a, b) => b[1] - a[1])[0];
    if (total >= 5 && n / total >= 0.8) decided.set(host, top);
  }
  return decided;
}
const LEARNED = learnTypeByHost(ROOT);

function typeOf(url) {
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return "待归类"; }
  return LEARNED.get(host) || "待归类";
}

// 报告自己的来源区 → 结构化条目
function sourceSectionEntries(html) {
  const map = new Map();
  const sec = html.match(/<section[^>]*class="[^"]*sources[^"]*"[\s\S]*?<\/section>/i);
  if (!sec) return map;
  for (const li of sec[0].matchAll(/<li[\s\S]*?<\/li>/gi)) {
    const s = li[0];
    const a = s.match(/<a[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const type = (s.match(/class="[^"]*src-[a-z]+[^"]*"[^>]*>([^<]*)</i) || [])[1] || "";
    const date = (s.match(/<em[^>]*>([\s\S]*?)<\/em>/i) || [])[1] || "";
    // 摘要 = li 纯文本里，去掉类型/标题/日期之后剩下的部分
    const plain = s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const title = a[2].replace(/<[^>]+>/g, "").trim();
    let summary = plain;
    for (const part of [type, title, date]) if (part) summary = summary.replace(part, " ");
    summary = summary.replace(/\s+/g, " ").replace(/^[\s—–-]+/, "").trim();
    map.set(normalizeUrl(a[1]), { url: a[1], type: type.trim() || "待归类", title, date: date.trim(), summary });
  }
  return map;
}

// 正文里每个 URL 的锚文本 + 所在小节（取其前面最近的 h2/h3）
function bodyContext(html) {
  const map = new Map();
  let section = "";
  const token = /<h[23][^>]*>([\s\S]*?)<\/h[23]>|<a[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(token)) {
    if (m[1] != null) { section = m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(); continue; }
    const key = normalizeUrl(m[2]);
    if (map.has(key)) continue;
    const anchor = m[3].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    map.set(key, { anchor, section });
  }
  return map;
}

const tidy = (s) => String(s || "").replace(/\s+/g, " ").trim();
// 锚文本外面整层包着括号时才剥（"（证券时报：定增 18 亿）" → "证券时报：定增 18 亿"），
// 不能无脑剥两端标点——小节名「…（必做的前提校正）」会被剥成半句。
const clean = (s) => {
  const t = tidy(s);
  return /^[（(\[【].*[）)\]】]$/.test(t) ? tidy(t.slice(1, -1)) : t;
};
// 「链接」「来源」「详见」这类泛指词当标题没有信息量，退回用域名标识
const GENERIC = /^(链接\d*|来源\d*|详见|见此|点此|原文|here|link|source)$/i;
function titleFor(anchor, url) {
  const a = clean(anchor);
  if (a && !GENERIC.test(a) && a.length >= 2) return a;
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}
  return host ? `${host}（正文中未给标题${a ? `，标注为「${a}」` : ""}）` : "（正文中未给标题）";
}

let touched = 0, addedA = 0, addedB = 0;
const preview = [];

for (const dir of readdirSync(ROOT).sort()) {
  if (!/^\d{4}-\d{2}-\d{2}_/.test(dir)) continue;
  const rp = join(ROOT, dir, "report.html"), sp = join(ROOT, dir, "sources.md");
  if (!existsSync(rp) || !existsSync(sp)) continue;

  const html = readFileSync(rp, "utf8");
  const md = readFileSync(sp, "utf8");
  const have = new Set([...extractUrls(md)].map(normalizeUrl));
  const missing = [...extractUrls(html)].filter((u) => !have.has(normalizeUrl(u)));
  if (!missing.length) continue;

  const secEntries = sourceSectionEntries(html);
  const ctx = bodyContext(html);
  const lines = [];
  const seen = new Set();

  for (const url of missing) {
    const key = normalizeUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const fromSec = secEntries.get(key);
    if (fromSec) {
      // A 类：原样照搬，元信息完整
      const parts = [`- [${fromSec.type}] ${fromSec.title} — ${fromSec.url}`];
      if (fromSec.date) parts.push(fromSec.date);
      if (fromSec.summary) parts.push(fromSec.summary);
      lines.push(parts.join(" — "));
      addedA++;
    } else {
      // B 类：只写真实已知的
      const c = ctx.get(key) || {};
      const title = titleFor(c.anchor, url);
      const where = tidy(c.section);
      lines.push(
        `- [${typeOf(url)}] ${title} — ${url} — （原始日期未记录）— 回填补记；正文引用处：${where || "正文"}`
      );
      addedB++;
    }
  }
  if (!lines.length) continue;
  touched++;

  const block = [
    "",
    HEADING,
    "",
    `> 以下来源正文引用过、但当时未记入本清单，${STAMP} 从 report.html 反向补齐（`,
    `> \`bun run check:sources\` 的守门规则要求「清单 ⊇ 正文引用」）。`,
    `> 标题取自正文引用处的措辞；标 \`（原始日期未记录）\` 的条目其发布日期与摘要当时没有记录，`,
    `> **未做事后推测**。类型由本仓库既有 47 份清单的同域名标注学得，只在压倒性多数
> （≥5 次且占比 ≥80%）时沿用，否则标 \`待归类\`——同一域名在既有清单里本就会按内容
> 标成不同类型，靠域名硬猜会抬高来源的表观可信度。`,
    "",
    ...lines,
    "",
  ].join("\n");

  preview.push({ dir, count: lines.length, block });

  if (WRITE) {
    // 幂等：已经有回填小节就先整段替换掉，不叠加
    const stripped = md.replace(new RegExp(`\\n${HEADING}[\\s\\S]*$`), "").replace(/\s+$/, "");
    writeFileSync(sp, stripped + "\n" + block, "utf8");
  }
}

console.log(`涉及归档 ${touched} 个；将补入 ${addedA + addedB} 条（A 类无损照搬 ${addedA} / B 类仅记已知 ${addedB}）`);
if (!WRITE) {
  console.log("\n—— 演练：以下为将写入的内容（示例 2 个归档）——");
  for (const p of preview.slice(0, 2)) {
    console.log(`\n### ${p.dir}（${p.count} 条）`);
    console.log(p.block.split("\n").slice(0, 14).join("\n"));
  }
  console.log("\n[演练] 未写入。加 --write 实写。");
} else {
  console.log("✓ 已写入");
}
