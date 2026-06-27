// services/check-runner/src/factcheck-cmd.js
// 拼给本机 Claude Code 跑的 /factcheck 命令（纯函数，无副作用）。

export function buildFactcheckPrompt({ text, link, imagePaths }) {
  const parts = [];
  if (text) parts.push(String(text).trim());
  if (link) parts.push(`链接：${String(link).trim()}`);
  const paths = (Array.isArray(imagePaths) ? imagePaths : []).filter(Boolean);
  if (paths.length) {
    parts.push(`附图为本地文件，请用 Read 逐张打开后纳入核查：\n${paths.join("\n")}`);
  }
  return `/factcheck ${parts.join("\n")}`;
}
