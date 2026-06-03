// services/intake-worker/src/issue-format.js

// 公开仓库 → Issue 公开。邮箱只露域名，本地名打码。
export function maskEmail(email) {
  const at = email.indexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain) return "***";
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(0, local.length - 1))}@${domain}`;
}

// 用代码围栏包裹用户内容，杜绝 markdown/HTML 注入。
const fence = (label, text) => ["", `### ${label}`, "```", text, "```"];

// clean.email 传入前已被调用方替换成打码值（见 handler）。
export function formatIssue(clean, { author }) {
  const maskedEmail = maskEmail(clean.email);
  const lines = [
    "**调研请求**（来自站内表单）",
    "",
    `- 提交者邮箱（打码）：\`${maskedEmail}\``,
    `- 审批：@${author} 贴 \`approved\` 标签即开始（贴前 0 花费）`,
    ...fence("题目", clean.title),
  ];
  if (clean.focus) lines.push(...fence("侧重点", clean.focus));
  if (clean.message) lines.push(...fence("留言", clean.message));

  return {
    title: clean.title,
    body: lines.join("\n"),
    labels: ["pending"],
    assignees: [author],
  };
}
