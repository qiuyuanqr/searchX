// services/runner/src/dedup.js
// 查重：同一标的若已有「在时效窗口内」的报告，则不重复调研（省额度 + 引导提交者看现成报告）。
// 纯函数、可离线测；匹配只用 scanResearch 已产出的 entry 字段（type/tags/title/slug/date/href/tldr）。
// 设计取舍：匹配偏"宁可漏拦也少误拦"——漏拦最多多跑一次研究（不会死循环，研究会产出文件夹）；
// 误拦会把别的票的报告硬塞给提交者，更糟。故名称匹配以"精确"为主、包含为辅且双方都需 ≥3 字。

// 查重时效窗口（天）默认值——全项目唯一权威：runner 的 config.js、浏览器端 feed.js
// 都从这里 import，不各自硬编码，避免"改一处另两处不动"（见 docs/ARCHITECTURE.md 技术债 2）。
// 2026-08-10 由 30 天收紧到 20 天：股票报告是约 13 周的时点快照，但行情与基本面变得比
// 原先估计的快（存储双雄上市那次，14 天前发生的事就已经让在写的报告过时了）。
export const DEFAULT_DEDUP_WINDOW_DAYS = 20;

// 日历天差：toYMD - fromYMD（按日期，时区无关）。日期坏 → 返回 Infinity（视为极旧，不拦：宁可重做不误拦）。
export function daysBetween(fromYMD, toYMD) {
  const a = Date.parse(String(fromYMD) + "T00:00:00Z");
  const b = Date.parse(String(toYMD) + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.round((b - a) / 86400000);
}

// 从任意字符串里抽 A 股 6 位代码（"688521.SH" / "300476.SZ" 也取到数字段 688521 / 300476）。
export function extractCodes(s) {
  const out = new Set();
  for (const m of String(s).matchAll(/\d{6}/g)) out.add(m[0]);
  return out;
}

// 规整公司名：去括号注释（含里面的代码）、去裸 6 位代码、去标点空白、英文转小写。
// 报告标题的写法不统一（「特变电工 600089.SH」「阳光电源 300274.SZ 深度调研」），
// 若只去掉 6 位代码，市场后缀与体裁词会粘进"名字"里变成「特变电工sh」「阳光电源sz深度调研」，
// 于是任何带后缀词的题目都匹配不上、查重一律漏拦（实测 34 篇股票报告里 6 篇的名字被这样污染）。
// 处理顺序很重要：先连着代码一起去掉紧跟其后的市场后缀，再去掉裸代码，最后剥结尾的体裁词。
const TRAILING_NOISE_RE = /(深度)?(调研|研究|分析)(报告)?$|报告$/;

function normName(s) {
  let t = String(s)
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/\d{6}\s*[.·]?\s*(SH|SZ|HK|BJ|SS)\b/gi, "")  // 600089.SH 连后缀一起去掉
    .replace(/\d{6}/g, "")
    .replace(/[.\s·、，,]/g, "")
    .toLowerCase()
    .trim();
  // 结尾的体裁词剥掉（只剥结尾，不动名字中间，避免误伤真实公司名）
  t = t.replace(TRAILING_NOISE_RE, "").trim();
  return t;
}

// 一个 entry 的候选代码集合（tags 数字 + slug 末段数字 + 标题里的 6 位数）。
function entryCodes(entry) {
  const codes = new Set();
  for (const t of entry.tags || []) for (const c of extractCodes(t)) codes.add(c);
  for (const c of extractCodes(entry.slug || "")) codes.add(c);
  for (const c of extractCodes(entry.title || "")) codes.add(c);
  return codes;
}

