// services/check-runner/src/poll.test.js
import { describe, it, expect } from "bun:test";
import { fetchPendingChecks, markCheckDone } from "./poll.js";

const BASE = "https://fake.worker.dev";
const SECRET = "test-secret";

describe("fetchPendingChecks", () => {
  it("正常解析 tasks 数组", async () => {
    const tasks = [
      { id: "abc", text: "消息内容", link: "", status: "pending", createdAt: "2026-06-27T10:00:00Z" },
    ];
    const fakeFetch = async (url, opts) => {
      expect(url).toBe(`${BASE}/check/pending`);
      expect(opts.headers["x-check-runner-secret"]).toBe(SECRET);
      return { ok: true, json: async () => ({ ok: true, tasks }) };
    };
    const result = await fetchPendingChecks({ workerUrl: BASE, secret: SECRET }, fakeFetch);
    expect(result).toEqual(tasks);
  });

  it("非 2xx 抛错", async () => {
    const fakeFetch = async () => ({ ok: false, status: 401 });
    await expect(fetchPendingChecks({ workerUrl: BASE, secret: SECRET }, fakeFetch)).rejects.toThrow("pending 401");
  });

  it("无任务时返回空数组", async () => {
    const fakeFetch = async () => ({ ok: true, json: async () => ({ ok: true, tasks: [] }) });
    const result = await fetchPendingChecks({ workerUrl: BASE, secret: SECRET }, fakeFetch);
    expect(result).toEqual([]);
  });
});

describe("markCheckDone", () => {
  it("调对 URL、方法、头部", async () => {
    const id = "task-id-123";
    let called = false;
    const fakeFetch = async (url, opts) => {
      expect(url).toBe(`${BASE}/check/${id}/done`);
      expect(opts.method).toBe("POST");
      expect(opts.headers["x-check-runner-secret"]).toBe(SECRET);
      called = true;
      return { ok: true };
    };
    await markCheckDone({ workerUrl: BASE, secret: SECRET, id }, fakeFetch);
    expect(called).toBe(true);
  });

  it("非 2xx 抛错", async () => {
    const fakeFetch = async () => ({ ok: false, status: 404 });
    await expect(markCheckDone({ workerUrl: BASE, secret: SECRET, id: "x" }, fakeFetch)).rejects.toThrow("done 404");
  });
});
