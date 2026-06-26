// services/check-runner/src/runner.js
// 一次性编排：取 pending 核查任务 → 跑 /factcheck（claude -p）→ markDone → 可选发信。
// 失败的任务不 markDone（留待下轮重跑）。
// 全部副作用经 deps 注入，离线可测。

export async function runOnce(config, deps) {
  const { fetchPending, markDone, runFactcheck, buildPrompt, notify, log } = deps;

  const tasks = await fetchPending();
  log(`待处理核查任务：${tasks.length} 条`);

  let done = 0, fail = 0;

  for (const t of tasks) {
    const prompt = buildPrompt(t);
    log(`→ 开始核查 ${t.id}`);
    const code = await runFactcheck(prompt);
    if (code !== 0) {
      fail++;
      log(`核查失败 ${t.id}（退出码 ${code}），留待重跑`);
      continue;
    }
    await markDone(t.id);
    done++;
    log(`核查完成 ${t.id}`);
    if (notify) {
      try {
        await notify(t);
      } catch (err) {
        log(`通知发送失败 ${t.id}（${err.message}），不影响主流程`);
      }
    }
  }

  log(`完成：处理 ${tasks.length}、成功 ${done}、失败 ${fail}`);
  return { processed: tasks.length, done, fail };
}
