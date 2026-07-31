// services/check-runner/src/poll.js
// 经 Worker 取/标事实核查任务（共享密钥头鉴权，注入 fetch 便于离线测）。
//
// 每个请求都必须带单次硬超时。半开连接（TCP 连上但服务端永不回包，墙内对 Worker 的阻断
// 就是这个形态）下裸 fetch 会无限期挂住：runner 进程还活着、锁定期更新锁时间戳照刷，于是后续每个
// launchd tick 都判「已有一轮在跑」exit 0 跳过——管线永久停摆，而 exit 0 又让连败报警
// 永远达不到阈值，全程零信号（2026-07-31 第二轮审查实测：180 秒仍未返回）。

export const REQUEST_TIMEOUT_MS = 30_000;

// AbortSignal.timeout 不可用时手动兜底（与前端 timeoutSignal 同构）。
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

export async function fetchPendingChecks({ workerUrl, secret }, fetchImpl = fetch) {
  const r = await fetchImpl(`${workerUrl}/check/pending`, {
    headers: { "x-check-runner-secret": secret },
    signal: timeoutSignal(REQUEST_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`pending ${r.status}`);
  const { tasks } = await r.json();
  // 守一手：响应缺 tasks 字段或非数组时回空数组，避免 runOnce 里对 tasks.length / for…of 抛错。
  return Array.isArray(tasks) ? tasks : [];
}

// outcome: "done"（默认）| "failed"（退休任务）；summary 为一行结论（可空，空则不带）。
// title 为手机列表那行的简短内容标题（可空，空则不带）。
// 旧版 Worker 不读 body、直接忽略，所以带 body 向后兼容。
export async function markCheckDone({ workerUrl, secret, id, outcome = "done", summary = "", result = "", title = "" }, fetchImpl = fetch) {
  const body = { outcome };
  if (summary) body.summary = summary;
  if (result) body.result = result;
  if (title) body.title = title;
  const r = await fetchImpl(`${workerUrl}/check/${id}/done`, {
    method: "POST",
    headers: { "x-check-runner-secret": secret, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: timeoutSignal(REQUEST_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`done ${r.status}`);
}

// 取某条任务的第 n 张图片字节（runner 密钥鉴权）。返回 { bytes:Uint8Array, mime }。
export async function fetchCheckImage({ workerUrl, secret, id, n }, fetchImpl = fetch) {
  const r = await fetchImpl(`${workerUrl}/check/${id}/image/${n}`, {
    headers: { "x-check-runner-secret": secret },
    // 图片可达 6 MiB，给宽一些，但仍必须有上界
    signal: timeoutSignal(REQUEST_TIMEOUT_MS * 2),
  });
  if (!r.ok) throw new Error(`image ${r.status}`);
  const buf = await r.arrayBuffer();
  const mime = (r.headers && r.headers.get("content-type")) || "application/octet-stream";
  return { bytes: new Uint8Array(buf), mime };
}
