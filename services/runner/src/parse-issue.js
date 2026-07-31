// services/runner/src/parse-issue.js
// 从 M2a 建的 Issue 取调研对象与侧重点。
// 题目 = Issue 标题；侧重点 = 正文 `### 侧重点` 代码围栏里的内容（可能无）。
// 契约：围栏格式由 services/intake-worker/src/issue-format.js 的 fence() 产出；
// 若那边改了小节标签或围栏样式，这里需同步（否则 focus 静默变空，研究仍会跑，只是少了侧重点提示）。
//
// 解析必须是「围栏状态感知」的：正文里的用户内容（题目/侧重点/留言）全都包在代码围栏里，
// 而提交表单是自由文本——用户内容里出现 `### 侧重点` 加一段围栏是完全可能的（复述模板格式，
// 或蓄意伪造一段侧重点）。用一条全局正则找首个匹配，命中的可能是用户内容里的假小节，
// 真正的侧重点被静默丢弃、换成攻击者写的内容喂进 /research。
// 只认「不在任何围栏内部」的 ### 行，伪造的小节因为身处围栏内而永远不会被当成小节。

// 围栏行：至少三个反引号（issue-format 会按内容里最长的反引号串加长围栏）。
const FENCE_RE = /^(`{3,})\s*$/;
const HEADING_RE = /^###\s*(.+?)\s*$/;

/**
 * 扫描 Issue 正文，返回 { 小节名 → 围栏内文本 }。
 * 只取顶层（不在围栏内）的 ### 小节；同名小节以**首个**为准（真小节由 issue-format 按固定
 * 顺序写在前面，重复出现的只可能是异常）。
 */
export function parseSections(body) {
  const lines = String(body || "").replace(/\r\n/g, "\n").split("\n");
  const sections = {};
  let i = 0;
  while (i < lines.length) {
    const h = lines[i].match(HEADING_RE);
    if (!h) { i++; continue; }
    const label = h[1];
    // 小节标题的下一行必须是开围栏，否则不是我们要的形态，跳过
    const open = (lines[i + 1] || "").match(FENCE_RE);
    if (!open) { i++; continue; }
    const marker = open[1];
    const content = [];
    let j = i + 2;
    let closed = false;
    while (j < lines.length) {
      // 收尾围栏必须与开围栏等长（markdown 规则）：内容里更短的反引号串不会误闭合
      const close = lines[j].match(FENCE_RE);
      if (close && close[1].length >= marker.length) { closed = true; break; }
      content.push(lines[j]);
      j++;
    }
    if (!(label in sections)) sections[label] = content.join("\n").trim();
    // 无论闭合与否都跳到围栏之后：未闭合说明正文被截断，剩下的内容仍属这个围栏，不该再当小节解析
    i = closed ? j + 1 : lines.length;
  }
  return sections;
}

export function parseIssueRequest({ title, body }) {
  const sections = parseSections(body);
  return {
    topic: String(title || "").trim(),
    focus: sections["侧重点"] || "",
  };
}
