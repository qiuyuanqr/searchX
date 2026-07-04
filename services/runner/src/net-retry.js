// services/runner/src/net-retry.js
// 瞬时网络故障重试包装：本机到 GitHub / Worker 的链路偶发秒级抖动（TLS 握手失败、连接被断），
// 单次失败不该打崩整轮 runner（2026-07-04 03:40 即因一次 UNKNOWN_CERTIFICATE_VERIFICATION_ERROR
// 未捕获而 exit=1 误报警）。只重试「请求抛错」（连接/TLS 类，请求根本没送达或没拿到响应）；
// 拿到 HTTP 响应（含 4xx/5xx）一律原样返回，由调用方按业务判定——避免盲目重试非幂等写操作。
// 每次尝试带单次硬超时（AbortSignal.timeout）：连接卡死不回包时若无超时，这次 fetch 永不返回
// → runner 永久占全局单实例锁、堵死队列（与 verify-published.js 同一先例）。
// 重试次数用尽仍失败则原样抛出——持续性故障照常 exit=1 触发报警，报警语义不变。

export function withNetRetry(fetchImpl = fetch, {
  attempts = 3,
  baseDelayMs = 2000,   // 线性退避：2s、4s
  perTryMs = 30_000,    // 单次尝试硬超时
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
} = {}) {
  return async (url, init = {}) => {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        // 调用方自带 signal 时尊重之（当前无此调用方）；否则补单次硬超时
        return await fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(perTryMs) });
      } catch (e) {
        lastErr = e;
        if (i === attempts) break;
        const delay = baseDelayMs * i;
        log(`网络请求失败（第 ${i}/${attempts} 次：${e?.code || e?.message || e}），${Math.round(delay / 1000)}s 后重试：${url}`);
        await sleep(delay);
      }
    }
    throw lastErr;
  };
}
