// scripts/check-web-numbers.js
// 联网数字回链核验：把正文里挂了外链的每个数字，回到**那个链接的页面**里用数字本身搜一遍。
//
// ## 为什么需要它（机器质检的第二条腿）
//
// `research-qc.js` 的数字对账只比对本地 `data/`，**结构上看不见联网来源**——而 searchX
// 的事实主要来自 WebSearch，真正反复出事的正是联网这条腿：
//   · 2026-08-15 智谱那篇 16 条硬错，根因是「搜索摘要 ≠ 所引链接的内容」；
//   · 2026-08-16 中际旭创那篇，机器质检硬红线 0、取数点全覆盖、判别力 93%，看着很干净，
//     核验员仍抓出 6 条硬错，其中三条就是「数字挂错来源 / 数字压根不在页内 / 同页两种
//     情形的数字被并成一对」。
// 这两次都靠 LLM 核验员抓到，代价是「核验员有没有真去抓链接、真去搜数字」无从验证，
// 且它只框承重项十几二十条。本模块把那个动作做成确定性的、可复现的、覆盖全量的一遍。
//
// ## 一条不许破的线：它不是闸
//
// **本模块永远不挡 push，没有 `--strict`。** 抓取成败不可控——JS 渲染的骨架页（实测
// 36kr 正文只有 2KB）、PDF、反爬、墙内网络抖动，都会让「搜不到」这个信号失真。做成硬闸
// 等于让网络状况决定报告能不能发，违反本项目「绝不因取数失败而中断出报告」。
// 所以口径是**非对称**的：
//   · 搜到了 → 确定性的强证据，这个数字与这条来源的配对成立；
//   · 搜不到 → 只是**嫌疑**，交给 Step 5.5 核验员②去质证，不下判决；
//   · 没抓到 → 如实写「未测」，绝不当通过（同 research-qc 的规矩）。
//
// ## 与既有代码的分工（不重复造）
//
// - `scripts/check-sources.js` 管 **sources.md ⊇ report.html**（URL 集合层面）——本模块不碰；
// - `scripts/research-qc.js` 管**本地 `data/` 的数字对账 + 格式红线**，秒级、不联网、可复现，
//   本模块不并进去：一并进去就会把它变成一个要联网几十秒的东西，毁掉它最有价值的性质。
//   数字提取直接 import 它的 `reportNumbers`，口径分家会让两份清单对不上。
//
//   bun run scripts/check-web-numbers.js --dir <归档目录名>              # 核一篇
//   bun run scripts/check-web-numbers.js --dir <x> --challenge           # 输出喂给 Step 5.5 的质证清单
//   bun run scripts/check-web-numbers.js --dir <x> --max-urls 20         # 限制抓取条数（默认 60）
//   bun run scripts/check-web-numbers.js --dir <x> --no-skip-local       # 连能对回 data/ 的数字也一起核

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { reportNumbers, runQc } from "./research-qc.js";

const ARCHIVE = "research";

// ========== HTML → 带链接的块 ==========

// 块边界。**不切 `</td>`**：表格里「营收 | 108.96 亿 | <a>来源</a>」是分在三个单元格的，
// 按 td 切会让数字和链接落进不同块、数字失去归属（漏核）。按 `</tr>` 切，一行是一个块。
const BLOCK_END_RE = /<\/(?:p|li|tr|div|h[1-6]|dd|dt|blockquote|section|figcaption)>/gi;

