// services/runner/src/email.js
// 极简结果邮件：一句话摘要 + 网站链接，抄送作者。纯脚本、零 token。
// 隐私红线：只含报告标题 / 已公开的 TLDR / 公开链接，绝不含任何私人信息。

export function composeEmail({ topic, title, tldr, url, toEmail, authorEmail, fromEmail }) {
  const subject = `【调研完成】${title || topic}`;
  const lines = [
    `你提交的调研「${topic}」已经完成并上线：`,
    ...(tldr ? ["", `一句话结论：${tldr}`] : []),
    "",
    `完整报告：${url}`,
    "",
    "—— searchX 深度调研引擎",
  ];
  return { from: fromEmail, to: toEmail, cc: authorEmail, subject, text: lines.join("\n") };
}

// 注入 transport（nodemailer），便于离线单测。
export async function sendEmail(message, { transport }) {
  return transport.sendMail(message);
}
