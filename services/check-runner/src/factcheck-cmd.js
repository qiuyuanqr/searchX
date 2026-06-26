// services/check-runner/src/factcheck-cmd.js
// 拼给本机 Claude Code 跑的 /factcheck 命令（纯函数，无副作用）。

export function buildFactcheckPrompt({ text, link }) {
  const parts = [];
  if (text) parts.push(String(text).trim());
  if (link) parts.push(`链接：${String(link).trim()}`);
  return `/factcheck ${parts.join("\n")}`;
}
