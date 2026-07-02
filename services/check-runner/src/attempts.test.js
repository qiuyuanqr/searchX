// services/check-runner/src/attempts.test.js
import { describe, it, expect } from "bun:test";
import { createAttemptsStore } from "./attempts.js";

// 简易内存持久化：模拟 index.js 注入的 load/save（真实现落 JSON 文件）
function memoryPersistence(initial = null) {
  let stored = initial;
  return {
    load: () => stored,
    save: (obj) => { stored = JSON.parse(JSON.stringify(obj)); },
    dump: () => stored,
  };
}

describe("createAttemptsStore", () => {
  it("未知任务 get 返回 0", () => {
    const p = memoryPersistence();
    const store = createAttemptsStore({ load: p.load, save: p.save });
    expect(store.get("t-x")).toBe(0);
  });

  it("increment 累加并持久化，返回新计数", () => {
    const p = memoryPersistence();
    const store = createAttemptsStore({ load: p.load, save: p.save });
    expect(store.increment("t-0")).toBe(1);
    expect(store.increment("t-0")).toBe(2);
    expect(store.get("t-0")).toBe(2);
    expect(p.dump()["t-0"].count).toBe(2);
  });

  it("clear 删除该任务计数并持久化", () => {
    const p = memoryPersistence();
    const store = createAttemptsStore({ load: p.load, save: p.save });
    store.increment("t-0");
    store.clear("t-0");
    expect(store.get("t-0")).toBe(0);
    expect(p.dump()["t-0"]).toBeUndefined();
  });

  it("从既有持久化数据恢复计数（跨进程场景）", () => {
    const p = memoryPersistence({ "t-0": { count: 2, updatedAt: Date.now() } });
    const store = createAttemptsStore({ load: p.load, save: p.save });
    expect(store.get("t-0")).toBe(2);
  });

  it("过期条目在加载时被清理（默认 8 天，任务 KV TTL 7 天 + 余量）", () => {
    const now = Date.now();
    const p = memoryPersistence({
      "t-old": { count: 3, updatedAt: now - 9 * 24 * 3600_000 },
      "t-new": { count: 1, updatedAt: now - 1000 },
    });
    const store = createAttemptsStore({ load: p.load, save: p.save, now: () => now });
    expect(store.get("t-old")).toBe(0);
    expect(store.get("t-new")).toBe(1);
  });

  it("load 抛错（文件损坏）→ 从空表开始，不冒泡", () => {
    const store = createAttemptsStore({
      load: () => { throw new Error("JSON 解析失败"); },
      save: () => {},
    });
    expect(store.get("t-0")).toBe(0);
    expect(store.increment("t-0")).toBe(1);
  });

  it("save 抛错（磁盘问题）→ 不冒泡，本轮内计数仍生效", () => {
    const store = createAttemptsStore({
      load: () => null,
      save: () => { throw new Error("写盘失败"); },
    });
    expect(store.increment("t-0")).toBe(1);
    expect(store.get("t-0")).toBe(1);
  });
});
