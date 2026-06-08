// services/runner/src/dedup.js
// 查重：同一标的若已有「在时效窗口内」的报告，则不重复调研（省额度 + 引导提交者看现成报告）。
// 纯函数、可离线测；匹配只用 scanResearch 已产出的 entry 字段（type/tags/title/slug/date/href/tldr）。
// 设计取舍：匹配偏"宁可漏拦也少误拦"——漏拦最多多跑一次研究（不会死循环，研究会产出文件夹）；
// 误拦会把别的票的报告硬塞给提交者，更糟。故名称匹配以"精确"为主、包含为辅且双方都需 ≥3 字。

// 这些 tag 是类型/通用词，不能当公司名用来匹配。
const GENERIC_TAGS = new Set([
  "research", "股票", "概念", "人物", "方法论", "板块", "事件", "深度", "调研",
]);

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
function normName(s) {
  return String(s)
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/\d{6}/g, "")
    .replace(/[.\s·、，,]/g, "")
    .toLowerCase()
    .trim();
}

// 一个 entry 的候选代码集合（tags 数字 + slug 末段数字 + 标题里的 6 位数）。
function entryCodes(entry) {
  const codes = new Set();
  for (const t of entry.tags || []) for (const c of extractCodes(t)) codes.add(c);
  for (const c of extractCodes(entry.slug || "")) codes.add(c);
  for (const c of extractCodes(entry.title || "")) codes.add(c);
  return codes;
}

// 一个 entry 的候选名集合（tags 里非通用、非纯数字项 + 标题括号前主名）。
function entryNames(entry) {
  const names = new Set();
  for (const t of entry.tags || []) {
    const raw = String(t).trim();
    if (!raw || GENERIC_TAGS.has(raw.toLowerCase())) continue;
    if (/^\d+$/.test(raw)) continue; // 纯数字归 codes
    const n = normName(raw);
    if (n.length >= 2) names.add(n);
  }
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
export function findFreshReport({ topic, entries, today, windowDays = 30, types = ["股票"] }) {
  const want = new Set(types);
  let best = null;
  for (const entry of entries || []) {
    if (want.size && !want.has(entry.type)) continue;
    const matchedBy = matchEntry(topic, entry);
    if (!matchedBy) continue;
    const ageDays = daysBetween(entry.date, today);
    if (!best || ageDays < best.ageDays) best = { entry, ageDays, matchedBy };
  }
  if (!best) return null;
  if (best.ageDays < 0) return null;          // 报告日期在"今天"之后（异常）→ 不拦
  if (best.ageDays > windowDays) return null; // 命中但已过时效 → 允许重做
  return best;
}
