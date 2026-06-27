// services/check-runner/src/runner.js
// 一次性编排：取 pending 核查任务 → 跑 /factcheck（claude -p）→ markDone → 可选发信。
// 失败的任务不 markDone（留待下轮重跑）。
// 全部副作用经 deps 注入，离线可测。

export async function runOnce(config, deps) {
  const { fetchPending, markDone, runFactcheck, buildPrompt, prepareImages, notify, log } = deps;

  const tasks = await fetchPending();
  log(`待处理核查任务：${tasks.length} 条`);

  let done = 0, fail = 0;

  for (const t of tasks) {
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
        log(`图片准备失败 ${t.id}（${err.message}），留待重跑`);
        continue;
      }
    }

    // cleanup 必须在成功 / 失败 / markDone 抛错任一路径都执行 → 放进 finally。
    try {
      const prompt = buildPrompt({ ...t, imagePaths });
      log(`→ 开始核查 ${t.id}`);
      const code = await runFactcheck(prompt);
      if (code !== 0) {
        fail++;
        log(`核查失败 ${t.id}（退出码 ${code}），留待重跑`);
        continue;
      }
      // 标完成必须兜底：markDone 抛错（Worker 非 2xx）若冒泡会中止整批、本批后续任务全被跳过。
      // 失败时计入 fail、不计成功、不发通知，continue 到下一条；任务保持 pending、下轮会重跑
      //（at-least-once，重复跑整条 /factcheck 可接受），目标是别因一条标记失败拖垮整批。
      try {
        await markDone(t.id);
      } catch (err) {
        fail++;
        log(`标记完成失败 ${t.id}（${err.message}），任务仍 pending、留待下轮重跑`);
        continue;
      }
      done++;
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
    }
  }

  log(`完成：处理 ${tasks.length}、成功 ${done}、失败 ${fail}`);
  return { processed: tasks.length, done, fail };
}