// 一个 entry 的候选名集合：只取标题括号前主名。tags 不参与——里面混着概念/行业标签
// （如"MLCC""介质粉"），当名字用会让任何提到该概念的题目误命中这只股票
// （2026-07-14 线上事故：所有含 MLCC 的题目都被拦成"国瓷材料已调研过"）。tags 仅供 entryCodes 抽代码。
function entryNames(entry) {
  const names = new Set();
  const head = normName(String(entry.title || "").split(/[（(]/)[0]);
  if (head.length >= 2) names.add(head);
  return names;
}

// topic 是否命中某 entry：代码相交 → "code"；名字精确相等 → "name"；双方 ≥3 字且一方包含另一方 → "name"；否则 null。
function matchEntry(topic, entry) {
  const tCodes = extractCodes(topic);
  const eCodes = entryCodes(entry);
  for (const c of tCodes) if (eCodes.has(c)) return "code";

  const tName = normName(topic);
  if (tName.length >= 2) {
    const eNames = entryNames(entry);
    if (eNames.has(tName)) return "name";
    if (tName.length >= 3) {
      for (const n of eNames) {
        if (n.length >= 3 && (tName.includes(n) || n.includes(tName))) return "name";
      }
    }
  }
  return null;
}

// 在 entries 里找「同标的且在 windowDays 天内」的最新报告。
// 命中返回 { entry, ageDays, matchedBy }；命中但已过窗口 / 无命中 → null（允许重做）。
export function findFreshReport({ topic, entries, today, windowDays = DEFAULT_DEDUP_WINDOW_DAYS, types = ["股票"] }) {
  // 多标的题目（"A 和 B 哪个更好""对比 X/Y/Z"）不查重：单票的旧报告答不了对比题，
  // 拦下来只会给提交者回一篇答非所问的报告并把 Issue 贴 done，这条调研就此再不会跑。
  if (isMultiTargetTopic(topic)) return null;

  const want = new Set(types);
  let best = null;
  for (const entry of entries || []) {
    if (want.size && !want.has(entry.type)) continue;
    const matchedBy = matchEntry(topic, entry);
    if (!matchedBy) continue;
    const ageDays = daysBetween(entry.date, today);
    // 日期异常（排在"今天"之后）的条目直接跳过，不参与"最新"评选。
    // 否则它会以最小 ageDays 当选 best，再被下面那条 ageDays<0 一票否决——
    // 同标的窗口内真正有效的报告被它遮住，查重整体失效、放行全额重跑。
    if (ageDays < 0) continue;
    if (!best || ageDays < best.ageDays) best = { entry, ageDays, matchedBy };
  }
  if (!best) return null;
  if (best.ageDays > windowDays) return null; // 命中但已过时效 → 允许重做
  return best;
}

// 这道题是不是「多标的对比」。判定必须收紧：查重是省额度的主力，误判成多标的就直接放行，
// 一次全力档研究白烧一遍，还会再造一个同标的文件夹上站。
// 只认两种确凿信号：
//   (a) 题目里有 ≥2 个互不相同的 6 位股票代码；
//   (b) 有明确的比较词，且比较词两侧能切出 ≥2 个不同的名段。
// 单纯的顿号/逗号/斜杠分隔一律不算——「胜宏科技（300476.SZ / 02476.HK）」是提交者把站上
// 报告标题原样粘过来的常见形态，「胜宏科技，最近怎么样」更是自由文本的常态。
const COMPARE_RE = /(?:\bvs\.?\b|对比|相比|比较|哪个更好|哪个好|哪只好|谁更|孰优)/i;
const SPLIT_RE = /[、,，/／|｜]|\s+和\s+|和(?=[\u4e00-\u9fa5]{2,})|与(?=[\u4e00-\u9fa5]{2,})|\bvs\.?\b|对比|相比|比较|哪个更好|哪个好|哪只好|谁更|孰优/i;

function isMultiTargetTopic(topic) {
  const s = String(topic || "");
  if (extractCodes(s).size >= 2) return true;
  if (!COMPARE_RE.test(s)) return false;
  const segs = new Set(
    s.split(new RegExp(SPLIT_RE.source, "gi")).map((x) => normName(x)).filter((x) => x.length >= 2)
  );
  return segs.size >= 2;
}
