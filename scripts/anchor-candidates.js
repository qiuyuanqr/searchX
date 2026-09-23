// scripts/anchor-candidates.js
// 锚名对账：把「被质检拦下的价位」按**为什么没被剥掉**分诊，其中一类直接给出
// `price-anchor.js` 的 ANCHOR 词表该补哪些词。
//
// ## 为什么需要它
//
// 导入侧的分工是：Stocks 侧写「锚 + 数值」，`services/stocks-import/src/price-anchor.js`
// 在导入时把数值剥掉、只留锚。锚认不认得出，全看那份 ANCHOR 词表的字面。
// 这份词表**已经漏过三次**，每次形态一模一样——写作者写得完全合规，词表认不出它写的那个锚名：
//   - 2026-09-01：`MA20 29.24 元` / `9-01 当日最低 13.81 元` / `8-31 收盘 12.97 元`
//     （表里只有「均线」「低点」这些概念名）；
//   - 2026-09-18：`跌破茂莱转债转股价 364.15 元`（表里没有「转股价」）。
// 每次都是等一封 `stocks-import-parked` 报警、人去翻原文才发现。这个脚本把那一步提前：
// 任何时候都能问一句「现在有没有『有锚但词表不认』的写法」。
//
// ## 分诊（这才是它的价值，不只是列个清单）
//
//   ① **候选锚名**——触发词与数值之间有实词，但其中不含任何已知锚。这类是**词表该补**的，
//      补完这句就能被自动剥掉。输出按出现次数排序，照真实原文给出，直接抄进 ANCHOR。
//   ② **裸价位**——触发词与数值之间什么都没有（`跌破 54.00 元`）。改写器**故意不猜**，
//      这类要回 Stocks 侧改写法，不是词表的问题。
//   ③ **存量残留**——段里有已知锚，且把这句喂给改写器**现在就能剥掉**。也就是说词表后来补上了，
//      而报告是补词之前导入的：补词表**不会回溯已入库的正文**。这类重跑一次改写器（或人工删数值）即可。
//      验证过的真实例子：09-01 那两篇的 `MA20 29.24 元`、茂莱的 `转股价 364.15 元` 现在都落在这一类。
//   ④ **改写器够不着**——有锚，但喂进改写器一个字都不动。这是结构性的，补词表没用：
//      最常见是价位写在括号里的推算值（`（据转股价推算 473.40 元）`，匹配段不跨括号）、
//      或触发词与数值离得太远超出匹配窗口。这类只能回写作端规避。
//
// 用法：
//   bun run scripts/anchor-candidates.js            # 扫 research/ 全量
//   bun run scripts/anchor-candidates.js --dir <目录名>
//   bun run scripts/anchor-candidates.js --json     # 给别的脚本吃

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runQc, POSITION_VERB } from "./research-qc.js";
import { TRIGGER, ANCHOR, stripAnchoredPrice } from "../services/stocks-import/src/price-anchor.js";

const ARCHIVE = "research";
const DIR_RE = /^\d{4}-\d{2}-\d{2}_.+$/;

// 质检把命中原文放在「具体触发价位「…」」与「位置式触发价位「…」」里。只取这两类，
// 别把预测性价格区间、私人信息那些也拖进来——它们与锚词表无关。
// ⚠️ 2026-09-23 加位置式规则时这里只认「具体」一种，于是 11 篇被拦、本脚本却报
// 「✅ 当前没有被拦下的价位」——质检加了新的拦截类别，这里要跟着认，否则就是假绿。
const BLOCKING_RE = /(?:具体|位置式)触发价位「([^」]+)」/;

// 位置式的「触发词」是 处于 / 在 / 回到 … 那张动词表，数值后面还跟着方位词。
const TRIGGER_HEAD_RE = new RegExp(`^(?:${TRIGGER}|${POSITION_VERB})`);
const INNER_VERB_RE = new RegExp(`^\\s*[^\\s\\d]{0,2}?(?:${TRIGGER}|${POSITION_VERB})`);
const NUM_TAIL_RE = /\d[\d,]*(?:\.\d+)?\s*(?:元|港元|美元|港币)\s*(?:\*{1,2}|_{1,2})?\s*(?:上方|下方|之上|之下|以上|以下)?\s*$/;
const ANCHOR_RE = new RegExp(ANCHOR);

// 锚名候选里要滤掉的通用词：它们在几乎每句里都出现，收进词表等于把词表废掉
// （「股价」尤其危险——`跌破股价 54 元` 里它不是刻度，是主语）。
const STOPWORDS = /^(?:股价|价格|该股|其|它|本股|当前|目前|收盘价|股价的)?$/;

/** 从一条质检硬红线里取出被点名的原文；不是价位类就返回 null。 */
export function quotedPrice(blockingLine) {
  const m = BLOCKING_RE.exec(String(blockingLine ?? ""));
  return m ? m[1].trim() : null;
}

/**
 * 把「触发词 + 中间段 + 数值」拆开，判定它属于哪一类。
 * 返回 { kind: "candidate" | "bare" | "stale" | "unreachable" | "unparsed", anchorText }。
 * 有锚的那两类靠**真跑一遍改写器**来分——能剥掉就是存量残留，一个字不动才是结构性够不着。
 * 不靠猜：判据就是改写器自己的行为，词表以后再变，分诊也跟着自动变对。
 */
