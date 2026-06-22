// services/intake-worker/src/issue-format.js

// 公开仓库 → Issue 公开。邮箱只露域名，本地名打码。
export function maskEmail(email) {
  const at = email.indexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain) return "***";
  // 定长掩码：不用 `*` 个数泄露本地名长度；单字符本地名也不暴露（head 置空）。
  const head = local.length > 1 ? local.slice(0, 1) : "";
  return `${head}***@${domain}`;
}

// 用代码围栏包裹用户内容，杜绝 markdown/HTML 注入。
const fence = (label, text) => ["", `### ${label}`, "```", text, "```"];

// 公开仓库 → Issue 公开：这里**总是**内部打码（纵深防御，不依赖调用方先打码；
// maskEmail 幂等，即使 handler 已先打码也安全）。
// approved：来自已授权用户且未命中安全红旗 → 直接贴 `approved`（runner 自动跑）；
// 否则（命中红旗）贴 `pending`，降级人工复核——守住"全权限 headless 跑用户内容"的风险点。
export function formatIssue(clean, { author, flags = [], approved = false }) {
  const maskedEmail = maskEmail(clean.email);
  const lines = [
    "**调研请求**（来自站内表单 · 已授权用户）",
    "",
    `- 提交者邮箱（打码）：\`${maskedEmail}\``,
    approved
      ? "- 状态：✅ 已授权用户，**自动放行**（无需审批，runner 将自动开始调研）"
      : `- 状态：⚠️ 已授权用户，但命中安全初筛 → **降级人工复核**，请 @${author} 逐字核对题目/侧重点无误后再贴 \`approved\``,
  ];
  // 安全初筛红旗：命中可疑模式时显眼提示，放行前请逐字核对题目/侧重点（防提示注入）。
  if (flags.length) {
    lines.push(
      "",
      `> ⚠️ **自动安全初筛**：检测到可疑内容（${flags.join("、")}）。可能是提示注入，**请逐字核对题目与侧重点，确认无误再贴 \`approved\`**。`
    );
  }
  lines.push(...fence("题目", clean.title));
  if (clean.focus) lines.push(...fence("侧重点", clean.focus));
  if (clean.message) lines.push(...fence("留言", clean.message));

  return {
    title: clean.title,
    body: lines.join("\n"),
    labels: [approved ? "approved" : "pending"],
    assignees: [author],
  };
}
