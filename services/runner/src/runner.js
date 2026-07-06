// services/runner/src/runner.js
// 一次性编排：取 approved 未 done 的 Issue → 跑 /research（含 Step6 自动上线）
// → 贴 done → 探活确认上线 → 取提交者邮箱 → 发极简邮件（抄作者）→ 评论留痕。
// 全部副作用经 deps 注入，离线可测。

import { listApprovedIssues, addLabel, commentIssue } from "./issues.js";
import { parseIssueRequest } from "./parse-issue.js";
import { buildResearchPrompt } from "./research-cmd.js";
import { diffNewDirs } from "./research-output.js";
import { findFreshReport } from "./dedup.js";
import { fetchSubmitterEmail } from "./sub-fetch.js";
import { composeEmail, composeExistingEmail, composeAuthorDigest, composeParkNotice, composeFailureStopNotice, composePendingExpiredNotice } from "./email.js";

export async function runOnce(config, deps) {
  const { fetchImpl, scanDirs, runResearch, sendEmail, log, bumpDailyCount,
    today = () => new Date().toISOString().slice(0, 10),
    now = () => Date.now(),
    verifyPublished = async () => true,
    verifyPublishedQuick = verifyPublished,
    loadPending = async () => [], savePending = async () => {},
    readParkSignal = async () => null, clearParkSignal = async () => {},
    loadFailures = async () => ({}), saveFailures = async () => {} } = deps;
  const gh = { owner: config.owner, repo: config.repo, token: config.githubToken };
  const maxFailures = config.maxFailures ?? 3;
  const pendingExpireMs = config.pendingExpireMs ?? 24 * 3600_000;

  const summary = { processed: 0, published: 0, emailed: 0, deduped: 0, parked: 0, failed: 0 };

  // 连续失败计数（issue 号 → 次数，跨 tick 存本地文件）。「研究未产出→留待重跑」的 Issue
  // 若持续失败，launchd 每 5 分钟一 tick 会全额重跑一次 /research（每次都真实花额度），
  // 一整天可烧上百次——达 maxFailures 即自动停跑止损。成功即清零（连续语义，偶发故障不累计）。
  const failures = await loadFailures();

  // 失败停跑：贴 done（复用幂等标记停止重跑，与「核验未过 park 贴 done」同一先例）→ 作者专信
  // → 评论说明恢复方式。贴 done 是真正的止损动作，必须最先做且失败可重试：贴不上就保留计数、
  // 返回 false——下一轮会在跑研究之前先重试停跑；此时不发信不评论（每 5 分钟一 tick，重复发
  // 就是邮件轰炸；scheduled-run.sh 的限频报警会兜底知会作者）。
  async function stopRetrying(issue, topic, count) {
    try {
      await addLabel({ ...gh, number: issue.number, label: "done" }, fetchImpl);
    } catch (err) {
      log(`#${issue.number} 连续失败停跑：贴 done 失败（${err.message}），计数保留，下一轮先重试停跑（不会先重跑研究）`);
      return false;
    }
    delete failures[issue.number]; // 已止损；作者移除 done 恢复后从零重新计数
    summary.parked++;
    log(`#${issue.number} 连续 ${count} 次研究未产出，已自动停跑（贴 done 止损），不再自动重跑`);
    try {
      await sendEmail(composeFailureStopNotice({
        topic, issueNumber: issue.number, count,
        authorEmail: config.authorEmail, fromEmail: config.smtpUser,
      }));
      log(`#${issue.number} 已邮件通知作者（停跑）`);
    } catch (err) {
      log(`#${issue.number} 停跑通知邮件发送失败：${err.message}`);
    }
    try {
      await commentIssue(
        { ...gh, number: issue.number,
          body: `⛔ 连续 ${count} 次研究未产出，已自动停止重跑（贴 \`done\` 止损，不再消耗额度）并邮件通知作者。人工排查修复后如需重试：移除本 Issue 的 \`done\` 标签，下一轮定时 runner 会重新排队（失败计数已清零）。` },
        fetchImpl
      );
    } catch (e) {
      log(`#${issue.number} 停跑评论失败（不影响已发通知）：${e.message}`);
    }
    return true;
  }

  // 取提交者邮箱并发一封「已上线」邮件。复用于正常路径与补发路径。
  async function emailSubmitter({ number, topic, title, tldr, url }) {
    const email = await fetchSubmitterEmail(
      { workerUrl: config.workerUrl, secret: config.subSecret, issueNumber: number },
      fetchImpl
    );
    await sendEmail(composeEmail({
      topic, title, tldr, url,
      toEmail: email, authorEmail: config.authorEmail, fromEmail: config.smtpUser,
    }));
  }

  // —— 1) 先补发「上线待确认」队列 ——
  // 这些条目研究早已 push 并贴了 done（防重研），只是当轮部署探活没通过。重新探活，
  // 一旦确认上线就补发提交者邮件；仍未上线 / 补发失败的留到下一轮再试。绝不重跑 /research。
  let pending = await loadPending();
  if (pending.length) {
    log(`上线待确认（补发探活）：${pending.length} 条`);
    const stillPending = [];
    for (const p of pending) {
      // 旧队列条目（本次改动前落盘、无 firstSeen）：视为从此刻起计时，不追溯误杀。
      const firstSeen = p.firstSeen ?? now();
      const ageMs = now() - firstSeen;
      if (ageMs >= pendingExpireMs) {
        const ageHours = Math.round(ageMs / 3600_000);
        summary.failed++;
        log(`#${p.number} 上线待确认超龄（${ageHours}h），停止自动重探并告警作者：${p.url}`);
        try {
          await sendEmail(composePendingExpiredNotice({
            topic: p.topic, issueNumber: p.number, url: p.url, ageHours,
            authorEmail: config.authorEmail, fromEmail: config.smtpUser,
          }));
        } catch (err) {
          log(`#${p.number} 超龄告警邮件发送失败：${err.message}`);
        }
        try {
          await commentIssue(
            { ...gh, number: p.number,
              body: `⛔ 部署探活超过 ${ageHours} 小时仍未确认上线，已停止自动重探（不再每轮重复探活），已邮件通知作者人工核对：${p.url}` },
            fetchImpl
          );
        } catch (e) {
          log(`#${p.number} 超龄告警评论失败（不影响已发的通知邮件）：${e.message}`);
        }
        continue; // 出队：绝不进 stillPending，杜绝永久占队每轮白等
      }
      // 复探用远短于「刚跑完研究」那次的 deadline：这里只是每 5 分钟一 tick 的重探，
      // 迟迟不上线本就会在下一轮再探，没必要每轮都陪跑到 8 分钟长轮询、拖慢新 Issue 处理。
      if (!(await verifyPublishedQuick(p.url))) { stillPending.push({ ...p, firstSeen }); continue; }
      try {
        await emailSubmitter(p);
        summary.emailed++;
        log(`#${p.number} 已确认上线，补发邮件成功：${p.url}`);
        try {
          await commentIssue({ ...gh, number: p.number, body: `✅ 已确认上线并补发邮件：${p.url}` }, fetchImpl);
        } catch (e) {
          log(`#${p.number} 补发后留痕评论失败（不影响已发信）：${e.message}`);
        }
      } catch (err) {
        log(`#${p.number} 已确认上线但补发邮件失败：${err.message}，留待下一轮再补`);
        stillPending.push({ ...p, firstSeen });
      }
    }
    pending = stillPending;
    // 立即落盘：阶段 2 若中途抛错（如取 Issue 列表失败导致 runOnce 中止），已补发成功的
    // 条目绝不能留在磁盘队列里——否则下一轮会重新探活（秒过）并再给提交者发一封重复的
    // 「已上线」邮件，GitHub 侧故障持续多久就重复多少封。
    await savePending(pending);
  }

  // —— 2) 处理 approved 未 done 的新队列 ——
  const issues = await listApprovedIssues(gh, fetchImpl);
  log(`待处理（approved 未 done）：${issues.length} 条`);

  for (const issue of issues) {
    summary.processed++;
    const { topic, focus } = parseIssueRequest(issue);
    log(`#${issue.number} 开始：${topic}`);

    // —— 失败停跑闸（先于一切花钱动作）——
    // 已达阈值的 Issue 直接停跑，绝不再 spawn claude。正常路径在失败分支达阈值时就地停跑，
    // 走到这里的是「上一轮贴 done 没贴上、计数保留」的重试：必须先补完成止损，不能先烧一次研究。
    const prevFails = Number(failures[issue.number]) || 0;
    if (prevFails >= maxFailures) {
      if (!(await stopRetrying(issue, topic, prevFails))) summary.failed++;
      continue;
    }

    const existing = scanDirs();

    // —— 查重：同标的且在时效窗口内已有报告 → 不重复调研，自动回信引导看现成报告 + 贴 done ——
    // 确定性、零 token：在 spawn claude 之前判定，既省额度又避免"重复调研空跑/再造文件夹"。
    // 命中即跳过本条研究；股票类才查（默认 types=["股票"]），超窗口的旧报告允许重做。
    const dup = findFreshReport({
      topic, entries: existing, today: today(), windowDays: config.dedupWindowDays,
    });
    if (dup) {
      summary.deduped++;
      const url = `${config.siteBase}/${dup.entry.href}`;
      log(`#${issue.number} 已有报告（${dup.ageDays} 天内 · 命中${dup.matchedBy === "code" ? "代码" : "名称"}），不重复调研：${url}`);
      // 先贴 done（幂等标记）：与正常完成路径同一顺序——若持续贴不上而 SMTP 正常，
      // 先发信会导致每 5 分钟一 tick 都重新命中查重、再发一封「已有报告」信，轰炸提交者邮箱。
      try {
        await addLabel({ ...gh, number: issue.number, label: "done" }, fetchImpl);
      } catch (err) {
        summary.failed++;
        log(`#${issue.number} 查重命中但贴 done 失败：${err.message}，未发信，下轮重试`);
        try {
          await commentIssue(
            { ...gh, number: issue.number,
              body: `ℹ️ 已有同标的报告（生成于 ${dup.ageDays} 天内）：${url}。但贴 \`done\` 标签失败（${err.message}），未发信，下一轮重试。` },
            fetchImpl
          );
        } catch (e) {
          log(`#${issue.number} 查重命中贴 done 失败后的评论也失败：${e.message}`);
        }
        continue;
      }
      let emailedOk = false;
      try {
        const email = await fetchSubmitterEmail(
          { workerUrl: config.workerUrl, secret: config.subSecret, issueNumber: issue.number },
          fetchImpl
        );
        await sendEmail(composeExistingEmail({
          topic, title: dup.entry.title, tldr: dup.entry.tldr, url, ageDays: dup.ageDays,
          toEmail: email, authorEmail: config.authorEmail, fromEmail: config.smtpUser,
        }));
        summary.emailed++;
        emailedOk = true;
        log(`#${issue.number} 已回信告知已有报告`);
      } catch (err) {
        log(`#${issue.number} 已有报告但回信失败：${err.message}`);
      }
      // 留痕评论（尽力而为，失败不影响已发的信）。
      try {
        await commentIssue(
          { ...gh, number: issue.number,
            body: emailedOk
              ? `ℹ️ 已有同标的报告（生成于 ${dup.ageDays} 天内），未重复调研，已回信引导提交者查看：${url}`
              : `ℹ️ 已有同标的报告（生成于 ${dup.ageDays} 天内），未重复调研：${url}。但自动回信失败，请手动告知提交者。` },
          fetchImpl
        );
      } catch (e) {
        log(`#${issue.number} 查重命中后评论失败（不影响主流程）：${e.message}`);
      }
      continue;
    }

    // 先清残留的 park 信号（交互式 /research 被搁置后信号文件可能无人清理、或上一 tick 在
    // 写信号与读信号之间中断）：保证跑完后读到的信号必然产自本次研究。否则旧信号会张冠李戴
    // ——本条 Issue 实际成功也被判搁置：贴 done、给作者发错搁置信、提交者收不到上线通知。
    await clearParkSignal();
    const before = existing.map((e) => e.dir);
    const ok = await runResearch(buildResearchPrompt({ topic, focus }));
    const after = scanDirs();
    const newDirs = diffNewDirs(before, after.map((e) => e.dir));

    // —— park（上线前独立核验未过被搁置）——
    // skill 在 runner 里拿不到 SMTP 凭据（runResearch 剥掉了 RUNNER_*），所以它只写信号文件
    // research/.parked.json、不 push；这里读到就由持凭据的 runner 发邮件通知作者 + 评论 + 贴 done。
    // 必须在"无新文件夹"失败分支之前判定：park 也可能没产出可发布文件夹，但它不是失败、不该被重跑
    //（重跑大概率还 park、白费额度），且不能误判成"研究未产出留待重跑"。
    const park = await readParkSignal();
    if (park) {
      await clearParkSignal(); // 先清信号：杜绝泄漏到本批后续 Issue（即便下面步骤抛错，信号也已清）
      summary.parked++;
      log(`#${issue.number} 上线前核验未过，已搁置不发：${park.reason || topic}`);
      // 发邮件通知作者（尽力而为，失败不影响后续贴 done / 评论）
      try {
        await sendEmail(composeParkNotice({
          topic, reason: park.reason, unresolved: park.unresolved, folder: park.folder,
          authorEmail: config.authorEmail, fromEmail: config.smtpUser,
        }));
        log(`#${issue.number} 已邮件通知作者（搁置）`);
      } catch (err) {
        log(`#${issue.number} 搁置通知邮件发送失败：${err.message}`);
      }
      // 贴 done 停重试：park 重跑大概率还 park；作者已收到邮件，人工接手订正/发布。
      try {
        await addLabel({ ...gh, number: issue.number, label: "done" }, fetchImpl);
      } catch (err) {
        log(`#${issue.number} 搁置后贴 done 失败：${err.message}`);
      }
      try {
        await commentIssue(
          { ...gh, number: issue.number,
            body: `⚠️ 上线前独立核验未通过，已搁置待人工复核（未发布、未给提交者发信）。${park.reason ? "原因：" + park.reason + "。" : ""}已邮件通知作者。` },
          fetchImpl
        );
      } catch (e) {
        log(`#${issue.number} 搁置评论失败（不影响已发的通知邮件）：${e.message}`);
      }
      continue;
    }

    if (!ok || newDirs.length === 0) {
      summary.failed++;
      const count = prevFails + 1;
      failures[issue.number] = count;
      if (count >= maxFailures) {
        await stopRetrying(issue, topic, count); // 达阈值就地止损，不必等下一轮再烧一次
      } else {
        log(`#${issue.number} 研究未产出（claude 退出码非 0 或无新文件夹），连续第 ${count}/${maxFailures} 次，不贴 done，留待重跑`);
      }
      continue;
    }
    delete failures[issue.number]; // 研究成功即清零：只有「连续」失败才累计停跑

    // 正常每次 /research 只产出 1 个文件夹（SKILL Step 4），故取首个新目录即可。
    const entry = after.find((e) => newDirs.includes(e.dir));
    const url = `${config.siteBase}/${entry.href}`;

    // 研究已完成并 push：先贴 done，杜绝下个 tick 重复跑 /research（重研既费额度又再造文件夹）。
    // 贴 done 必须兜底——否则异常冒泡会中止整轮、本批后续 Issue 全被跳过，且本条下轮会被
    // 重新选中再跑一次 /research（重复花额度 + 造重复文件夹）。
    try {
      await addLabel({ ...gh, number: issue.number, label: "done" }, fetchImpl);
    } catch (err) {
      summary.failed++;
      log(`#${issue.number} 研究已完成并上线，但贴 done 失败：${err.message}`);
      try {
        await commentIssue(
          { ...gh, number: issue.number,
            body: `⚠️ 研究已完成并推送，但贴 \`done\` 标签失败：${err.message}。请手动补贴 \`done\`，否则下一轮会重复跑 /research（重复消耗额度并产生重复文件夹）。` },
          fetchImpl
        );
      } catch (e) {
        log(`#${issue.number} 告警评论也失败（不影响已 push 的研究）：${e.message}`);
      }
      continue; // 绝不让异常冒泡中止整批，保证同批后续 Issue 仍被处理
    }

    // 部署探活：Step6 push 后 GitHub Actions 才 build+deploy，Pages 偶发 5xx 会打掉部署
    // → 报告子页 404。未确认上线就不发"已上线"邮件（免得给提交者发 404 链接）。
    if (!(await verifyPublished(url))) {
      summary.failed++;
      log(`#${issue.number} 已完成研究并推送，但未确认上线（疑似 Pages 部署故障）：${url}`);
      // 记入「上线待确认」队列：后续每轮自动重探，确认上线即自动补发邮件，无需人工盯评论。
      pending.push({ number: issue.number, topic, title: entry.title, tldr: entry.tldr, url, firstSeen: now() });
      try {
        await commentIssue(
          { ...gh, number: issue.number,
            body: `⚠️ 研究已完成并推送，但暂未确认上线（疑似 GitHub Pages 部署故障）：${url}。已暂缓发信；后续每轮会自动重探，确认上线后将自动补发邮件给提交者（也可在 Actions → deploy.yml → Run workflow 手动补跑部署加速）。` },
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
      await emailSubmitter({ number: issue.number, topic, title: entry.title, tldr: entry.tldr, url });
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

  // 持久化「上线待确认」队列：含本轮新失败的 + 上一轮仍未补发成功的。
  await savePending(pending);

  // 持久化失败计数，并修剪掉不在 approved 队列里的残留（已 done / 被人工处理的），防状态文件
  // 无限膨胀。被人工干预过的 Issue 若日后重新 approved 会从零重新计数——作者已介入，给新预算。
  const inQueue = new Set(issues.map((i) => String(i.number)));
  for (const k of Object.keys(failures)) if (!inQueue.has(k)) delete failures[k];
  await saveFailures(failures);

  log(`完成：处理 ${summary.processed}、上线 ${summary.published}、发信 ${summary.emailed}、查重跳过 ${summary.deduped}、搁置 ${summary.parked}、失败 ${summary.failed}`);
  return summary;
}
