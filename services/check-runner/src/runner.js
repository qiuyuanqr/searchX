// services/check-runner/src/runner.js
// 一次性编排：取 pending 核查任务 → 跑 /factcheck（claude -p）→ markDone → 可选发信。
// 失败的任务不 markDone（留待下轮重跑），并计入 attempts 失败计数；
// 计数达上限（config.maxAttempts，默认 3）的任务不再跑 claude —— markDone 退休 + 发失败通知，
// 防止一条永远跑不成功的"毒任务"在 KV 7 天 TTL 内每轮烧一次 claude 额度。
// 全部副作用经 deps 注入，离线可测。

export async function runOnce(config, deps) {
  const { fetchPending, markDone, runFactcheck, buildPrompt, prepareImages, prepareVerdict, attempts, notify, notifyFailure, log } = deps;
  const maxAttempts = config.maxAttempts || 3;

  const tasks = await fetchPending();
  log(`待处理核查任务：${tasks.length} 条`);

  let done = 0, fail = 0, retired = 0;

  // 失败路径统一走这里：有 attempts 就计一次数（无 attempts dep 时行为同旧版：只留待重跑）
  const recordFailure = (id) => { if (attempts) attempts.increment(id); };

  for (const t of tasks) {
    // 达上限的任务：不再跑 claude，直接退休（markDone 让它从 pending 消失）+ 失败通知。
    // markDone 失败则保留计数、不通知（防每轮重复发信），下轮再走一次退休。
    if (attempts && attempts.get(t.id) >= maxAttempts) {
      retired++;
      log(`任务 ${t.id} 已失败 ${attempts.get(t.id)} 次（上限 ${maxAttempts}），退休不再重试`);
      try {
        // summary 会回显到手机核查页——让"已失败"章旁边有原因和下一步，不用翻邮件/日志
        await markDone(t.id, { outcome: "failed", summary: `连续失败 ${maxAttempts} 次，已停止重试，请重新提交一次` });
      } catch (err) {
        log(`退休标记失败 ${t.id}（${err.message}），下轮再试退休`);
        continue;
      }
      attempts.clear(t.id);
      if (notifyFailure) {
        try {
          await notifyFailure(t);
        } catch (err) {
          log(`失败通知发送失败 ${t.id}（${err.message}），不影响主流程`);
        }
      }
      continue;
    }

    // 先把图片落成本机临时文件（无图返回空）。下载失败 → 整条按失败、留待重跑，
    // 不进入核查、不 markDone。prepareImages 缺省（纯文本场景）时无图、无清理。
    let imagePaths = [], cleanup = () => {};
    if (prepareImages) {
      try {
        const prep = await prepareImages(t);
        imagePaths = (prep && prep.imagePaths) || [];
        cleanup = (prep && prep.cleanup) || (() => {});
      } catch (err) {
        fail++;
        recordFailure(t.id);
        log(`图片准备失败 ${t.id}（${err.message}），留待重跑`);
        continue;
      }
    }

    // 结论信号文件（回显到手机核查页用）：prepareVerdict 给出路径与读取函数。
    // 任何一步失败都降级为"不带结论"，绝不影响核查主流程（结论回显是增强，不是硬依赖）。
    let verdict = null;
    if (prepareVerdict) {
      try {
        verdict = prepareVerdict(t);
      } catch (err) {
        log(`结论文件准备失败 ${t.id}（${err.message}），本条不回显结论`);
      }
    }

    // cleanup 必须在成功 / 失败 / markDone 抛错任一路径都执行 → 放进 finally。
    try {
      const prompt = buildPrompt({
        ...t,
        imagePaths,
        ...(verdict ? { verdictPath: verdict.verdictPath } : {}),
        ...(verdict && verdict.resultPath ? { resultPath: verdict.resultPath } : {}),
        ...(verdict && verdict.titlePath ? { titlePath: verdict.titlePath } : {}),
      });
      log(`→ 开始核查 ${t.id}`);
      const code = await runFactcheck(prompt);
      if (code !== 0) {
        fail++;
        recordFailure(t.id);
        log(`核查失败 ${t.id}（退出码 ${code}），留待重跑`);
        continue;
      }
      // 标完成必须兜底：markDone 抛错（Worker 非 2xx）若冒泡会中止整批、本批后续任务全被跳过。
      // 失败时计入 fail、不计成功、不发通知，continue 到下一条；任务保持 pending、下轮会重跑
      //（at-least-once，重复跑整条 /factcheck 可接受），目标是别因一条标记失败拖垮整批。
      // markDone 反复失败同样计入 attempts：达上限后走退休路径，不再每轮重跑整条 /factcheck。
      let summary = "", result = "", title = "";
      if (verdict) {
        try { summary = String(verdict.readVerdict() || "").trim(); } catch {} // 读不到就不回显
        if (typeof verdict.readResult === "function") {
          try { result = String(verdict.readResult() || ""); } catch {}        // 读不到就不回传整篇
        }
        if (typeof verdict.readTitle === "function") {
          try { title = String(verdict.readTitle() || "").trim(); } catch {}   // 读不到就不带标题（前端 fallback 旧摘要）
        }
      }
      try {
        await markDone(t.id, { outcome: "done", summary, ...(result ? { result } : {}), ...(title ? { title } : {}) });
      } catch (err) {
        fail++;
        recordFailure(t.id);
        log(`标记完成失败 ${t.id}（${err.message}），任务仍 pending、留待下轮重跑`);
        continue;
      }
      done++;
      if (attempts) attempts.clear(t.id);
      log(`核查完成 ${t.id}`);
      if (notify) {
        try {
          await notify(t);
        } catch (err) {
          log(`通知发送失败 ${t.id}（${err.message}），不影响主流程`);
        }
      }
    } finally {
      try { cleanup(); } catch {}
      if (verdict) { try { verdict.cleanup(); } catch {} }
    }
  }

  log(`完成：处理 ${tasks.length}、成功 ${done}、失败 ${fail}、退休 ${retired}`);
  return { processed: tasks.length, done, fail, retired };
}