export function classify(quoted) {
  const raw = String(quoted ?? "").trim();
  const head = TRIGGER_HEAD_RE.exec(raw);
  // 拿不到触发词说明质检那边的形态变了，宁可如实报「解析不了」也不猜。
  if (!head) return { kind: "unparsed", anchorText: raw };
  // 位置式的匹配从**最左边**那个动词起，「→ 偏跌至 40 元下方」拿到的头是「→」，中间段会剩下
  // 「偏跌至」——那是第二个动词不是锚名。只在头是「→」时再剥一层：别的头后面紧跟的「向」
  // 可能是锚名的一部分（「跌破向上缺口」剥了就成「上缺口」）。
  let middle = raw.slice(head[0].length).replace(NUM_TAIL_RE, "");
  if (head[0] === "→") middle = middle.replace(INNER_VERB_RE, "");
  middle = middle.trim();
  if (ANCHOR_RE.test(middle)) {
    const stripped = stripAnchoredPrice(raw).text;
    return { kind: stripped === raw ? "unreachable" : "stale", anchorText: middle };
  }
  // 中间段只剩空白 / 通用主语 = 裸价位，改写器故意不碰。
  if (STOPWORDS.test(middle.replace(/[\s,，、]/g, ""))) return { kind: "bare", anchorText: middle };
  return { kind: "candidate", anchorText: middle };
}

/** 扫一批目录，返回三类分诊结果。dirs 省略时扫 research/ 全量。 */
export function collect(dirs, root = ARCHIVE) {
  const list =
    dirs && dirs.length
      ? dirs
      : readdirSync(root)
          .filter((d) => DIR_RE.test(d) && existsSync(join(root, d, "notes.md")))
          .sort();
  const out = { candidate: new Map(), bare: [], stale: [], unreachable: [], unparsed: [], scanned: 0 };
  for (const dir of list) {
    const qc = runQc(dir, root);
    if (qc.dropped || qc.error) continue;
    out.scanned++;
    for (const line of qc.blocking) {
      const quoted = quotedPrice(line);
      if (!quoted) continue;
      const { kind, anchorText } = classify(quoted);
      if (kind === "candidate") {
        const hit = out.candidate.get(anchorText) || { anchor: anchorText, count: 0, where: [] };
        hit.count++;
        if (hit.where.length < 3) hit.where.push({ dir, quoted });
        out.candidate.set(anchorText, hit);
      } else {
        out[kind].push({ dir, quoted, anchorText });
      }
    }
  }
  return out;
}

export function render(res) {
  const L = [`⚓ 锚名对账 · 扫了 ${res.scanned} 篇`];
  const cands = [...res.candidate.values()].sort((a, b) => b.count - a.count);
  if (cands.length) {
    L.push("", `① 候选锚名（${cands.length} 个）——词表该补的就是它们，照原文抄进 price-anchor.js 的 ANCHOR：`);
    for (const c of cands) {
      L.push(`  · 「${c.anchor}」×${c.count}`);
      for (const w of c.where) L.push(`      ${w.dir}：${w.quoted}`);
    }
    L.push("  ⚠️ 补完必须同步 Stocks 侧 SKILL 第 3 条的锚清单——那是写作者唯一看得到的凭据，只改一边等于承诺「认得」却仍认不出。");
  }
  if (res.bare.length) {
    L.push("", `② 裸价位（${res.bare.length} 处）——改写器故意不猜，要回 Stocks 侧把写法改成「锚在前、数值紧跟」：`);
    for (const b of res.bare) L.push(`  · ${b.dir}：${b.quoted}`);
  }
  if (res.stale.length) {
    L.push("", `③ 存量残留（${res.stale.length} 处）——词表后来补上了、正文却是补词前导入的（补词表不回溯已入库的正文）。重跑一次改写器或人工删掉数值即可：`);
    for (const k of res.stale) L.push(`  · ${k.dir}：${k.quoted}`);
  }
  if (res.unreachable.length) {
    L.push("", `④ 改写器够不着（${res.unreachable.length} 处）——有锚但一个字都剥不掉，补词表没用。看原句：价位是不是写在括号里的推算值（匹配段不跨括号），或触发词离数值太远超出窗口。只能回写作端规避：`);
    for (const k of res.unreachable) L.push(`  · ${k.dir}：${k.quoted}`);
  }
  if (res.unparsed.length) {
    L.push("", `⑤ 解析不了（${res.unparsed.length} 处）——质检那边的形态变了，本脚本的拆法要跟着改：`);
    for (const u of res.unparsed) L.push(`  · ${u.dir}：${u.quoted}`);
  }
  if (!cands.length && !res.bare.length && !res.stale.length && !res.unreachable.length && !res.unparsed.length) {
    L.push("", "✅ 当前没有被拦下的价位——没有待补的锚名。");
  }
  return L.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dirs = [];
  let asJson = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") asJson = true;
    else if (args[i] === "--dir") dirs.push(args[++i].replace(/^research\//, "").replace(/\/$/, ""));
    else if (!args[i].startsWith("--")) dirs.push(args[i].replace(/^research\//, "").replace(/\/$/, ""));
  }
  const res = collect(dirs);
  if (asJson) {
    console.log(JSON.stringify({ ...res, candidate: [...res.candidate.values()] }, null, 2));
  } else {
    console.log(render(res));
  }
}
