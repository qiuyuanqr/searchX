// services/check-runner/src/poll.test.js
import { describe, it, expect } from "bun:test";
import { fetchPendingChecks, markCheckDone, fetchCheckImage } from "./poll.js";

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

  it("响应缺 tasks 字段时返回空数组、不抛错", async () => {
    const fakeFetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
    const result = await fetchPendingChecks({ workerUrl: BASE, secret: SECRET }, fakeFetch);
    expect(result).toEqual([]);
  });

  it("tasks 非数组时返回空数组、不抛错", async () => {
    const fakeFetch = async () => ({ ok: true, json: async () => ({ ok: true, tasks: "oops" }) });
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

  it("带 summary：POST body 为 JSON {outcome:'done', summary}，content-type json", async () => {
    let body = null, ct = "";
    const fakeFetch = async (url, opts) => {
      body = JSON.parse(opts.body);
      ct = opts.headers["content-type"];
      return { ok: true };
    };
    await markCheckDone(
      { workerUrl: BASE, secret: SECRET, id: "t1", outcome: "done", summary: "属实（高）：确有其事" },
      fakeFetch,
    );
    expect(ct).toBe("application/json");
    expect(body).toEqual({ outcome: "done", summary: "属实（高）：确有其事" });
  });

  it("outcome:failed（退休）：body 只带 outcome，无 summary", async () => {
    let body = null;
    const fakeFetch = async (url, opts) => { body = JSON.parse(opts.body); return { ok: true }; };
    await markCheckDone({ workerUrl: BASE, secret: SECRET, id: "t1", outcome: "failed" }, fakeFetch);
    expect(body).toEqual({ outcome: "failed" });
  });

  it("不带 outcome/summary（旧调用形态）：body 为 {outcome:'done'}", async () => {
    let body = null;
    const fakeFetch = async (url, opts) => { body = JSON.parse(opts.body); return { ok: true }; };
    await markCheckDone({ workerUrl: BASE, secret: SECRET, id: "t1" }, fakeFetch);
    expect(body).toEqual({ outcome: "done" });
  });
});

describe("fetchCheckImage", () => {
  it("调对 URL/头部，返回 {bytes, mime}", async () => {
    const raw = new Uint8Array([1, 2, 3, 4]);
    const fakeFetch = async (url, opts) => {
      expect(url).toBe(`${BASE}/check/abc/image/2`);
      expect(opts.headers["x-check-runner-secret"]).toBe(SECRET);
      return {
        ok: true,
        headers: { get: (h) => (h === "content-type" ? "image/png" : null) },
        arrayBuffer: async () => raw.buffer,
      };
    };
    const got = await fetchCheckImage({ workerUrl: BASE, secret: SECRET, id: "abc", n: 2 }, fakeFetch);
    expect(got.mime).toBe("image/png");
    expect(got.bytes).toEqual(raw);
  });

  it("无 content-type 时 mime 兜底 octet-stream", async () => {
    const fakeFetch = async () => ({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    });
    const got = await fetchCheckImage({ workerUrl: BASE, secret: SECRET, id: "x", n: 0 }, fakeFetch);
    expect(got.mime).toBe("application/octet-stream");
  });

  it("非 2xx 抛错", async () => {
    const fakeFetch = async () => ({ ok: false, status: 404 });
    await expect(
      fetchCheckImage({ workerUrl: BASE, secret: SECRET, id: "x", n: 0 }, fakeFetch)
    ).rejects.toThrow("image 404");
  });
});
