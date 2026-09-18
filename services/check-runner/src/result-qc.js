// services/check-runner/src/result-qc.js
// /factcheck 结果文件（result.md，与 Obsidian 笔记同内容）的轻量机器质检——纯函数，无 IO。
//
// research / stock 有 research-qc 与 check-sources 把关，factcheck 此前一道都没有：2026-09-18 对 28 篇
// 存量实测，有一篇 frontmatter 写 source_count: 7、来源节实际列了 9 条，没人发现。这里只做
// 「格式有没有照 SKILL Step 5 写」这一层：必填字段齐不齐、summary 能不能被手机页解析、六节标题
// 在不在、来源条数与 source_count 对不对得上。只产出问题清单给 runner 写日志，**不拦截、不改判**
// ——回显是增强，缺一项不该让一条跑成功的核查按失败重跑。
import { parseFrontmatterScalars } from "./result-signals.js";

// SKILL Step 5 规定的必填标量字段
export const REQUIRED_FIELDS = ["date", "title", "summary", "verdict", "confidence", "source_credibility", "input_type", "source_count", "note"];
export const VERDICTS = ["属实", "大体属实", "半真", "误导", "不实", "无法证实", "解答"];
export const LEVELS = ["高", "中", "低"];
// 正文六节（固定标题，顺序也固定）
export const SECTIONS = ["真相直述", "来龙去脉", "逐条核查", "核查结论与可信度", "局限", "来源"];

// 与 web/src/assets/check.js 的 parseSummary 同一格式：「裁定（高|中|低）：一句话」；容忍全角 / 半角、括号里带附注。
const SUMMARY_RE = /^(属实|大体属实|半真|误导|不实|无法证实|解答)\s*[（(]\s*(高|中|低)[^）)]*[）)]\s*[：:]\s*\S/;

// 来源节：编号有序列表的条数（`1. [标题](url)`），到下一个 ## 标题或文末为止
export function countSourceItems(body) {
  const m = /^##\s+来源\s*$/m.exec(body);
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length);
  const end = rest.search(/^##\s+/m);
  const sec = end === -1 ? rest : rest.slice(0, end);
  return sec.split("\n").filter((l) => /^\s*\d+\.\s+\S/.test(l)).length;
}

// 返回问题清单（字符串数组），空数组即全部合格。输入非字符串 / 空 → 一条「结果为空」。
export function qcResult(md) {
  const s = String(md == null ? "" : md);
  if (!s.trim()) return ["结果文件为空"];
  const issues = [];
  const fm = parseFrontmatterScalars(s);
  if (!Object.keys(fm).length) issues.push("缺 frontmatter（文件不以 --- 开头）");
  for (const k of REQUIRED_FIELDS) {
    if (!(k in fm) || !String(fm[k]).trim()) issues.push(`frontmatter 缺 ${k}`);
  }
  if (fm.verdict && !VERDICTS.includes(String(fm.verdict).trim())) issues.push(`verdict 不在七档内：${fm.verdict}`);
  if (fm.confidence && !LEVELS.includes(String(fm.confidence).trim())) issues.push(`confidence 不是 高/中/低：${fm.confidence}`);
  if (fm.source_credibility && ![...LEVELS, "不适用"].includes(String(fm.source_credibility).trim())) {
    issues.push(`source_credibility 不是 高/中/低/不适用：${fm.source_credibility}`);
  }
  if (fm.summary && !SUMMARY_RE.test(String(fm.summary).trim())) {
    issues.push("summary 不符合「裁定（高|中|低）：一句话」格式，手机页会退回「已完成」灰标");
  }
  if (fm.summary && fm.verdict) {
    const sv = /^(属实|大体属实|半真|误导|不实|无法证实|解答)/.exec(String(fm.summary).trim());
    if (sv && sv[1] !== String(fm.verdict).trim()) issues.push(`summary 开头的裁定「${sv[1]}」与 verdict「${fm.verdict}」不一致`);
  }
  if (fm.title && [...String(fm.title)].length > 40) issues.push(`title 超 40 字（Worker 会截断）：${[...String(fm.title)].length} 字`);
  if (fm.note && !/^Factcheck\/.+\.md$/.test(String(fm.note).trim())) issues.push(`note 不是 Factcheck/<文件名>.md 形式：${fm.note}`);

  const body = s.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "");
  if (/^#\s+\S/m.test(body)) issues.push("正文出现 H1 大标题（文件名即标题，不该有）");
  let lastIdx = -1;
  for (const name of SECTIONS) {
    const m = new RegExp(`^##\\s+${name}\\s*$`, "m").exec(body);
    if (!m) { issues.push(`缺「## ${name}」节`); continue; }
    if (m.index < lastIdx) issues.push(`「## ${name}」节顺序不对`);
    lastIdx = Math.max(lastIdx, m.index);
  }
  if (/^\[[^\]]+\]:\s*https?:\/\//m.test(body)) issues.push("来源用了 reference-style 写法（[标签]: url），Obsidian 解析不出");
  const n = countSourceItems(body);
  if (n != null) {
    const declared = parseInt(String(fm.source_count || ""), 10);
    if (n === 0) issues.push("来源节没有编号列表条目");
    else if (Number.isInteger(declared) && declared !== n) issues.push(`source_count 写 ${declared}、来源节实际 ${n} 条`);
  }
  if (!/^\|\s*#\s*\|\s*原子说法\s*\|/m.test(body)) issues.push("逐条核查表缺固定 5 列表头（| # | 原子说法 | 裁定（把握度） | 关键证据 | 来源 |）");
  return issues;
}