export function stripTags(html) {
  return String(html || "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

// 把 report.html 切成 [{text, urls}]。只保留**含至少一个外链**的块——没有链接的数字
// 不属于「联网数字」，那是 research-qc 数字对账的活，这里不重复管。
export function blocksWithLinks(html) {
  const src = String(html || "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  const out = [];
  let last = 0;
  const pushBlock = (chunk) => {
    const urls = [];
    for (const m of chunk.matchAll(/href\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
      if (!urls.includes(m[1])) urls.push(m[1]);
    }
    if (!urls.length) return;
    const text = stripTags(chunk).replace(/\s+/g, " ").trim();
    if (text) out.push({ text, urls });
  };
  for (const m of src.matchAll(BLOCK_END_RE)) {
    pushBlock(src.slice(last, m.index));
    last = m.index + m[0].length;
  }
  pushBlock(src.slice(last));
  return out;
}

// ========== 待核数字的挑选 ==========

// 从块文本里挑**值得回链核**的数字。复用 research-qc 的 reportNumbers（已滤掉 URL、
// 时间、年份、证券代码、≤13 的整数），这里再加一道「辨识度」过滤：
// 不带小数、又没有 %／亿／万 单位的三位数以内整数（「3 家客户」「已有 200 人」），
// 在任何一个长网页里都几乎必然命中，核了等于没核，只会稀释清单。
// 「1.1–7.16 累计签单 146.53 亿元」里的 1.1 和 7.16 是**日期区间**，不是事实性数字。
// 股票报告的事件表里这种写法很常见，不滤掉就会在质证清单里堆一批永远核不上的噪声
// （2026-08-16 对芯原那篇真跑，challenge 前六条里有四条是它）。
// 判定收窄到三条同时成立：两侧都是「月.日」形态（月 1–12、日 1–31）、**至少一侧的日是两位**、
// 且**后面没有紧跟单位字**——这样「1.5–3.2 倍」「10.5–12.30 亿」这类真实数值区间不会被误伤
// （后一个例子是收尾复审时发现的：10 月 5 日–12 月 30 日与 10.5 亿–12.30 亿形态完全一样，
// 只有单位能分开它们，漏了这条会把一个真实的区间数据静默吞掉）。
const DATE_RANGE_RE =
  /(?<![\d.])(\d{1,2})\.(\d{1,2})\s*[–—~-]\s*(\d{1,2})\.(\d{1,2})(?![\d])(?!\s{0,2}[亿万元％%倍个家点千])/g;

export function stripDateRanges(text) {
  return String(text || "").replace(DATE_RANGE_RE, (m, m1, d1, m2, d2) => {
    const ok = (mo, d) => +mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31;
    const twoDigit = d1.length === 2 || d2.length === 2;
    return ok(m1, d1) && ok(m2, d2) && twoDigit ? " " : m;
  });
}

export function citedNumbers(blockText) {
  const out = [];
  for (const n of reportNumbers(stripDateRanges(blockText))) {
    const hasUnit = /^\s*(亿|万|%|％)/.test(n.tail || "");
    if (!n.raw.includes(".") && !hasUnit && Math.abs(n.value) < 1000) continue;
    out.push(n);
  }
  return out;
}

// ========== 数字在页内的几种写法 ==========

// 去掉浮点运算留下的尾巴（108.96 * 1e4 在 JS 里是 1089600.0000000001）。
function fmtNum(n) {
  if (!Number.isFinite(n)) return null;
  const s = Math.abs(n) >= 1e15 ? String(n) : Number(n.toPrecision(12)).toString();
  return s.includes("e") ? null : s;
}

function withThousands(s) {
  const [i, d] = String(s).split(".");
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (d ? "." + d : "");
}

// 同一个数在报告与网页里的常见写法差异：千分位有无、尾零、以及**单位换算**
// （报告写「108.96 亿元」，公告原文常写「10,896,000,000」或「1,089,600 万元」）。
//
// ⚠️ 变体要克制。这里的风险与 research-qc「真值池按单位展开」那个坑同源：候选越多，
// 在一个几万字的页面里碰巧命中的概率越高，「搜到了」这个强证据就越不强。所以只做
// **放大**方向（亿→万→元）这一种真实存在的换算，不做反向、不做任意倍缩放，且封顶 8 个。
export function numberVariants({ raw, value, tail }) {
  const out = [];
  const add = (s) => {
    if (s && !out.includes(s)) out.push(s);
  };
  add(raw);
  add(raw.replace(/,/g, ""));
  add(withThousands(raw.replace(/,/g, "")));
  if (raw.includes(".")) add(raw.replace(/0+$/, "").replace(/\.$/, "")); // 61.70 → 61.7
  else add(raw + ".0");

  const u = (String(tail || "").match(/^\s*(亿|万)/) || [])[1];
  if (u === "亿") {
    for (const k of [1e4, 1e8]) {
      const s = fmtNum(value * k);
      add(s);
      if (s) add(withThousands(s));
    }
  } else if (u === "万") {
    const s = fmtNum(value * 1e4);
    add(s);
    if (s) add(withThousands(s));
  }
  return out.slice(0, 8);
}

// 在页面文本里找一个数字串。**必须卡数字边界**：直接 indexOf("61.7") 会在页面的
// 「161.7」「61.75」里命中，把不存在的配对报成存在——那正好是本模块最该避免的错误方向
// （假「搜到」＝ 放过一条真硬错）。
//
// ⚠️ 边界还必须**卡住千分位串的两头**。只写 `(?![\d])` 是不够的：「108.96 亿」的万元候选
// 是 `1,089,600`，而页面若写着 `1,089,600,000`（10.896 亿，差 1000 倍），逗号不是数字、
// 后置断言照样放行——本文件的测试当场抓到过这个。所以再加两条：前面不许是「数字逗号」
// （自己是更长串的尾段），后面不许是「逗号数字」（串还没结束）。
//
// ⚠️ **整数不许白捡小数的整数部分**（2026-09-23 对 22 篇存量实测）。右边界 `(?![\d])` 不挡小数点，
// 于是整数「18」会在「18.15」里命中。normalizePage 不再把相邻数字粘成一串以后，行情侧栏
// （「锦华新材920015 18.15」）、PDF 表格（「38,768,964 20.94 8.00」）里的独立小数一下子多了，
// 这个缺口开始成批造假命中：「18 亿港元」→ 侧栏股价 18.15、「20 亿元」→ 表格里的 20.94。
// 可一刀切掉也不行：同批数据里整数命中小数前半的 26 处，多数是报告的合理四舍五入
// （「382 亿」← 页面「382.4亿元」、「4626 万」←「4626.39万元」、「1034%」←「1034.18%」）。
// 所以整数碰上「N.xx」时只在两条**同时**成立时才认：
//   ① 四舍五入对得上（小数部分 < 0.5）——「20」对「20.94」不认；
//   ② 页面那个小数后面**紧跟**与报告同一个单位字（`unit`，亿/万/%/吨…）——四舍五入对上只说明
//      数值挨得近，单位也对上才说明是同一个量。实测这条把侧栏股价「18.15新浪」、股价「30.37元」
//      （报告写的是「30%」）、型号「V64.3A」（报告是「64%」）、券商列表「60.86%」（报告是「60 亿」）
//      全部挡掉，而上面那几条合理四舍五入全都紧跟同单位，照样命中。
// 小数部分全是 0（「21.0%」「15,000,000.00」）就是同一个数，与裸数字命中同等对待。
// 不传 `unit` 时（换算来的写法、或报告那个数本身没带单位），「N.xx」一律不认。
//
// `requireUnit`：连完整命中也要紧跟同单位才认。给**千以内的整数**用（matchNumberInPages 决定）——
// 这类数只因为带了 亿/万/% 才进待核清单（citedNumbers），数值本身毫无辨识度。2026-09-23 对 22 篇
// 存量实测：这类原样命中 161 条里有 31 条，页内找不到任何一处紧跟同单位的写法，逐条看几乎全是
// 撞上了别的东西——「20 亿美元」←「20-year」「20 weeks」、「88%」← 链接里的「…7r88HJVuo…」、
// 「40%」← 图表坐标轴「100 80 60 40 20 0」、「30%」←「10:30」、「90 亿美元」←「90% of」、
// 「200 亿美元」←「$200 million」。而且它排在英文 billion 那档前面，撞上了就轮不到真写法去对。
// 英文页面把 % 写成 percent / per cent 的，照认。
export function containsNumber(pageText, needle, { unit = null, requireUnit = false } = {}) {
  const text = String(pageText || "");
  const s = String(needle);
  const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\d.])(?<!\\d,)${esc}(?![\\d])(?!,\\d)`, "g");
  let start = 0;
  const unitOk = (i) => unitMatchesAt(text, i, unit, text[start - 1]);
  const whole = (i) => !requireUnit || unitOk(i);
  for (const m of text.matchAll(re)) {
    start = m.index;
    const end = m.index + m[0].length;
    if (s.includes(".")) {
      if (whole(end)) return true;
      continue;
    }
    const frac = text.slice(end).match(/^\.(\d+)/);
    if (!frac) {
      if (whole(end)) return true;
      continue;
    }
    const after = end + frac[0].length;
    if (/^0+$/.test(frac[1])) {
      if (whole(after)) return true;
      continue;
    }
    if (Number(`0.${frac[1]}`) < 0.5 && unitOk(after)) return true;
  }
  return false;
}

// 数字后面紧跟的「单位字」：百分号或一个汉字（归一后数字与单位之间已没有空白）。繁简、全半角先归一，
// 「萬」「億」「％」分别当「万」「亿」「%」。空格、数字、英文字母、标点都不算单位——
// 英文页面去空白后数字常直接粘着单词（「36.69%CAGR」「0.11and」），字母读不出单位。
const UNIT_FOLD = { "％": "%", "萬": "万", "億": "亿" };
function foldUnit(c) {
  if (!c) return null;
  const f = UNIT_FOLD[c] || c;
  return /^[%\u4e00-\u9fff]$/.test(f) ? f : null;
}
export function unitCharAt(text, i) {
  return foldUnit(String(text || "")[i]);
}
// 报告那个数自己的单位：数字后面第一个非空白字符（「 亿港元」→ 亿、「%）」→ %、「 吨 +」→ 吨）。
// 「）」「，」这类标点不是单位，返回 null。
// 「万亿」是一个单位（10^12），单拿「万」会把「33 万亿美元」读成 33 万——单独认出来。
export function reportUnit(tail) {
  const t = String(tail || "").replace(/^\s+/, "");
  if (/^(?:万亿|萬億)/.test(t)) return "万亿";
  return foldUnit(t[0]);
}

// 页面第 i 个字符起，是不是报告那个单位。除了同一个字，还认英文页面的两种等价写法：
// % ↔ percent / per cent；万亿 ↔ trillion / tn，或紧跟 $ 的单字母 t（「$33t」，同 billion 那档的
// 单字母规矩——没有 $ 前缀的 t 不认，「33tons」「33times」满篇都是）。`prev` 是数字前一个字符。
export function unitMatchesAt(text, i, unit, prev) {
  if (!unit) return false;
  const t = String(text || "");
  if (unit === "万亿") {
    if (/^(?:万亿|萬億)/.test(t.slice(i, i + 2))) return true;
    return /^(?:trillion|tn)/i.test(t.slice(i, i + 8)) || (prev === "$" && /^t/i.test(t[i] || ""));
  }
  if (unitCharAt(t, i) === unit) return true;
  return unit === "%" && /^per ?cent/i.test(t.slice(i, i + 8));
}

// 页面文本归一：删空白，但**两个数字之间要留一个分隔**。网页里「61.7 %」「108.96 亿元」中间常夹
// 空格或换行，不归一会把本来在页内的数字判成不在；可 PDF 与英文表格里相邻数字往往**只隔空白**
// （pdftotext 把「3,016,714,649.18 / 2,573,139,460.90」吐成两行），一律删光就粘成
// 「3,016,714,649.182,573,139,460.90」——containsNumber 的数字边界当然卡不住、pageNumbers 也抽成一个
// 怪数。2026-09-18 对英维克半年报 PDF 实测：1826 个独立成行的小数里 87% 原样搜不到、全部退成
// 弱档「换算命中」；英文页面「2024 2025 108.96 61.7」则直接漏判。
// 规则：前一个字符是数字、后一个是数字（或负号接数字）时保留一个空格，其余空白全删。
export function normalizePage(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/(?<=\d) (?=\d|-\d)/g, "\u0000")
    .replace(/ /g, "")
    .replace(/\u0000/g, " ");
}

// 亿 / 万 对英文页面的写法：报告写「200 亿美元」，CNBC 写「$20 billion」；「1300 万颗」对应
// 「13 million」。SKILL 明写科技类优先英文一手来源，缺这一档等于把英文来源整批报成假嫌疑
// （2026-09-18 对 nvidia 那篇实跑：14 条「搜不到」里近半是这个形态）。
// ⚠️ **必须带单位词**，不能把 200亿→「20」当裸数字候选：日期、章节号里的 20 满篇都是，裸数字候选
// 会让「已找到」这档恒命中。归一后数字与字母之间的空白已删（「20 billion」→「20billion」），
// 所以直接匹配「数字+单位词」；量级比对那一档**不加**这些倍数（它不读单位，加了就是同一个坑）。
export function unitWordPatterns({ raw, value, tail }) {
  const u = (String(tail || "").match(/^\s*(亿|万)/) || [])[1];
  if (!u) return [];
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 归一后字母之间的空白也没了（「13 million HBM」→「13millionHBM」），所以**不能**在单位词后面
  // 加「不许接字母」的守卫——全词 billion/million/thousand 与两字母 bn/mn 本身够独特，直接认；
  // 单字母 B/M/K 太短（「13m」会在「13 months」→「13months」里命中），只在紧跟 $ 前缀
  // （「$55.05B」）或后面不是字母时才认。
  const mk = (n, full, short, label) => {
    const s = fmtNum(n);
    if (!s) return null;
    const N = esc(s);
    const re = new RegExp(
      `(?:(?<![\\d.])${N}[-–]?(?:${full})|\\$${N}[-–]?${short}|(?<![\\d.])${N}[-–]?${short}(?![a-z]))`,
      "i"
    );
    return { re, label };
  };
  const out = [];
  if (u === "亿") {
    out.push(mk(value / 10, "billion|bn", "b", "billion"));
    out.push(mk(value * 100, "million|mn", "m", "million"));
  } else {
    out.push(mk(value / 100, "million|mn", "m", "million"));
    out.push(mk(value * 10, "thousand", "k", "thousand"));
  }
  return out.filter(Boolean);
}

// 亿 ↔ 百萬 / 百万（×100）：港股公告的标准写法。报告写「313.75 亿港元」，配售公告原文是
// 「31,374.95百萬港元」；「48.96 亿港元」对「4,896.2百萬港元」。报告写的是四舍五入值，原文是精确到
// 小数的百萬数，精确串永远对不上，所以这一档**按数值比对**：容差取报告写出的精度并随 ×100 缩放
// （同 scaledCandidates 的 precisionTol）。
// 与 billion / million 那档同一条规矩：**页面上那个数后面必须紧跟「百萬 / 百万」**才算——单位词在，
// 才能说这是同一个量；表头写「人民幣百萬元」、单元格里是裸数的表格不在这一档管（已知局限）。
// 证据强弱照实分：数值**正好相等**（「2.789 亿」对「278.90百萬」）算强证据；靠四舍五入容差对上的
// 标成换算命中（弱档）——港股公告满篇「xx.x百萬」，小数字的容差窗照样会撞上别的科目
// （实测「0.23 亿元」购置物业设备，撞上同一份公告里「23.4百萬」的另一项毛利）。
const BAIWAN_RE = /(?<![\d.,])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?=百[萬万])/g;
export function baiwanMatch({ raw, value, tail }, pageText) {
  if (reportUnit(tail) !== "亿") return null;
  const target = Math.abs(value) * 100;
  const tol = precisionTol(raw, value) * 100;
  let near = null;
  for (const m of String(pageText || "").matchAll(BAIWAN_RE)) {
    const v = Number(m[1].replace(/,/g, ""));
    if (Math.abs(v - target) > tol) continue;
    const shown = `${m[1]}${pageText.slice(m.index + m[1].length, m.index + m[1].length + 2)}`;
    if (Math.abs(v - target) <= target * 1e-9) return { shown, exact: true };
    near ||= { shown, exact: false };   // 先记下，页内若另有正好相等的写法，以那个为准
  }
  return near;
}

// ========== 量级比对（字符串搜不到时的第二档） ==========

// 光靠字符串搜是不够的：**报告写的是四舍五入值，来源写的是精确值**。实测智谱那篇
// 「2025 年收入 7.24 亿元」，港交所公告原文是千元单位的 `724,187`——主体、口径、数都对，
// 精确串却永远搜不到。只做字符串匹配的话，那一篇 85 个数字里有 38 个被报成待质证，
// 清单立刻失信（同 research-qc 的教训：误报一多就没人看了）。
//
// 所以补一档**按数值比对**：把页面里的数字串全抽成数值，再拿报告数字按单位缩放后的
// 候选值去够，容差取「报告写出的精度」并**随倍数一起缩放**（这个坑 research-qc 踩过——
// 缩放后仍用固定绝对容差，等于给小数字开了 22% 的窗口）。
const PAGE_NUM_RE = /(?<![\w.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;

export function pageNumbers(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(PAGE_NUM_RE)) {
    const v = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(v)) out.add(v);
  }
  return out;
}

// 量级比对要读页面上那个数**长什么样、后面跟着什么**，光有数值集合不够，所以按位置抽一遍：
// {v 数值, s 原串, next 紧跟的 4 个字符}。外加两个页面级的单位线索：通篇有没有「万元」「千元」
// 这类口径词（表格常把单位只写在表头，单元格里是裸数）。每个页面只抽一次（classify 里缓存）。
const WAN_CTX_RE = /[万萬](?:元|股|美元|港元)/;
const QIAN_CTX_RE = /千(?:元|股|美元|港元)|thousand|['’]000/i;
export function pageIndex(text) {
  const t = String(text || "");
  const toks = [];
  for (const m of t.matchAll(PAGE_NUM_RE)) {
    const v = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(v)) continue;
    const end = m.index + m[1].length;
    toks.push({ v, s: m[1], next: t.slice(end, end + 4) });
  }
  return { toks, wan: WAN_CTX_RE.test(t), qian: QIAN_CTX_RE.test(t) };
}

// 报告写出的精度对应的容差：写到哪一位就允许那一位的半个单位（写「7.24」就允许 ±0.005），
// 再兜一个 0.05% 的相对下限。
function precisionTol(raw, value) {
  const s = String(raw);
  const dot = s.indexOf(".");
  const dec = dot === -1 ? 0 : s.length - dot - 1;
  return Math.max(0.5 * Math.pow(10, -dec), Math.abs(value) * 5e-4);
}

// 报告数字 → [{v, tol, label}]。只做**放大**方向（亿→万→千→元）这一种真实存在的换算，
// 「千元」这一档是港交所与 A 股公告的常用口径，漏了它就会整批漏掉一手披露类来源。
export function scaledCandidates({ raw, value, tail }) {
  const tol = precisionTol(raw, value);
  const out = [{ v: value, tol, label: "原值" }];
  const push = (k, label) => out.push({ v: value * k, tol: tol * k, label });
  const u = (String(tail || "").match(/^\s*(亿|万|%|％)/) || [])[1];
  if (u === "亿") { push(1e4, "万元"); push(1e5, "千元"); push(1e8, "元"); }
  else if (u === "万") { push(10, "千元"); push(1e4, "元"); }
  else if (u === "%" || u === "％") push(1e-2, "小数比率");
  return out;
}

// 数值挨得上之后，还要页面上那个数**像是这个口径的数**才算（2026-09-23 对 22 篇存量逐条对账后定的）。
// 早先这一档只比数值，数字不再粘连以后，侧栏股票代码、URL 里的编号、别的量的小数成批撞进容差窗：
// 「92 亿美元」的万元候选 920000 撞上侧栏代码「华大海天920288」、「69 亿美元」撞上股价「$68.99」、
// 「2.4 万元」的千元候选 24 撞上链接里的「…/24dGR」、「270 亿元」撞上「单位：元」表里的 27,040,815.86。
// 判据按档：
//   · 原值：页面那个数后面紧跟单位字的，必须与报告同一个单位（「66.89亿元」对「67 亿」认、
//     「18.15新浪」对「18 亿」不认）；后面没有单位字（表格单元格、英文句子）的，只在报告写到了
//     小数位时才认——整数的 ±0.5 窗口在数字密的页面上几乎总能碰上一个（实测「603305」撞上
//     另一只股票代码「603271」、「688691」撞上「688521」，都是这个形态）。
//   · 万元 / 千元：后面紧跟「万」/「千」直接认；紧跟**别的**单位（亿、百萬、元、%、billion…）不认
//     （「0.23 亿」的万元候选 2,300 撞上「2,259.1百萬元」就是这个）；什么都不跟的（表格单元格），
//     要「长得像金额」（带千分位或小数点，挡掉股票代码、编号）**且**页面里确有「万元」/「千元」
//     类口径词才认。实测 A 股公告表格「121,138.73」（通篇万元）、港股「2,259,147」（人民幣千元）、
//     华虹「2,003,993」（US$ thousands）都靠这条留下。
//   · 元：紧跟别的量级单位不认；否则要带千分位，或紧跟「元」「股」。
//   · 小数比率：沿用旧口径（本轮没有对账出反例，不动）。
// ⚠️ 仍然只是「页面里有个数在这个口径下对得上」，不证明它就是报告说的那个量——同一张表里别的
// 科目碰巧落进容差（实测「3.8 亿」撞上标的公司营收 38,466.41 万元）判不了，那是核验员的活。
const OTHER_MAG_RE = /^(?:亿|億|百[萬万]|%|％|billion|bn|million|mn|thousand)/i;
function magnitudeEvidence(label, tok, idx, num) {
  const amountLike = /[.,]/.test(tok.s);
  switch (label) {
    case "原值": {
      const pu = unitCharAt(tok.next, 0);
      if (pu) return unitMatchesAt(tok.next, 0, reportUnit(num.tail));
      return String(num.raw).includes(".");
    }
    case "万元":
      if (/^[万萬]/.test(tok.next)) return true;
      if (OTHER_MAG_RE.test(tok.next) || /^[千元]/.test(tok.next)) return false;
      return amountLike && idx.wan;
    case "千元":
      if (/^千/.test(tok.next)) return true;
      if (OTHER_MAG_RE.test(tok.next) || /^[万萬元]/.test(tok.next)) return false;
      return amountLike && idx.qian;
    case "元":
      if (OTHER_MAG_RE.test(tok.next) || /^[万萬千]/.test(tok.next)) return false;
      return tok.s.includes(",") || /^[元股]/.test(tok.next);
    default:
      return true;
  }
}

// ⚠️ 固有局限，别指望它判得出：页面单位只读「紧跟的那个字」和「通篇有没有口径词」，读不了表头
// 与单元格的对应关系。页面写的「72,418」按万元读正好是 7.2418 亿，落在「7.24 亿」的容差内 ——
// 页面若通篇有「万元」，这是**该命中**的；但若那个 72,418 所在的表其实是「元」，它也照样命中。
// 所以命中只证明「这一页里有个数与报告的数在某个口径下对得上」，不证明口径本身没错配。
// 口径错配（2026-08-16 中际旭创那篇的第三条硬错）仍然只有核验员回到原文才判得了。
export function matchByMagnitude(num, idx) {
  for (const { v, tol, label } of scaledCandidates(num)) {
    for (const t of idx.toks) {
      if (Math.abs(v - t.v) <= tol && magnitudeEvidence(label, t, idx, num)) return { hit: true, label, found: t.v };
    }
  }
  return { hit: false };
}

// 一个数字在一批已抓到的页面里的核对结果。两档，**精确串优先**——「页面里就写着 7.24」
// 比「页面里有个 724,187 换算得上」是强得多的证据，输出要能分清。
export function matchNumberInPages(num, pages) {
  const variants = numberVariants(num);
  // 每个写法对应的单位：与报告同值的写法用报告自己的单位；「亿」换成万元的写法用「万」；
  // 换成元的写法没有可比的单位字（给 null，containsNumber 就不认「N.xx」）。
  const ru = reportUnit(num.tail);
  const same = (x, y) => Math.abs(x - y) <= Math.abs(y) * 1e-9;
  const unitOf = (v) => {
    const x = Number(String(v).replace(/,/g, ""));
    if (same(x, num.value)) return ru;
    if (ru === "亿" && same(x, num.value * 1e4)) return "万";
    return null;
  };
  // 千以内的整数（只因带 亿/万/% 才进清单）连完整命中也要紧跟同单位（理由见 containsNumber）
  const small = !String(num.raw).includes(".") && Math.abs(num.value) < 1000;
  for (const p of pages) {
    for (const v of variants) {
      const unit = unitOf(v);
      const requireUnit = small && unit != null && unit === ru;
      if (containsNumber(p.text, v, { unit, requireUnit })) return { hit: true, url: p.url, form: `原样「${v}」` };
    }
  }
  // 英文单位词（billion / million）：带单位词的精确串，与「原样」同属强证据档。
  for (const p of pages) {
    for (const { re, label } of unitWordPatterns(num)) {
      const m = p.text.match(re);
      if (m) return { hit: true, url: p.url, form: `按英文 ${label} 口径原样搜到「${m[0]}」` };
    }
  }
  // 港股「百萬」：带单位词、按报告精度比数值；正好相等算强证据，靠容差对上算弱档（理由见 baiwanMatch）。
  for (const p of pages) {
    const m = baiwanMatch(num, p.text);
    if (m && m.exact) return { hit: true, url: p.url, form: `按百萬口径原样搜到「${m.shown}」` };
    if (m) return { hit: true, url: p.url, form: `按百萬口径换算命中「${m.shown}」`, scaled: true };
  }
  for (const p of pages) {
    const m = matchByMagnitude(num, p.idx || pageIndex(p.text));
    if (m.hit) return { hit: true, url: p.url, form: `按${m.label}口径换算命中 ${m.found}`, scaled: true };
  }
  return { hit: false, variants };
}

// 本轮比对的**判别力**：拿一批与正文同量级的凭空数字，看有多少能被判为「不在页内」。
//
// 为什么必须有（照搬 research-qc 的教训）：数值比对的强弱完全取决于页面的数字密度。
// 一份几千个数字的招股书，容差窗口里随便一个数都能碰上，此时「全部命中」什么也证明不了，
// 而**检查失效时反而显示得最漂亮**。所以让它自报家门：判别力低就明说这轮不作数。
// 固定种子，可复现（不用 Math.random，否则同一篇每次跑出不同结论）。
export function matchPower(items, samples = 200) {
  const withPages = items.filter((it) => it.pages && it.pages.length);
  if (!withPages.length) return null;
  let s = 987654321;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  let caught = 0;
  for (let i = 0; i < samples; i++) {
    const base = withPages[Math.floor(rnd() * withPages.length)];
    const v = Number((Math.abs(base.value) * (0.2 + rnd() * 3)).toFixed(2));
    const fake = { raw: v.toFixed(2), value: v, tail: base.tail };
    if (!matchNumberInPages(fake, base.pages).hit) caught += 1;
  }
  return caught / samples;
}

// ========== 抓取 ==========

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// 正文太短 = 多半是 JS 渲染的骨架（实测 36kr 详情页剥完标签只剩约 2KB，正文根本没在
// HTML 里）。这种页面**必须判「未测」**，否则一篇报告里挂了几条这类链接，就会批量
// 报出「数字不在页内」的假嫌疑，清单立刻失信、下次没人看。
const MIN_RENDERED_CHARS = 800;

export function looksUnrendered(text) {
  return normalizePage(text).length < MIN_RENDERED_CHARS;
}

// 外部程序的定位：先按 PATH 找，找不到再试 Homebrew / MacPorts 的固定安装位。
// 非交互 ssh、裸 launchd 这类环境只有系统 PATH（实测 Mac mini 上 `ssh mac-mini` 里是
// /usr/bin:/bin:/usr/sbin:/sbin，连 brew 都找不到），装了 poppler 也会静默「未测」。
// runner 自己的 scheduled-run.sh 已经补了 /opt/homebrew/bin，这里是给其它启动方式兜底。
// 同 CLAUDE.md「路径用固定值 + 环境变量可覆盖」：SEARCHX_PDFTOTEXT / SEARCHX_ICONV 可强制指定。
const BIN_FALLBACKS = {
  pdftotext: ["/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext", "/opt/local/bin/pdftotext"],
  iconv: ["/usr/bin/iconv", "/opt/homebrew/bin/iconv"],
};
export function resolveBin(name, { env = process.env, which = (n) => Bun.which(n), exists = (p) => existsSync(p) } = {}) {
  const forced = env[`SEARCHX_${name.toUpperCase()}`];
  if (forced) return forced;
  const onPath = which(name);
  if (onPath) return onPath;
  for (const p of BIN_FALLBACKS[name] || []) if (exists(p)) return p;
  return null;
}

// 从 HTTP 响应体解码出文本。绝大多数来源是 UTF-8；GBK 系（老财经站）用 iconv 兜底——
// bun 的 TextDecoder 不认 "gbk"（实测抛 Unsupported encoding label）。
async function decodeBody(buf, contentType) {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, 4096));
  const declared = (
    (contentType || "").match(/charset=([\w-]+)/i) ||
    head.match(/charset=["']?([\w-]+)/i) ||
    []
  )[1];
  if (declared && /gb(2312|k|18030)/i.test(declared)) {
    try {
      const bin = resolveBin("iconv");
      if (!bin) throw new Error("iconv 不可用");
      const p = Bun.spawn([bin, "-f", "gb18030", "-t", "utf-8"], {
        stdin: new Uint8Array(buf),
        stdout: "pipe",
        stderr: "ignore",
      });
      const t = await new Response(p.stdout).text();
      if (t) return t;
    } catch {
      /* iconv 不可用 → 退回 utf-8 尽力而为 */
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

// 返回的内容是不是 PDF：看文件头「%PDF-」（按 PDF 规范可以出现在前 1024 字节内），不看链接后缀、
// 也不按域名写死。2026-09-23 实测：上交所 static.sse.com.cn 的公告 PDF 链接对脚本回 200 + text/html，
// 内容是 7KB 的反爬 JS 挑战页（`var arg1=…`），另有 sinoss.net 的 .pdf 链接回的是整张网页。原先按
// 后缀送进 pdftotext、失败后报「缺 pdftotext 或为扫描件」——在 runner 刚补好 pdftotext 之后又报一次
// 「缺 pdftotext」，排查方向全错。所以：内容里没有 PDF 文件头，就如实说它是什么。
export function looksLikePdf(buf) {
  const bytes = new Uint8Array(buf).subarray(0, 1024);
  return String.fromCharCode(...bytes).includes("%PDF-");
}
export function notPdfNote(buf, ct) {
  const head = String.fromCharCode(...new Uint8Array(buf).subarray(0, 512)).replace(/^\u00EF\u00BB\u00BF/, ""); // UTF-8 BOM 按字节读出来是这三个字符
  if (/html/i.test(ct) || /^\s*</.test(head)) return "返回的是网页不是 PDF（可能是反爬验证页）";
  return `返回的内容不是 PDF（content-type: ${ct || "未声明"}）`;
}

// PDF 走 pdftotext（poppler）。**没装就如实报「未测」**，不猜、不当成搜不到——
// 智谱那篇 20 条来源是 pdf.dfcfw.com，把它们误报成「数字不在页内」等于毁掉整份清单。
async function pdfToText(buf) {
  try {
    const bin = resolveBin("pdftotext");
    if (!bin) return null;
    const p = Bun.spawn([bin, "-q", "-", "-"], {
      stdin: new Uint8Array(buf),
      stdout: "pipe",
      stderr: "ignore",
    });
    const t = await new Response(p.stdout).text();
    return t || null;
  } catch {
    return null;
  }
}

// 抓一个 URL → {ok, text} 或 {ok:false, note}。**任何异常都吞掉**（同 research-qc：
// 质检绝不能弄死一份跑了几十分钟的报告）。
// https 被拒就换 http 再试一次：巨潮 static.cninfo.com.cn 对部分主机的 https 回 403、http 正常
// （2026-09-18 Mac mini 实测：https 403 / http 200，MacBook 两者都通），而它是最主要的披露级来源。
// 只在「https 且 403」这一种情形降级，且只降一次；结果里 note 写明走了 http，别让人以为原链接通。
// 代价要认：http 抓回来的内容没有传输层完整性保证。本模块只是核验辅助、不是闸，而且比对的是
// 「报告数字在不在页内」，被篡改成恰好等于报告数字的概率可以忽略。
export async function fetchPage(url, { timeout = 12000, fetchImpl = fetch, _retried = false } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetchImpl(url, {
      signal: ctl.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/pdf,*/*" },
    });
    if (!res.ok) {
      if (res.status === 403 && !_retried && /^https:/i.test(url)) {
        clearTimeout(timer);
        const r = await fetchPage(url.replace(/^https:/i, "http:"), { timeout, fetchImpl, _retried: true });
        return r.ok ? { ...r, note: "https 403，改走 http 抓到" } : { ok: false, note: `HTTP 403（换 http 再试：${r.note}）` };
      }
      return { ok: false, note: `HTTP ${res.status}` };
    }
    const ct = res.headers.get("content-type") || "";
    const buf = await res.arrayBuffer();
    // 是不是 PDF 看返回的内容本身（文件头），链接后缀与 content-type 只用来判断「本该是 PDF」。
    if (looksLikePdf(buf)) {
      if (!resolveBin("pdftotext")) return { ok: false, note: "PDF 未能提取文本（找不到 pdftotext）" };
      const t = await pdfToText(buf);
      if (!t) return { ok: false, note: "PDF 未能提取文本（pdftotext 没抽出文字，疑为扫描件或加密）" };
      return { ok: true, text: normalizePage(t) };
    }
    if (/pdf/i.test(ct) || /\.pdf$/i.test(new URL(url).pathname)) {
      return { ok: false, note: notPdfNote(buf, ct) };
    }
    const html = await decodeBody(buf, ct);
    const text = stripTags(html);
    if (looksUnrendered(text)) return { ok: false, note: "页面正文过短，疑似 JS 渲染未落到 HTML" };
    return { ok: true, text: normalizePage(text) };
  } catch (e) {
    return { ok: false, note: e.name === "AbortError" ? "超时" : `抓取失败（${e.message}）` };
  } finally {
    clearTimeout(timer);
  }
}

// 带并发上限地抓一批 URL。
async function fetchAll(urls, { timeout, concurrency = 4, onProgress } = {}) {
  const map = new Map();
  let i = 0;
  const worker = async () => {
    while (i < urls.length) {
      const url = urls[i++];
      map.set(url, await fetchPage(url, { timeout }));
      onProgress?.(map.size, urls.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return map;
}

// ========== 主流程 ==========

// 上下文自称是推算出来的（「据两数推算」「＝382.40−250.05」）。**只标注、不排除**——
// 自称推算也可能是编的，那正是核验员该看的。标出来是为了让清单好读：核验员一眼能分出
// 「这条是派生值，核推算过程」还是「这条声称有来源，核来源」。
const DERIVED_RE = /推算|测算|折算|反算|据.{0,6}算|[＝=]\s*[\d(（]/;

// 组装待核清单。
//
// `localValues` = 能对回本地 `data/` 的数值集合。**本模块只管「联网数字」**——一个能在
// 自家取数里找到的数，不是联网来的，它归 research-qc 的数字对账管，重复列进来只会稀释
// 清单。2026-08-16 对中际旭创那篇真跑，14 条待质证里 11 条正是这一类（上下文明写
// 「取自 Stocks 库财务表」），噪声占了八成。
// 传 null 表示**没有 data/ 可比**（那台机器上取数没留档），此时一个都不排除——
// 「没测」绝不能当成「测过了」。
//
// ⚠️ **这一层的代价要认**（加一层保护先问是不是拆了另一层）：一个数字如果既能对回 `data/`、
// 又挂了条不相干的外链，排除之后 5.4b 不再看它，而 5.4a 只会说「对上了」——**「链接挂错」
// 这件事对这类数字就没人管了**。换来的是清单可读（实测噪声占八成），这笔交换是划算的，
// 但需要全量看时用 `--no-skip-local` 关掉它。
export function planChecks(html, { maxUrls = 60, localValues = null } = {}) {
  const blocks = blocksWithLinks(html);
  const items = [];
  const urls = [];
  let skippedLocal = 0;
  for (const b of blocks) {
    const nums = citedNumbers(b.text).filter((n) => {
      if (localValues && !localValues.has(n.value)) {
        skippedLocal += 1;
        return false;
      }
      return true;
    });
    if (!nums.length) continue;
    for (const u of b.urls) if (!urls.includes(u)) urls.push(u);
    for (const n of nums) {
      items.push({ ...n, urls: b.urls, derived: DERIVED_RE.test(n.context) });
    }
  }
  return { items, urls: urls.slice(0, maxUrls), urlsTotal: urls.length, skippedLocal };
}

// 取「对不回 data/ 的数值」集合。直接复用 research-qc 的 runQc——**口径必须同一份**，
// 各写一套对账逻辑就会出现「那边说对上了、这边说没有」的分家。
// 没有 data/（或质检没跑成）→ 返回 null，表示无从排除。
export function localUnmatchedValues(dirName, root = ARCHIVE) {
  try {
    const qc = runQc(dirName, root);
    if (!qc.ok || !qc.dataPresent) return null;
    return new Set(qc.numbersUnmatched.map((u) => Number(String(u.value).replace(/,/g, ""))));
  } catch {
    return null;
  }
}

export function classify(items, fetched) {
  const confirmed = [];
  const notFound = [];
  const untested = [];
  const scored = [];
  // 每个页面的数值集合只抽一次：一篇报告里同一条来源会被十几个数字共用，
  // 每次重抽一份几千个数的集合是白烧时间。
  const idxCache = new Map();
  const idxOf = (url, text) => {
    if (!idxCache.has(url)) idxCache.set(url, pageIndex(text));
    return idxCache.get(url);
  };
  for (const it of items) {
    const pages = it.urls
      .map((u) => ({ url: u, ...(fetched.get(u) || { ok: false, note: "未抓取（超出上限）" }) }))
      .filter((p) => p.ok)
      .map((p) => ({ ...p, idx: idxOf(p.url, p.text) }));
    if (!pages.length) {
      const notes = it.urls.map((u) => `${u}（${fetched.get(u)?.note || "未抓取"}）`);
      untested.push({ ...it, notes });
      continue;
    }
    scored.push({ ...it, pages });
    const r = matchNumberInPages(it, pages);
    if (r.hit) confirmed.push({ ...it, url: r.url, form: r.form, scaled: Boolean(r.scaled) });
    else notFound.push({ ...it, tried: pages.map((p) => p.url) });
  }
  return { confirmed, notFound, untested, power: matchPower(scored) };
}

export async function verifyArchive(dirName, opts = {}) {
  const root = opts.root || ARCHIVE;
  const reportPath = join(root, dirName, "report.html");
  const base = { dir: dirName, ok: false, confirmed: [], notFound: [], untested: [] };
  try {
    if (!existsSync(reportPath)) return { ...base, error: `${join(dirName, "report.html")} 不存在` };
    const html = readFileSync(reportPath, "utf8");
    const localValues = opts.localValues !== undefined ? opts.localValues : localUnmatchedValues(dirName, root);
    const { items, urls, urlsTotal, skippedLocal } = planChecks(html, { ...opts, localValues });
    const meta = { urlsTotal, skippedLocal, hasLocalData: localValues != null };
    if (!items.length) return { ...base, ok: true, ...meta, urlsFetched: 0 };
    const fetched = await fetchAll(urls, opts);
    const failed = [...fetched.values()].filter((r) => !r.ok).length;
    return {
      ...base, ok: true, ...classify(items, fetched), ...meta,
      urlsFetched: urls.length, urlsFailed: failed,
    };
  } catch (e) {
    return { ...base, error: e.message };
  }
}

// ========== 输出 ==========

// 措辞纪律（照搬 research-qc 的教训）：**「搜不到」一律叫「待质证」，不叫「错误」**。
// 块内可能挂了不止一条来源、页面可能有分页、数字可能以中文数词写出——机器判不了这些，
// 报成「错误」会诱导为了有所交代去改本来对的地方。
export function renderReport(r) {
  const L = [];
  L.push(`🔗 联网数字回链核验 · ${r.dir}`);
  if (!r.ok) {
    L.push(`  ⛔ 未跑完（${r.error || "未知原因"}）——按「未测」对待，别当通过`);
    return L.join("\n");
  }
  const total = r.confirmed.length + r.notFound.length + r.untested.length;
  if (!total) {
    L.push("  ○ 正文里没有「挂了外链的数字」可核（本检查只管数字与它所挂来源的配对）");
    return L.join("\n");
  }
  L.push(
    `  · 待核 ${total} 个联网数字，抓取来源 ${r.urlsFetched}/${r.urlsTotal} 条` +
      (r.urlsFailed ? `（${r.urlsFailed} 条没抓到）` : "")
  );
  L.push(
    r.hasLocalData
      ? `  · 另有 ${r.skippedLocal} 个数字能对回本地 data/，不属联网数字，归 research-qc 数字对账管`
      : "  ○ 本篇无 data/ 取数留档，无法先筛掉「本就取自本地取数」的数字——下面的待质证清单会偏多"
  );
  const exact = r.confirmed.filter((c) => !c.scaled).length;
  L.push(
    `  ✅ 已在所挂页面内找到：${r.confirmed.length} 个` +
      `（${exact} 个原样搜到，${r.confirmed.length - exact} 个按亿/万/千元口径换算后对上）`
  );
  if (r.power != null) {
    const pct = Math.round(r.power * 100);
    if (r.power < 0.4) {
      L.push(`    ⚠️ **本轮比对判别力弱（${pct}%）**：所挂页面数字太密（招股书/年报常见），容差窗里随便一个数都能碰上——「找到了」基本说明不了问题，**别当作已核过**，该核的照旧回一手来源核。`);
    } else if (r.power < 0.8) {
      L.push(`    · 本轮比对判别力中等（${pct}%）：能抓住大部分对不上的数，但漏网仍有，不替代人工核对。`);
    } else {
      L.push(`    · 本轮比对判别力 ${pct}%：挂错来源的数字基本跑不掉。`);
    }
  }
  if (r.notFound.length) {
    L.push(`  ⚠️  抓到了页面、却搜不到这个数字：${r.notFound.length} 个（**待质证，不是判错**）`);
    for (const it of r.notFound.slice(0, 15)) {
      L.push(`      - ${it.raw}${it.derived ? "（上下文自称推算得来）" : ""}　…${it.context}…`);
      L.push(`        所挂来源：${it.tried.join(" ｜ ")}`);
    }
    if (r.notFound.length > 15) L.push(`      - （另有 ${r.notFound.length - 15} 条，从略）`);
  } else {
    L.push("  ✅ 抓到的页面里，每个数字都搜到了");
  }
  if (r.untested.length) {
    L.push(`  ○ 未测（所挂来源一条都没抓到）：${r.untested.length} 个——不算通过，该核的照旧回一手来源核`);
    const why = new Map();
    for (const it of r.untested) for (const n of it.notes) {
      const k = (n.match(/（(.+)）$/) || [, n])[1];
      why.set(k, (why.get(k) || 0) + 1);
    }
    L.push(`      原因分布：${[...why.entries()].map(([k, v]) => `${k} ×${v}`).join("、")}`);
  }
  return L.join("\n");
}

// 喂给 Step 5.5 核验员②的定向质证清单。只出「抓到了却搜不到」那一档——已确认的不必再看，
// 没抓到的机器说不出所以然（交给核验员按常规流程抓）。无发现 → 空串，不硬造质证点。
export function renderChallenge(r) {
  if (!r || !r.ok || !r.notFound.length) return "";
  const L = ["【联网数字回链核验（机器已抓页面，下列数字在所挂来源里搜不到——请逐条质证）】"];
  L.push(
    `说明：机器把这些页面抓下来、用数字的多种写法（原样／千分位／亿万换算）搜过，均未命中。` +
      `可能是数字挂错了来源、口径被并错、或该数根本不在页内（2026-08-16 中际旭创那篇的三条硬错都是这个形态）；` +
      `也可能是页面分页、数字以中文数词写出等机器判不了的情况。**逐条回到来源确认，别直接改。**`
  );
  for (const it of r.notFound.slice(0, 25)) {
    L.push(
      `- 数字「${it.raw}」${it.derived ? "（上下文自称是推算得来的——那就核推算过程与被减数／被除数本身有没有来源）" : ""}` +
        `——上下文：…${it.context}…`
    );
    L.push(`  所挂来源：${it.tried.join(" ｜ ")}`);
  }
  if (r.notFound.length > 25) L.push(`- （另有 ${r.notFound.length - 25} 条，同类从略）`);
  return L.join("\n");
}

// ========== CLI ==========

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => (argv.indexOf(k) !== -1 ? argv[argv.indexOf(k) + 1] : d);
  const dir = arg("--dir");
  if (!dir) {
    console.error("用法：bun run scripts/check-web-numbers.js --dir <归档目录名> [--challenge]");
    process.exit(2);
  }
  const challenge = argv.includes("--challenge");
  const r = await verifyArchive(dir.replace(/\/+$/, "").replace(/^research\//, ""), {
    // --no-skip-local：连「能对回 data/ 的数字」也一起回链核（清单会变长，但能查出
    // 「数字本身有本地取数支撑、却挂了条不相干外链」这类平时被筛掉的问题）
    localValues: argv.includes("--no-skip-local") ? null : undefined,
    maxUrls: Number(arg("--max-urls", 60)),
    timeout: Number(arg("--timeout", 12)) * 1000,
    concurrency: Number(arg("--concurrency", 4)),
    onProgress: challenge ? undefined : (a, b) => process.stderr.write(`\r  抓取 ${a}/${b}…   `),
  });
  if (!challenge) process.stderr.write("\r                    \r");
  const out = challenge ? renderChallenge(r) : renderReport(r);
  if (out) console.log(out);
  // 永远 0 退出：本模块不是闸（见文件头）。
}

if (import.meta.main) await main();
