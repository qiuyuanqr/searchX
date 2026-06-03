// services/runner/src/parse-issue.js
// 从 M2a 建的 Issue 取调研对象与侧重点。
// 题目 = Issue 标题；侧重点 = 正文 `### 侧重点` 代码围栏里的内容（可能无）。
// 契约：围栏格式由 services/intake-worker/src/issue-format.js 的 fence() 产出；
// 若那边改了小节标签或围栏样式，这里需同步（否则 focus 静默变空，研究仍会跑，只是少了侧重点提示）。

function extractFenced(body, label) {
  // 匹配：### <label>\n```\n<内容>\n```
  const re = new RegExp("###\\s*" + label + "\\s*\\n```\\n([\\s\\S]*?)\\n```");
  const m = body.match(re);
  return m ? m[1].trim() : "";
}

export function parseIssueRequest({ title, body }) {
  // GitHub REST API 的 issue body 常带 \r\n，先归一化再用 \n 正则匹配。
  const normalized = String(body || "").replace(/\r\n/g, "\n");
  return {
    topic: String(title || "").trim(),
    focus: extractFenced(normalized, "侧重点"),
  };
}
