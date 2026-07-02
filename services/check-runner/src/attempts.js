// services/check-runner/src/attempts.js
// 任务级失败计数（毒任务封顶用）：某条任务反复失败达上限后，runner 停止重试、退休该任务。
// 持久化经注入的 load/save（真实现落本机 JSON 文件），离线可测。
// 条目按 updatedAt 过期清理——任务在 KV 里 7 天 TTL，这里默认留 8 天余量。

const DEFAULT_PRUNE_MS = 8 * 24 * 3600_000;

export function createAttemptsStore({ load, save, now = () => Date.now(), pruneMs = DEFAULT_PRUNE_MS }) {
  let map = null;

  function ensure() {
    if (map) return;
    try {
      map = load() || {};
    } catch {
      map = {}; // 文件损坏 / 读不出来 → 从空表开始（计数丢失只是多重试几次，可接受）
    }
    const cutoff = now() - pruneMs;
    for (const id of Object.keys(map)) {
      if (!(map[id] && map[id].updatedAt > cutoff)) delete map[id];
    }
  }

  function persist() {
    try {
      save(map);
    } catch {} // 写盘失败不冒泡：本轮内计数仍生效，丢持久化同上可接受
  }

  return {
    get(id) {
      ensure();
      return (map[id] && map[id].count) || 0;
    },
    increment(id) {
      ensure();
      const count = ((map[id] && map[id].count) || 0) + 1;
      map[id] = { count, updatedAt: now() };
      persist();
      return count;
    },
    clear(id) {
      ensure();
      if (!map[id]) return;
      delete map[id];
      persist();
    },
  };
}
