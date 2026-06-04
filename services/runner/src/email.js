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

// 作者汇总邮件：每完成一篇，单独给作者发一封——说明「完成了什么」+「今天累计完成几篇」。
// 只含公开信息（主题 / 报告标题 / 公开链接 / 计数），绝不含提交者邮箱等任何私人信息。
export function composeAuthorDigest({ topic, title, url, date, count, authorEmail, fromEmail }) {
  const name = title || topic;
  const subject = `【searchX 已完成·今日第 ${count} 篇】${name}`;
  const lines = [
    `朋友提交的调研「${topic}」已完成并上线：`,
    "",
    `· 报告：${name}`,
    `· 链接：${url}`,
    "",
    `📊 今日（${date}）累计完成 ${count} 篇。`,
    "",
    "—— searchX 自动调研流水线",
  ];
  return { from: fromEmail, to: authorEmail, subject, text: lines.join("\n") };
}

// 注入 transport（nodemailer），便于离线单测。
export async function sendEmail(message, { transport }) {
  return transport.sendMail(message);
}
