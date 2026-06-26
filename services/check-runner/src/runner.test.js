// services/check-runner/src/runner.test.js
import { describe, it, expect } from "bun:test";
import { runOnce } from "./runner.js";

function makeTasks(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `task-${i}`,
    text: `消息 ${i}`,
    link: "",
    status: "pending",
    createdAt: "2026-06-27T10:00:00Z",
  }));
}

describe("runOnce", () => {
  it("多任务全成功：done=N、fail=0、markDone 逐个调用", async () => {
    const tasks = makeTasks(3);
    const markedDone = [];
    const deps = {
      fetchPending: async () => tasks,
      markDone: async (id) => { markedDone.push(id); },
      runFactcheck: async () => 0,
      buildPrompt: (t) => `/factcheck ${t.text}`,
      notify: null,
      log: () => {},
    };
    const result = await runOnce({}, deps);
    expect(result).toEqual({ processed: 3, done: 3, fail: 0 });
    expect(markedDone).toEqual(["task-0", "task-1", "task-2"]);
  });

  it("某条 runFactcheck 退出码≠0：不 markDone、计入 fail、继续后续", async () => {
    const tasks = makeTasks(3);
    const markedDone = [];
    const deps = {
      fetchPending: async () => tasks,
      markDone: async (id) => { markedDone.push(id); },
      // task-1 失败
      runFactcheck: async (prompt) => (prompt.includes("消息 1") ? 1 : 0),
      buildPrompt: (t) => `/factcheck ${t.text}`,
      notify: null,
      log: () => {},
    };
    const result = await runOnce({}, deps);
    expect(result).toEqual({ processed: 3, done: 2, fail: 1 });
    expect(markedDone).toEqual(["task-0", "task-2"]);
  });

  it("notify 抛错被吞、不影响主流程与计数", async () => {
    const tasks = makeTasks(2);
    const markedDone = [];
    let notifyCallCount = 0;
    const deps = {
      fetchPending: async () => tasks,
      markDone: async (id) => { markedDone.push(id); },
      runFactcheck: async () => 0,
      buildPrompt: (t) => `/factcheck ${t.text}`,
      notify: async () => {
        notifyCallCount++;
        throw new Error("SMTP 挂了");
      },
      log: () => {},
    };
    const result = await runOnce({}, deps);
    expect(result).toEqual({ processed: 2, done: 2, fail: 0 });
    expect(markedDone).toEqual(["task-0", "task-1"]);
    expect(notifyCallCount).toBe(2); // notify 被调用了，只是错误被吞
  });

  it("无任务时空跑", async () => {
    const deps = {
      fetchPending: async () => [],
      markDone: async () => {},
      runFactcheck: async () => 0,
      buildPrompt: (t) => `/factcheck ${t.text}`,
      notify: null,
      log: () => {},
    };
    const result = await runOnce({}, deps);
    expect(result).toEqual({ processed: 0, done: 0, fail: 0 });
  });

  it("notify 为 null 时跳过（不报错）", async () => {
    const tasks = makeTasks(1);
    const deps = {
      fetchPending: async () => tasks,
      markDone: async () => {},
      runFactcheck: async () => 0,
      buildPrompt: (t) => `/factcheck ${t.text}`,
      notify: null,
      log: () => {},
    };
    const result = await runOnce({}, deps);
    expect(result).toEqual({ processed: 1, done: 1, fail: 0 });
  });

  it("fetchPending 抛错：整轮 reject、不调 runFactcheck/markDone/notify", async () => {
    let ran = false, marked = false, notified = false;
    const deps = {
      fetchPending: async () => { throw new Error("pending 401"); },
      markDone: async () => { marked = true; },
      runFactcheck: async () => { ran = true; return 0; },
      buildPrompt: (t) => `/factcheck ${t.text}`,
      notify: async () => { notified = true; },
      log: () => {},
    };
    // 错误向上传播 → 交给入口 top-level catch 释放锁、下轮重试
    await expect(runOnce({}, deps)).rejects.toThrow("pending 401");
    // 整轮在取任务阶段就干净失败，不会半途调用任何副作用
    expect(ran).toBe(false);
    expect(marked).toBe(false);
    expect(notified).toBe(false);
  });
});
