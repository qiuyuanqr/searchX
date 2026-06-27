// services/check-runner/src/poll.js
// 经 Worker 取/标事实核查任务（共享密钥头鉴权，注入 fetch 便于离线测）。

export async function fetchPendingChecks({ workerUrl, secret }, fetchImpl = fetch) {
  const r = await fetchImpl(`${workerUrl}/check/pending`, {
    headers: { "x-check-runner-secret": secret },
  });
  if (!r.ok) throw new Error(`pending ${r.status}`);
  const { tasks } = await r.json();
  // 守一手：响应缺 tasks 字段或非数组时回空数组，避免 runOnce 里对 tasks.length / for…of 抛错。
  return Array.isArray(tasks) ? tasks : [];
}

export async function markCheckDone({ workerUrl, secret, id }, fetchImpl = fetch) {
  const r = await fetchImpl(`${workerUrl}/check/${id}/done`, {
    method: "POST",
    headers: { "x-check-runner-secret": secret },
  });
  if (!r.ok) throw new Error(`done ${r.status}`);
}
