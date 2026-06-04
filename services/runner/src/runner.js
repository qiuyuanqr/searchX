// services/runner/src/runner.js
// 一次性编排：取 approved 未 done 的 Issue → 跑 /research（含 Step6 自动上线）
// → 贴 done → 取提交者邮箱 → 发极简邮件（抄作者）→ 评论留痕。
// 全部副作用经 deps 注入，离线可测。

import { listApprovedIssues, addLabel, commentIssue } from "./issues.js";
import { parseIssueRequest } from "./parse-issue.js";
import { buildResearchPrompt } from "./research-cmd.js";
import { diffNewDirs } from "./research-output.js";
import { fetchSubmitterEmail } from "./sub-fetch.js";
import { composeEmail, composeAuthorDigest } from "./email.js";

export async function runOnce(config, deps) {
  const { fetchImpl, scanDirs, runResearch, sendEmail, log, bumpDailyCount,
    verifyPublished = async () => true } = deps;
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

    // 研究已完成并 push：先贴 done，杜绝下个 tick 重复跑 /research（重研既费额度又再造文件夹）。
    await addLabel({ ...gh, number: issue.number, label: "done" }, fetchImpl);

    // 部署探活闸：Step6 push 后 GitHub Actions 才 build+deploy，Pages 偶发 5xx 会打掉部署
    // → 报告子页 404。未确认上线就不发"已上线"邮件（免得给提交者发 404 链接），改发作者告警。
    if (!(await verifyPublished(url))) {
      summary.failed++;
      log(`#${issue.number} 已完成研究并推送，但未确认上线（疑似 Pages 部署故障）：${url}`);
      try {
        await commentIssue(
          { ...gh, number: issue.number,
            body: `⚠️ 研究已完成并推送，但未确认上线（疑似 GitHub Pages 部署故障）：${url}。已暂缓发信，请手动补跑部署（Actions → deploy.yml → Run workflow）确认上线后再补发。` },
          fetchImpl
        );
      } catch (e) {
        log(`#${issue.number} 告警评论失败（不影响已 push 的研究）：${e.message}`);
      }
      continue;
    }

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
      log(`#${issue.number} 邮件已发送`);
      // 留痕评论单独兜底：邮件已发成功，这条评论失败不该被误判成"发信失败"、更不该重复告警。
      try {
        await commentIssue({ ...gh, number: issue.number, body: `✅ 已上线并发信：${url}` }, fetchImpl);
      } catch (e) {
        log(`#${issue.number} 留痕评论失败（不影响已发信）：${e.message}`);
      }
    } catch (err) {
      // 告警评论本身也兜底，避免评论失败让整轮 runOnce 抛出、后续 Issue 不被处理。
      try {
        await commentIssue(
          { ...gh, number: issue.number, body: `⚠️ 报告已上线 ${url}，但发信失败：${err.message}。请手动补发。` },
          fetchImpl
        );
      } catch (e) {
        log(`#${issue.number} 告警评论也失败：${e.message}`);
      }
      log(`#${issue.number} 发信失败：${err.message}`);
    }

    // 作者汇总邮件（独立、尽力而为，失败不影响任务本身）：完成了什么 + 今日累计完成数。
    if (bumpDailyCount) {
      try {
        const { date, count } = bumpDailyCount();
        await sendEmail(
          composeAuthorDigest({
            topic, title: entry.title, url, date, count,
            authorEmail: config.authorEmail, fromEmail: config.smtpUser,
          })
        );
        log(`#${issue.number} 作者汇总已发（今日第 ${count} 篇）`);
      } catch (err) {
        log(`#${issue.number} 作者汇总发送失败：${err.message}`);
      }
    }
  }

  log(`完成：处理 ${summary.processed}、上线 ${summary.published}、发信 ${summary.emailed}、失败 ${summary.failed}`);
  return summary;
}
