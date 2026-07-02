// services/check-runner/src/factcheck-cmd.js
// 拼给本机 Claude Code 跑的 /factcheck 命令（纯函数，无副作用）。

export function buildFactcheckPrompt({ text, link, imagePaths, verdictPath }) {
  const parts = [];
  if (text) parts.push(String(text).trim());
  if (link) parts.push(`链接：${String(link).trim()}`);
  const paths = (Array.isArray(imagePaths) ? imagePaths : []).filter(Boolean);
  if (paths.length) {
    parts.push(`附图为本地文件，请用 Read 逐张打开后纳入核查：\n${paths.join("\n")}`);
  }
  if (verdictPath) {
    // 一行结论写进信号文件，runner 读后随 markDone 上报、回显到手机核查页（skill 无人值守节有对应说明）
    parts.push(`核查完成后，把一行结论写到本地文件 ${verdictPath}（格式：裁定（把握度）：一句话真相，仅此一行、不含其他内容）。`);
  }
  return `/factcheck ${parts.join("\n")}`;
}
