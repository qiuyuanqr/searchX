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
    expect(result).toEqual({ processed: 3, done: 3, fail: 0, retired: 0 });
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
    expect(result).toEqual({ processed: 3, done: 2, fail: 1, retired: 0 });
    expect(markedDone).toEqual(["task-0", "task-2"]);
  });

  it("markDone 抛错：计入 fail、不冒泡、继续后续、不发该条 notify", async () => {
    const tasks = makeTasks(3);
    const markedDone = [];
    const notified = [];
    const deps = {
      fetchPending: async () => tasks,
      // task-1 的 markDone 抛错（Worker 非 2xx）
      markDone: async (id) => {
        if (id === "task-1") throw new Error("done 502");
        markedDone.push(id);
      },
      runFactcheck: async () => 0,
      buildPrompt: (t) => `/factcheck ${t.text}`,
      notify: async (t) => { notified.push(t.id); },
      log: () => {},
    };
    // 异常被吞、不冒出 runOnce
    const result = await runOnce({}, deps);
    expect(result).toEqual({ processed: 3, done: 2, fail: 1, retired: 0 });
    // task-1 markDone 失败，未计成功，后续 task-2 仍被处理
    expect(markedDone).toEqual(["task-0", "task-2"]);
    // markDone 失败的那条不发通知（任务仍 pending、下轮会重跑）
    expect(notified).toEqual(["task-0", "task-2"]);
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
    expect(result).toEqual({ processed: 2, done: 2, fail: 0, retired: 0 });
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
    expect(result).toEqual({ processed: 0, done: 0, fail: 0, retired: 0 });
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
    expect(result).toEqual({ processed: 1, done: 1, fail: 0, retired: 0 });
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

  // ── 图片：prepareImages 落本地文件 + cleanup ───────────────────

  it("带图任务：prepareImages 的 imagePaths 传给 buildPrompt，成功后 cleanup 被调用", async () => {
    const tasks = [{ id: "t0", text: "看图", link: "", status: "pending", images: [{ mime: "image/jpeg", size: 3 }] }];
    let cleaned = 0;
    let promptArg = null;
    const deps = {
      fetchPending: async () => tasks,
      markDone: async () => {},
      runFactcheck: async () => 0,
      prepareImages: async (t) => ({
        imagePaths: [`/tmp/${t.id}/0.jpg`],
        cleanup: () => { cleaned++; },
      }),
      buildPrompt: (t) => { promptArg = t; return "/factcheck x"; },
      notify: null,
      log: () => {},
    };
    const result = await runOnce({}, deps);
    expect(result).toEqual({ processed: 1, done: 1, fail: 0, retired: 0 });
    expect(promptArg.imagePaths).toEqual(["/tmp/t0/0.jpg"]);
    expect(cleaned).toBe(1);
  });

  it("runFactcheck 失败：cleanup 仍被调用（finally），任务不 markDone", async () => {
    const tasks = [{ id: "t0", text: "看图", images: [{ mime: "image/jpeg", size: 3 }] }];
    let cleaned = 0, marked = 0;
    const deps = {
      fetchPending: async () => tasks,
      markDone: async () => { marked++; },
      runFactcheck: async () => 1,
      prepareImages: async () => ({ imagePaths: ["/tmp/t0/0.jpg"], cleanup: () => { cleaned++; } }),
      buildPrompt: () => "/factcheck x",
      notify: null,
      log: () => {},
    };
    const result = await runOnce({}, deps);
    expect(result).toEqual({ processed: 1, done: 0, fail: 1, retired: 0 });
    expect(marked).toBe(0);
    expect(cleaned).toBe(1);
  });

  it("markDone 抛错：cleanup 仍被调用（finally）", async () => {
    const tasks = [{ id: "t0", text: "看图", images: [{ mime: "image/jpeg", size: 3 }] }];
    let cleaned = 0;
    const deps = {
      fetchPending: async () => tasks,
      markDone: async () => { throw new Error("done 502"); },
      runFactcheck: async () => 0,
      prepareImages: async () => ({ imagePaths: ["/tmp/t0/0.jpg"], cleanup: () => { cleaned++; } }),
      buildPrompt: () => "/factcheck x",
      notify: null,
      log: () => {},
    };
    const result = await runOnce({}, deps);
    expect(result).toEqual({ processed: 1, done: 0, fail: 1, retired: 0 });
    expect(cleaned).toBe(1);
  });

  it("prepareImages 抛错：计 fail、不 runFactcheck、不 markDone、继续后续", async () => {
    const tasks = [
      { id: "t0", text: "坏图", images: [{ mime: "image/jpeg", size: 3 }] },
      { id: "t1", text: "好任务", images: [] },
    ];
    let ran = 0, marked = [];
    const deps = {
      fetchPending: async () => tasks,
      markDone: async (id) => { marked.push(id); },
      runFactcheck: async () => { ran++; return 0; },
      prepareImages: async (t) => {
        if (t.id === "t0") throw new Error("image 500");
        return { imagePaths: [], cleanup: () => {} };
      },
      buildPrompt: () => "/factcheck x",
      notify: null,
      log: () => {},
    };
    const result = await runOnce({}, deps);
    expect(result).toEqual({ processed: 2, done: 1, fail: 1, retired: 0 });
    expect(ran).toBe(1);            // 只有 t1 跑了 runFactcheck
    expect(marked).toEqual(["t1"]); // t0 未 markDone
  });

  it("无 prepareImages dep（纯文本场景）：照常工作", async () => {
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
    expect(result).toEqual({ processed: 1, done: 1, fail: 0, retired: 0 });
  });

  // ── 毒任务封顶：attempts 计数 + 达上限退休 ───────────────────

  // 内存版 attempts store，接口同 createAttemptsStore
  function memoryAttempts(initial = {}) {
    const map = { ...initial };
    return {
      get: (id) => map[id] || 0,
      increment: (id) => (map[id] = (map[id] || 0) + 1),
      clear: (id) => { delete map[id]; },
      dump: () => ({ ...map }),
    };
  }

  it("runFactcheck 失败 → attempts.increment；成功 → attempts.clear", async () => {
    const tasks = makeTasks(2); // task-0 成功、task-1 失败
    const attempts = memoryAttempts({ "task-0": 1 }); // task-0 曾失败过一次
    const deps = {
      fetchPending: async () => tasks,
      markDone: async () => {},
      runFactcheck: async (prompt) => (prompt.includes("消息 1") ? 1 : 0),
      buildPrompt: (t) => `/factcheck ${t.text}`,
      attempts,
      notify: null,
      log: () => {},
    };
    const result = await runOnce({}, deps);
    expect(result).toEqual({ processed: 2, done: 1, fail: 1, retired: 0 });
    expect(attempts.dump()).toEqual({ "task-1": 1 }); // task-0 成功后计数被清
  });

  it("prepareImages 抛错 / markDone 抛错：都计入 attempts", async () => {
    const tasks = [
      { id: "t-img", text: "坏图", images: [{ mime: "image/jpeg", size: 3 }] },
      { id: "t-done", text: "标记失败", images: [] },
    ];
    const attempts = memoryAttempts();
    const deps = {
      fetchPending: async () => tasks,
      markDone: async (id) => { if (id === "t-done") throw new Error("done 502"); },
      runFactcheck: async () => 0,
      prepareImages: async (t) => {
        if (t.id === "t-img") throw new Error("image 500");
        return { imagePaths: [], cleanup: () => {} };
      },
      buildPrompt: () => "/factcheck x",
      attempts,
      notify: null,
      log: () => {},
    };
    const result = await runOnce({}, deps);
    expect(result).toEqual({ processed: 2, done: 0, fail: 2, retired: 0 });
    expect(attempts.dump()).toEqual({ "t-img": 1, "t-done": 1 });
  });

  it("达上限任务：不跑 claude，markDone 退休 + notifyFailure + 清计数，计入 retired", async () => {
    const tasks = makeTasks(2); // task-0 已达上限、task-1 正常
    const attempts = memoryAttempts({ "task-0": 3 });
    const markedDone = [], failNotified = [];
    let ran = 0;
    const deps = {
      fetchPending: async () => tasks,
      markDone: async (id) => { markedDone.push(id); },
      runFactcheck: async () => { ran++; return 0; },
      buildPrompt: (t) => `/factcheck ${t.text}`,
      attempts,
      notifyFailure: async (t) => { failNotified.push(t.id); },
      notify: null,
      log: () => {},
    };
    const result = await runOnce({ maxAttempts: 3 }, deps);
    expect(result).toEqual({ processed: 2, done: 1, fail: 0, retired: 1 });
    expect(ran).toBe(1); // 只有 task-1 真正跑了 claude
    expect(markedDone).toEqual(["task-0", "task-1"]); // task-0 被退休标 done
    expect(failNotified).toEqual(["task-0"]);
    expect(attempts.dump()).toEqual({}); // 两条计数都被清
  });

  it("退休时 markDone 抛错：不通知、不清计数、仍计 retired、继续后续（下轮再试退休）", async () => {
    const tasks = makeTasks(2);
    const attempts = memoryAttempts({ "task-0": 3 });
    const failNotified = [];
    const deps = {
      fetchPending: async () => tasks,
      markDone: async (id) => { if (id === "task-0") throw new Error("done 502"); },
      runFactcheck: async () => 0,
      buildPrompt: (t) => `/factcheck ${t.text}`,
      attempts,
      notifyFailure: async (t) => { failNotified.push(t.id); },
      notify: null,
      log: () => {},
    };
    const result = await runOnce({ maxAttempts: 3 }, deps);
    expect(result).toEqual({ processed: 2, done: 1, fail: 0, retired: 1 });
    expect(failNotified).toEqual([]); // 退休未成功，不发通知（防每轮重复发信）
    expect(attempts.dump()["task-0"]).toBe(3); // 计数保留，下轮继续走退休
  });

  it("notifyFailure 抛错被吞：退休照常完成", async () => {
    const tasks = makeTasks(1);
    const attempts = memoryAttempts({ "task-0": 3 });
    const markedDone = [];
    const deps = {
      fetchPending: async () => tasks,
      markDone: async (id) => { markedDone.push(id); },
      runFactcheck: async () => 0,
      buildPrompt: (t) => `/factcheck ${t.text}`,
      attempts,
      notifyFailure: async () => { throw new Error("SMTP 挂了"); },
      notify: null,
      log: () => {},
    };
    const result = await runOnce({ maxAttempts: 3 }, deps);
    expect(result).toEqual({ processed: 1, done: 0, fail: 0, retired: 1 });
    expect(markedDone).toEqual(["task-0"]);
    expect(attempts.dump()).toEqual({}); // 计数已清
  });

  it("maxAttempts 默认 3：计数 2 的任务照常跑，计数 3 的退休", async () => {
    const tasks = makeTasks(2); // task-0 计数 2、task-1 计数 3
    const attempts = memoryAttempts({ "task-0": 2, "task-1": 3 });
    let ran = [];
    const deps = {
      fetchPending: async () => tasks,
      markDone: async () => {},
      runFactcheck: async () => 0,
      buildPrompt: (t) => { ran.push(t.id); return `/factcheck ${t.text}`; },
      attempts,
      notifyFailure: null,
      notify: null,
      log: () => {},
    };
    const result = await runOnce({}, deps); // 不传 maxAttempts → 默认 3
    expect(result).toEqual({ processed: 2, done: 1, fail: 0, retired: 1 });
    expect(ran).toEqual(["task-0"]);
  });

  it("无 attempts dep：行为与旧版一致（失败任务留待重跑，不退休）", async () => {
    const tasks = makeTasks(1);
    const deps = {
      fetchPending: async () => tasks,
      markDone: async () => {},
      runFactcheck: async () => 1,
      buildPrompt: (t) => `/factcheck ${t.text}`,
      notify: null,
      log: () => {},
    };
    const result = await runOnce({}, deps);
    expect(result).toEqual({ processed: 1, done: 0, fail: 1, retired: 0 });
  });

  // ── 结论回显：prepareVerdict 信号文件 → markDone 带 outcome/summary ──

  it("prepareVerdict：verdictPath 传给 buildPrompt，成功后 readVerdict 的结论随 markDone 上报，cleanup 被调", async () => {
    const tasks = makeTasks(1);
    let promptArg = null, doneArgs = [], cleaned = 0;
    const deps = {
      fetchPending: async () => tasks,
      markDone: async (id, info) => { doneArgs.push([id, info]); },
      runFactcheck: async () => 0,
      prepareVerdict: (t) => ({
        verdictPath: `/tmp/searchx-check/${t.id}/verdict.txt`,
        readVerdict: () => "属实（高）：确有其事",
        cleanup: () => { cleaned++; },
      }),
      buildPrompt: (t) => { promptArg = t; return "/factcheck x"; },
      notify: null,
      log: () => {},
    };
    const result = await runOnce({}, deps);
    expect(result).toEqual({ processed: 1, done: 1, fail: 0, retired: 0 });
    expect(promptArg.verdictPath).toBe("/tmp/searchx-check/task-0/verdict.txt");
    expect(doneArgs).toEqual([["task-0", { outcome: "done", summary: "属实（高）：确有其事" }]]);
    expect(cleaned).toBe(1);
  });

  it("readVerdict 返回 null / 抛错：降级为无 summary，照常 markDone（结论回显不是硬依赖）", async () => {
    const tasks = makeTasks(2); // task-0 读到 null、task-1 读取抛错
    const doneArgs = [];
    const deps = {
      fetchPending: async () => tasks,
      markDone: async (id, info) => { doneArgs.push([id, info]); },
      runFactcheck: async () => 0,
      prepareVerdict: (t) => ({
        verdictPath: `/tmp/${t.id}/verdict.txt`,
        readVerdict: () => { if (t.id === "task-1") throw new Error("读文件失败"); return null; },
        cleanup: () => {},
      }),
      buildPrompt: () => "/factcheck x",
      notify: null,
      log: () => {},
    };
    const result = await runOnce({}, deps);
    expect(result).toEqual({ processed: 2, done: 2, fail: 0, retired: 0 });
    expect(doneArgs).toEqual([
      ["task-0", { outcome: "done", summary: "" }],
      ["task-1", { outcome: "done", summary: "" }],
    ]);
  });

  it("prepareVerdict 本身抛错：降级为不带结论文件，任务照常核查", async () => {
    const tasks = makeTasks(1);
    let promptArg = null, doneArgs = [];
    const deps = {
      fetchPending: async () => tasks,
      markDone: async (id, info) => { doneArgs.push([id, info]); },
      runFactcheck: async () => 0,
      prepareVerdict: () => { throw new Error("mkdir 失败"); },
      buildPrompt: (t) => { promptArg = t; return "/factcheck x"; },
      notify: null,
      log: () => {},
    };
    const result = await runOnce({}, deps);
    expect(result).toEqual({ processed: 1, done: 1, fail: 0, retired: 0 });
    expect(promptArg.verdictPath).toBeUndefined();
    expect(doneArgs).toEqual([["task-0", { outcome: "done", summary: "" }]]);
  });

  it("runFactcheck 失败：verdict cleanup 仍被调（finally）", async () => {
    const tasks = makeTasks(1);
    let cleaned = 0;
    const deps = {
      fetchPending: async () => tasks,
      markDone: async () => {},
      runFactcheck: async () => 1,
      prepareVerdict: () => ({ verdictPath: "/tmp/v.txt", readVerdict: () => null, cleanup: () => { cleaned++; } }),
      buildPrompt: () => "/factcheck x",
      notify: null,
      log: () => {},
    };
    await runOnce({}, deps);
    expect(cleaned).toBe(1);
  });

  it("退休路径：markDone 带 {outcome:'failed'} 和一行原因 summary（回显到手机页）", async () => {
    const tasks = makeTasks(1);
    const attempts = memoryAttempts({ "task-0": 3 });
    const doneArgs = [];
    const deps = {
      fetchPending: async () => tasks,
      markDone: async (id, info) => { doneArgs.push([id, info]); },
      runFactcheck: async () => 0,
      buildPrompt: (t) => `/factcheck ${t.text}`,
      attempts,
      notifyFailure: null,
      notify: null,
      log: () => {},
    };
    const result = await runOnce({}, deps);
    expect(result).toEqual({ processed: 1, done: 0, fail: 0, retired: 1 });
    expect(doneArgs).toEqual([
      ["task-0", { outcome: "failed", summary: "连续失败 3 次，已停止重试，请重新提交一次" }],
    ]);
  });

  it("无 prepareVerdict dep：markDone 带 {outcome:'done', summary:''}（与 Worker 兼容）", async () => {
    const tasks = makeTasks(1);
    const doneArgs = [];
    const deps = {
      fetchPending: async () => tasks,
      markDone: async (id, info) => { doneArgs.push([id, info]); },
      runFactcheck: async () => 0,
      buildPrompt: (t) => `/factcheck ${t.text}`,
      notify: null,
      log: () => {},
    };
    await runOnce({}, deps);
    expect(doneArgs).toEqual([["task-0", { outcome: "done", summary: "" }]]);
  });

  // ── 完整结果回传：resultPath 进 prompt、readResult 随 markDone 上报 ──

  it("resultPath 传给 buildPrompt（prompt 指示 skill 另写整篇）", async () => {
    const tasks = makeTasks(1);
    let promptArg = null;
    const deps = {
      fetchPending: async () => tasks,
      markDone: async () => {},
      runFactcheck: async () => 0,
      prepareVerdict: (t) => ({
        verdictPath: `/tmp/${t.id}/verdict.txt`,
        resultPath: `/tmp/${t.id}/result.md`,
        readVerdict: () => null,
        readResult: () => null,
        cleanup: () => {},
      }),
      buildPrompt: (t) => { promptArg = t; return "/factcheck x"; },
      notify: null, log: () => {},
    };
    await runOnce({}, deps);
    expect(promptArg.resultPath).toBe("/tmp/task-0/result.md");
  });

  it("readResult 有内容：整篇随 markDone 上报（result 字段）", async () => {
    const tasks = makeTasks(1);
    const doneArgs = [];
    const deps = {
      fetchPending: async () => tasks,
      markDone: async (id, info) => { doneArgs.push([id, info]); },
      runFactcheck: async () => 0,
      prepareVerdict: (t) => ({
        verdictPath: `/tmp/${t.id}/verdict.txt`,
        resultPath: `/tmp/${t.id}/result.md`,
        readVerdict: () => "属实（高）：真",
        readResult: () => "---\nverdict: 属实\n---\n## 真相直述\n真。",
        cleanup: () => {},
      }),
      buildPrompt: () => "/factcheck x",
      notify: null, log: () => {},
    };
    const r = await runOnce({}, deps);
    expect(r).toEqual({ processed: 1, done: 1, fail: 0, retired: 0 });
    expect(doneArgs).toEqual([["task-0", { outcome: "done", summary: "属实（高）：真", result: "---\nverdict: 属实\n---\n## 真相直述\n真。" }]]);
  });

  it("readResult 返回 null / 无 readResult：降级为不带 result 字段", async () => {
    const tasks = makeTasks(2); // task-0 readResult=null；task-1 根本没有 readResult
    const doneArgs = [];
    const deps = {
      fetchPending: async () => tasks,
      markDone: async (id, info) => { doneArgs.push([id, info]); },
      runFactcheck: async () => 0,
      prepareVerdict: (t) => t.id === "task-0"
        ? { verdictPath: "/tmp/v", resultPath: "/tmp/r", readVerdict: () => "s", readResult: () => null, cleanup: () => {} }
        : { verdictPath: "/tmp/v", readVerdict: () => "s", cleanup: () => {} },
      buildPrompt: () => "/factcheck x",
      notify: null, log: () => {},
    };
    await runOnce({}, deps);
    expect(doneArgs).toEqual([
      ["task-0", { outcome: "done", summary: "s" }],
      ["task-1", { outcome: "done", summary: "s" }],
    ]);
  });

  // ── 内容标题回传：titlePath 进 prompt、readTitle 随 markDone 上报（title 字段）──

  it("titlePath 传给 buildPrompt（prompt 指示 skill 起个标题）", async () => {
    const tasks = makeTasks(1);
    let promptArg = null;
    const deps = {
      fetchPending: async () => tasks,
      markDone: async () => {},
      runFactcheck: async () => 0,
      prepareVerdict: (t) => ({
        verdictPath: `/tmp/${t.id}/verdict.txt`,
        titlePath: `/tmp/${t.id}/title.txt`,
        readVerdict: () => null,
        readTitle: () => null,
        cleanup: () => {},
      }),
      buildPrompt: (t) => { promptArg = t; return "/factcheck x"; },
      notify: null, log: () => {},
    };
    await runOnce({}, deps);
    expect(promptArg.titlePath).toBe("/tmp/task-0/title.txt");
  });

  it("readTitle 有内容：标题随 markDone 上报（title 字段）", async () => {
    const tasks = makeTasks(1);
    const doneArgs = [];
    const deps = {
      fetchPending: async () => tasks,
      markDone: async (id, info) => { doneArgs.push([id, info]); },
      runFactcheck: async () => 0,
      prepareVerdict: (t) => ({
        verdictPath: `/tmp/${t.id}/verdict.txt`,
        titlePath: `/tmp/${t.id}/title.txt`,
        readVerdict: () => "属实（高）：真",
        readTitle: () => "某公司五倍海力士说法",
        cleanup: () => {},
      }),
      buildPrompt: () => "/factcheck x",
      notify: null, log: () => {},
    };
    const r = await runOnce({}, deps);
    expect(r).toEqual({ processed: 1, done: 1, fail: 0, retired: 0 });
    expect(doneArgs).toEqual([["task-0", { outcome: "done", summary: "属实（高）：真", title: "某公司五倍海力士说法" }]]);
  });

  it("readTitle 返回 null / 抛错 / 无 readTitle：降级为不带 title 字段", async () => {
    const tasks = makeTasks(3); // task-0 null、task-1 抛错、task-2 无 readTitle
    const doneArgs = [];
    const deps = {
      fetchPending: async () => tasks,
      markDone: async (id, info) => { doneArgs.push([id, info]); },
      runFactcheck: async () => 0,
      prepareVerdict: (t) => {
        if (t.id === "task-2") return { verdictPath: "/tmp/v", readVerdict: () => "s", cleanup: () => {} };
        return {
          verdictPath: "/tmp/v",
          titlePath: "/tmp/title.txt",
          readVerdict: () => "s",
          readTitle: () => { if (t.id === "task-1") throw new Error("读标题失败"); return null; },
          cleanup: () => {},
        };
      },
      buildPrompt: () => "/factcheck x",
      notify: null, log: () => {},
    };
    await runOnce({}, deps);
    expect(doneArgs).toEqual([
      ["task-0", { outcome: "done", summary: "s" }],
      ["task-1", { outcome: "done", summary: "s" }],
      ["task-2", { outcome: "done", summary: "s" }],
    ]);
  });
});
