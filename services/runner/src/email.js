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

// 「已有报告·不重复调研」回信：提交的标的此前已调研过且报告仍在时效窗口内，不重复跑，
// 直接引导提交者去站点看现成报告。抄送作者。隐私红线：只含报告标题 / TLDR / 公开链接。
export function composeExistingEmail({ topic, title, tldr, url, ageDays, toEmail, authorEmail, fromEmail }) {
  const name = title || topic;
  const subject = `【已有调研报告】${name}`;
  const lines = [
    `你提交的调研「${topic}」此前已经做过，站点上已有现成报告，就不重复调研了，可直接查看：`,
    "",
    `完整报告：${url}`,
    ...(tldr ? ["", `一句话结论：${tldr}`] : []),
    "",
    "如你认为该报告已较旧、希望基于最新情况重新调研，回复本邮件说明即可。",
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

// 搁置（park）通知：上线前独立核验转满 2 轮仍有"确认为真且消解不掉"的硬错，报告被搁置不发。
// 只发作者（无 cc，绝不发提交者）；只含运维信息（主题 / 搁置原因 / 没解决的条目 / 本地草稿路径），
// 不含任何用户私人信息。skill 在 runner 里拿不到 SMTP 凭据，故由持凭据的 runner 发这封信。
export function composeParkNotice({ topic, reason, unresolved = [], folder, authorEmail, fromEmail }) {
  const subject = `【searchX 核验未通过·已搁置】${topic}`;
  const lines = [
    `调研「${topic}」上线前独立核验未通过，已搁置不发（未公开、未给提交者发信）。`,
    ...(reason ? ["", `搁置原因：${reason}`] : []),
    ...(unresolved.length
      ? ["", "没解决的硬错：", ...unresolved.map((u) => `· ${u}`)]
      : []),
    ...(folder ? ["", `本地草稿（仅本机、未 push，可查看核对）：${folder}`] : []),
    "",
    "请人工核对后决定如何处理（订正后手动发布 / 删除该结论 / 强制发布）。",
    "",
    "—— searchX 自动调研流水线",
  ];
  return { from: fromEmail, to: authorEmail, subject, text: lines.join("\n") };
}

// 失败停跑通知：同一 Issue 连续 count 次「研究未产出」，runner 已自动贴 done 止损、停止重跑。
// 只发作者（无 cc，绝不发提交者）；只含运维信息（主题 / Issue 号 / 次数 / 恢复方式），
// 不含任何用户私人信息。不发这封信作者只会看到限频的通用报警，不知道"已经自动止损、该人工排查了"。
export function composeFailureStopNotice({ topic, issueNumber, count, authorEmail, fromEmail }) {
  const subject = `【searchX 已停跑】${topic}——连续 ${count} 次研究未产出`;
  const lines = [
    `调研「${topic}」（Issue #${issueNumber}）连续 ${count} 次研究未产出，已自动停止重跑（贴 done 标签止损，不再消耗额度）。`,
    "",
    "常见原因：claude CLI 异常退出、额度用尽、网络故障、或题目本身让 /research 无法完成。",
    "排查日志：~/Library/Logs/searchx-runner/runner.log",
    "",
    "人工确认问题解决后，如需重试：在 GitHub 上移除该 Issue 的 done 标签，下一轮定时 runner 会重新排队（失败计数已清零）。",
    "",
    "—— searchX 自动调研流水线",
  ];
  return { from: fromEmail, to: authorEmail, subject, text: lines.join("\n") };
}

// 注入 transport（nodemailer），便于离线单测。
export async function sendEmail(message, { transport }) {
  return transport.sendMail(message);
}
