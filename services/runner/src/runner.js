// services/runner/src/runner.js
// 一次性编排：取 approved 未 done 的 Issue → 跑 /research（含 Step6 自动上线）
// → 贴 done → 探活确认上线 → 取提交者邮箱 → 发极简邮件（抄作者）→ 评论留痕。
// 全部副作用经 deps 注入，离线可测。

import { listApprovedIssues, addLabel, commentIssue, fetchIssueState } from "./issues.js";
import { isTransientQueueError } from "./alert.js";
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
    loadFailures = async () => ({}), saveFailures = async () => {},
    // 原始目录清单（不解析 notes.md，只看文件系统）：[{ dir, mtimeMs }]。
    // scanDirs 走的是 scanResearch，会把 frontmatter 解析失败的目录整个滤掉——只靠它判「有没有
    // 产出」，一个 YAML 语法错就会让成功的一次研究被判成「研究未产出」，白重跑三次再发一封假的
    // 「已停跑」通知。缺省 null 时退回旧行为（只看新增目录）。
    listOutputDirs = null } = deps;
  const gh = { owner: config.owner, repo: config.repo, token: config.githubToken };
  const maxFailures = config.maxFailures ?? 3;
  const pendingExpireMs = config.pendingExpireMs ?? 24 * 3600_000;

  // stateUnwritable：本机状态盘写不进去（磁盘满/权限）。这类故障不体现在 failed 上，
  // 却会让止损闸失效或让待补发邮件无声丢失，必须让 index.js 据此以非零码退出触发报警。
  const summary = { processed: 0, published: 0, emailed: 0, deduped: 0, parked: 0, failed: 0, pendingPublish: 0, stateUnwritable: false };

  // 连续失败计数（issue 号 → 次数，跨 tick 存本地文件）。「研究未产出→留待重跑」的 Issue
  // 若持续失败，launchd 每 5 分钟一 tick 会全额重跑一次 /research（每次都真实花额度），
  // 一整天可烧上百次——达 maxFailures 即自动停跑止损。成功即清零（连续语义，偶发故障不累计）。
  const failures = await loadFailures();

  // 失败计数必须**立刻**落盘，且落盘失败不能当没事发生。
  // 计数只在轮末统一保存的话，落盘一旦失败（磁盘满、权限、进程被杀），下一 tick 读到的还是旧
  // 计数——「连续 3 次未产出即停跑」这道止损闸整体失效，每 5 分钟一 tick 全额重跑一次 /research。
  // 返回是否落盘成功，调用方据此决定是否改走保守路径。
  async function persistFailures() {
    try {
      await saveFailures(failures);
      return true;
    } catch (err) {
      log(`⚠️ 失败计数落盘失败（${err.message}）——止损闸失效风险，本轮改走保守路径`);
      return false;
    }
  }

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
    // 每处理完一条就把「剩余待办」落盘（先落盘、再发信）。全轮跑完才统一保存的话，落盘失败
    // 或中途中断会让已经发过信的条目留在磁盘队列里，下一轮重新探活（秒过）再发一封重复的
    // 「已上线」邮件——每 5 分钟一 tick，故障持续多久就轰炸多少封。
    // 落盘失败即中止本轮补发：宁可这一条晚一轮发，也不要重复发。
    const queue = [...pending];
    let saveBroken = false;
    async function persistRemaining(processedIdx) {
      try {
        await savePending([...stillPending, ...queue.slice(processedIdx + 1)]);
        return true;
      } catch (err) {
        log(`⚠️ 待确认队列落盘失败（${err.message}），中止本轮补发以免下轮重复发信`);
        summary.stateUnwritable = true;
        saveBroken = true;
        return false;
      }
    }
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i];
      if (saveBroken) { stillPending.push(p); continue; }
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
      // 先把「这条已出队」落盘，再发信：反过来的话落盘一失败，这封信下轮还会再发一遍。
      if (!(await persistRemaining(i))) { stillPending.push({ ...p, firstSeen }); continue; }
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
        // 把它放回队列（上面已按「出队」落过盘）。这次再落盘失败就危险了：条目既没发出信、
        // 又已经从磁盘上消失，下轮不会重试、彻底无痕。必须留下报警信号。
        if (!(await persistRemaining(i))) {
          summary.stateUnwritable = true;
          log(`⚠️ #${p.number} 放回待确认队列也失败——该条「已上线」邮件有永久丢失风险，请人工核对：${p.url}`);
        }
      }
    }
    pending = stillPending;
    // 收尾再落一次盘：阶段 2 若中途抛错（如取 Issue 列表失败导致 runOnce 中止），已补发成功的
    // 条目绝不能留在磁盘队列里——否则下一轮会重新探活（秒过）并再给提交者发一封重复的
    // 「已上线」邮件，GitHub 侧故障持续多久就重复多少封。
    if (!saveBroken) {
      try { await savePending(pending); } catch (e) { log(`⚠️ 待确认队列收尾落盘失败：${e.message}`); }
    }
  }

  // —— 2) 处理 approved 未 done 的新队列 ——
  // 拉队列是本轮唯一「没有内部兜底就会打崩整轮」的裸露外部依赖：GitHub 抽风 / 墙内到 api.github.com
  // 的分钟级瞬断（2026-07-15、07-17 实测）会让 fetch 抛错或返回 5xx，重试用尽后冒泡成未捕获异常
  // → exit 1 → 每 tick 都误发 runner-failed 报警。这类外部瞬时故障标记 queueUnreachable 交给
  // index.js 做跨 tick 防抖（连续断满才报，见 alert.js QUEUE_FETCH_CONFIRM_TICKS）；4xx（PAT 失效等
  // 配置问题）不属瞬时，照旧抛出立即报警、不被防抖掩盖。此前补发阶段的 pending 已在上面落盘，
  // 这里提前 return 不会丢状态、也不会重复发信。
  let issues;
  try {
    issues = await listApprovedIssues(gh, fetchImpl);
  } catch (err) {
    if (isTransientQueueError(err)) {
      summary.queueUnreachable = true;
      log(`拉 approved 队列失败（外部瞬时故障：${err.message || err}）——本轮不处理，交由防抖判定是否报警`);
      return summary;
    }
    throw err;
  }
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
    // 开跑前重查一次标签/状态：队列快照是本轮开头一次性取的，而一轮会串行跑完整个队列、
    // 每条可能几小时。期间作者撤掉 approved、贴上 done 或关掉 Issue（题目有问题、提交者说不用了）
    // 对已在批次里的条目本来完全无效，照样白烧一次全力档研究。一次便宜的 GET 换掉这个浪费。
    // 查不到（网络抖动等）就按快照继续——这只是省钱的可选检查，不该拦住主流程。
    try {
      const cur = await fetchIssueState({ ...gh, number: issue.number }, fetchImpl);
      if (cur.state !== "open" || !cur.labels.includes("approved") || cur.labels.includes("done")) {
        log(`#${issue.number} 开跑前复查：已不满足条件（state=${cur.state}、labels=${cur.labels.join("/") || "无"}），跳过不跑`);
        continue;
      }
    } catch (err) {
      log(`#${issue.number} 开跑前复查失败（${err.message}），按队列快照继续`);
    }

    await clearParkSignal();
    // 原始目录快照优先用文件系统的（listOutputDirs），退回 scanDirs 只是为了兼容旧调用方。
    const rawBefore = listOutputDirs ? (await listOutputDirs()).map((d) => d.dir) : existing.map((e) => e.dir);
    const startedAt = now();
    const ok = await runResearch(buildResearchPrompt({ topic, focus }));
    const after = scanDirs();
    const rawAfter = listOutputDirs ? await listOutputDirs() : after.map((e) => ({ dir: e.dir, mtimeMs: 0 }));
    const newDirs = diffNewDirs(rawBefore, rawAfter.map((d) => d.dir));
    // 上一次失败可能留下同名半成品目录，这次重跑就地覆写它——目录名没变，diffNewDirs 什么也看不到。
    // 只要目录内容是在本次运行期间写的，就同样算本次产出，否则这条 Issue 会永远判「未产出」，
    // 重跑到停跑阈值为止，而实际上每次都成功上线了。
    const touchedDirs = listOutputDirs
      ? rawAfter.filter((d) => !newDirs.includes(d.dir) && d.mtimeMs >= startedAt).map((d) => d.dir)
      : [];
    const producedDirs = [...newDirs, ...touchedDirs];

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

    // 研究确实产出了文件夹，但没有一个能被 scanResearch 解析出来（notes.md frontmatter 语法错）。
    // 这不是「没产出」——重跑三次也修不好一个 YAML 错，而且报告因为解析失败根本上不了站。
    // 按 park 的先例处理：贴 done 停跑 + 把真实原因告诉作者，由人工订正后重新发布。
    // scanResearch 收不到这些目录有三种原因，必须分开处理：缺 notes.md（半成品，重跑就能好）、
    // 被 park（另有分支）、以及 frontmatter 语法错（重跑修不好，只能人工订正）。
    // 只有第三种才该停跑——把前两种也一并停掉，等于第一次失败就永久放弃一条本可自愈的调研。
    const producedInfo = rawAfter.filter((d) => producedDirs.includes(d.dir));
    const unparsable = producedInfo.filter((d) => d.hasNotes !== false && !d.parked);
    if (ok && producedDirs.length && !after.some((e) => producedDirs.includes(e.dir)) && unparsable.length) {
      summary.parked++;
      const badDirs = unparsable.map((d) => d.dir).join("、");
      log(`#${issue.number} 研究已产出 ${badDirs}，但 notes.md 解析失败（报告无法上站），停跑待人工订正`);
      try {
        await sendEmail(composeParkNotice({
          topic,
          reason: `研究已产出目录 ${badDirs}，但其 notes.md 的 frontmatter 解析失败，报告无法进入站点构建。请人工订正 YAML 后重新发布（重跑无法修复语法错误）。`,
          folder: unparsable[0].dir,
          authorEmail: config.authorEmail, fromEmail: config.smtpUser,
        }));
      } catch (err) {
        log(`#${issue.number} 解析失败通知邮件发送失败：${err.message}`);
      }
      try {
        await addLabel({ ...gh, number: issue.number, label: "done" }, fetchImpl);
      } catch (err) {
        log(`#${issue.number} 解析失败后贴 done 失败：${err.message}`);
      }
      try {
        await commentIssue(
          { ...gh, number: issue.number,
            body: `⚠️ 研究已产出 ${badDirs}，但 notes.md frontmatter 解析失败，报告无法进入站点构建，已停跑待人工订正（重跑修不了语法错误）。已邮件通知作者。` },
          fetchImpl
        );
      } catch (e) {
        log(`#${issue.number} 解析失败评论失败（不影响已发通知）：${e.message}`);
      }
      continue;
    }

    if (!ok || producedDirs.length === 0) {
      summary.failed++;
      const count = prevFails + 1;
      failures[issue.number] = count;
      // 立刻落盘（不等轮末）：本批后续若中断，这一次失败也必须算数，否则计数永远推不到阈值。
      const persisted = await persistFailures();
      if (count >= maxFailures) {
        await stopRetrying(issue, topic, count); // 达阈值就地止损，不必等下一轮再烧一次
      } else if (!persisted) {
        // 计数存不下来 = 下一 tick 还会从旧计数起算，止损闸推不到阈值，每 5 分钟烧一次全力档研究。
        // 但也不能就此对每条 Issue 贴 done：磁盘满/权限往往是瞬时运维故障，而贴 done 不可逆
        // （得人工去 GitHub 摘标签），一次抖动会把整条队列全部永久停跑、并按 count=1 发出
        // 「连续 1 次研究未产出」这种自相矛盾的信。正确做法是本轮就地收工、把故障报出去：
        // 不再 spawn 新的 claude（额度不会失控），Issue 保持可重试，运维修好盘后自动恢复。
        summary.stateUnwritable = true;
        log(`#${issue.number} 失败计数无法持久化，本轮提前收工（不再开跑新研究，Issue 保持可重试）`);
        break;
      } else {
        log(`#${issue.number} 研究未产出（claude 退出码非 0 或无新文件夹），连续第 ${count}/${maxFailures} 次，不贴 done，留待重跑`);
      }
      continue;
    }
    delete failures[issue.number]; // 研究成功即清零：只有「连续」失败才累计停跑
    await persistFailures();

    // 正常每次 /research 只产出 1 个文件夹（SKILL Step 4），故取首个本次产出的目录即可。
    const entry = after.find((e) => producedDirs.includes(e.dir));
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
    // 计 pendingPublish 而非 failed：研究本身已成功，部署慢/等 deploy-retry.yml 自动补跑是
    // 常态（补跑常超出这里的探活窗口），pending 队列会每轮自动重探补发、超龄才专信告警——
    // 此处计 failed 会让 runner exit 1，误发「管线故障」报警（2026-07-09 黄河旋风即误报）。
    if (!(await verifyPublished(url))) {
      summary.pendingPublish++;
      log(`#${issue.number} 已完成研究并推送，但未确认上线（部署慢或待自动补跑，已入待确认队列）：${url}`);
      // 记入「上线待确认」队列：后续每轮自动重探，确认上线即自动补发邮件，无需人工盯评论。
      // 必须立刻落盘（不等轮末统一保存）：本批后续任一步抛错、或进程被裸 kill，done 标签已经
      // 贴上、这条却随进程消失——下轮不会重跑（有 done）、也不在待确认队列里，提交者那封
      // 「已上线」邮件就此永久丢失，且没有任何痕迹。
      pending.push({ number: issue.number, topic, title: entry.title, tldr: entry.tldr, url, firstSeen: now() });
      try {
        await savePending(pending);
      } catch (e) {
        // 这条已贴 done（下轮不会重跑）又没进磁盘队列——提交者那封「已上线」邮件会永久丢失。
        // 必须留下能让 runner 以非零码退出的信号，否则整件事完全静默。
        summary.stateUnwritable = true;
        log(`#${issue.number} 待确认队列落盘失败（${e.message}），该条补发邮件有丢失风险，请人工核对：${url}`);
      }
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
  // 落盘失败不让它冒泡打崩整轮——本轮该发的信都发完了，冒泡只会多一封误报的「管线故障」报警。
  try { await savePending(pending); } catch (e) { summary.stateUnwritable = true; log(`⚠️ 待确认队列落盘失败：${e.message}`); }

  // 持久化失败计数，并修剪掉不在 approved 队列里的残留（已 done / 被人工处理的），防状态文件
  // 无限膨胀。被人工干预过的 Issue 若日后重新 approved 会从零重新计数——作者已介入，给新预算。
  const inQueue = new Set(issues.map((i) => String(i.number)));
  for (const k of Object.keys(failures)) if (!inQueue.has(k)) delete failures[k];
  await persistFailures();

  log(`完成：处理 ${summary.processed}、上线 ${summary.published}、发信 ${summary.emailed}、查重跳过 ${summary.deduped}、搁置 ${summary.parked}、上线待确认 ${summary.pendingPublish}、失败 ${summary.failed}`);
  return summary;
}
