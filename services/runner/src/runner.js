// services/runner/src/runner.js
// 一次性编排：取 approved 未 done 的 Issue → 跑 /research（含 Step6 自动上线）
// → 贴 done → 取提交者邮箱 → 发极简邮件（抄作者）→ 评论留痕。
// 全部副作用经 deps 注入，离线可测。

import { listApprovedIssues, addLabel, commentIssue } from "./issues.js";
import { parseIssueRequest } from "./parse-issue.js";
import { buildResearchPrompt } from "./research-cmd.js";
import { diffNewDirs } from "./research-output.js";
import { fetchSubmitterEmail } from "./sub-fetch.js";
import { composeEmail } from "./email.js";

export async function runOnce(config, deps) {
  const { fetchImpl, scanDirs, runResearch, sendEmail, log } = deps;
  const gh = { owner: config.owner, repo: config.repo, token: config.githubToken };

  const issues = await listApprovedIssues(gh, fetchImpl);
  log(`待处理（approved 未 done）：${issues.length} 条`);

  const summary = { processed: 0, published: 0, emailed: 0, failed: 0 };

  for (const issue of issues) {
    summary.processed++;
    const { topic, focus } = parseIssueRequest(issue);
    log(`#${issue.number} 开始：${topic}`);

    const before = scanDirs().map((e) => e.dir);
    const ok = await runResearch(buildResearchPrompt({ topic, focus }));
    const after = scanDirs();
    const newDirs = diffNewDirs(before, after.map((e) => e.dir));

    if (!ok || newDirs.length === 0) {
      summary.failed++;
      log(`#${issue.number} 研究未产出（claude 退出码非 0 或无新文件夹），不贴 done，留待重跑`);
      continue;
    }

    // 正常每次 /research 只产出 1 个文件夹（SKILL Step 4），故取首个新目录即可。
    const entry = after.find((e) => newDirs.includes(e.dir));
    const url = `${config.siteBase}/${entry.href}`;
    await addLabel({ ...gh, number: issue.number, label: "done" }, fetchImpl);
    summary.published++;
    log(`#${issue.number} 已上线：${url}`);

    try {
      const email = await fetchSubmitterEmail(
        { workerUrl: config.workerUrl, secret: config.subSecret, issueNumber: issue.number },
        fetchImpl
      );
      const msg = composeEmail({
        topic, title: entry.title, tldr: entry.tldr, url,
        toEmail: email, authorEmail: config.authorEmail, fromEmail: config.smtpUser,
      });
      await sendEmail(msg);
      summary.emailed++;
      await commentIssue({ ...gh, number: issue.number, body: `✅ 已上线并发信：${url}` }, fetchImpl);
      log(`#${issue.number} 邮件已发送`);
    } catch (err) {
      await commentIssue(
        { ...gh, number: issue.number, body: `⚠️ 报告已上线 ${url}，但发信失败：${err.message}。请手动补发。` },
        fetchImpl
      );
      log(`#${issue.number} 发信失败：${err.message}`);
    }
  }

  log(`完成：处理 ${summary.processed}、上线 ${summary.published}、发信 ${summary.emailed}、失败 ${summary.failed}`);
  return summary;
}
