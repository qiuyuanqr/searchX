// services/runner/src/issues.test.js
import { test, expect } from "bun:test";
import { listApprovedIssues, addLabel, commentIssue } from "./issues.js";

test("listApprovedIssues：过滤掉 PR 与含 done 的，URL/headers 正确", async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url: String(url), opts };
    return {
      ok: true,
      json: async () => [
        { number: 1, title: "A", body: "b1", labels: [{ name: "approved" }] },
        { number: 2, title: "B", body: "b2", labels: [{ name: "approved" }, { name: "done" }] },
        { number: 3, title: "PR", body: "", labels: [{ name: "approved" }], pull_request: {} },
      ],
    };
  };
  const out = await listApprovedIssues({ owner: "o", repo: "r", token: "T" }, fetchImpl);
  expect(out.map((i) => i.number)).toEqual([1]);
  expect(out[0]).toEqual({ number: 1, title: "A", body: "b1", labels: ["approved"] });
  expect(seen.url).toContain("/repos/o/r/issues?state=open&labels=approved");
  expect(seen.opts.headers.authorization).toBe("Bearer T");
  expect(seen.opts.headers["user-agent"]).toBeTruthy();
});

test("listApprovedIssues：非 2xx 抛错", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403 });
  await expect(
    listApprovedIssues({ owner: "o", repo: "r", token: "T" }, fetchImpl)
  ).rejects.toThrow(/403/);
});

test("addLabel POST 到 /labels 带 labels 体", async () => {
  let seen;
  const fetchImpl = async (url, opts) => { seen = { url: String(url), opts }; return { ok: true, json: async () => [] }; };
  await addLabel({ owner: "o", repo: "r", token: "T", number: 5, label: "done" }, fetchImpl);
  expect(seen.url).toBe("https://api.github.com/repos/o/r/issues/5/labels");
  expect(JSON.parse(seen.opts.body)).toEqual({ labels: ["done"] });
});

test("commentIssue POST 到 /comments 带 body", async () => {
  let seen;
  const fetchImpl = async (url, opts) => { seen = { url: String(url), opts }; return { ok: true, json: async () => ({}) }; };
  await commentIssue({ owner: "o", repo: "r", token: "T", number: 5, body: "hi" }, fetchImpl);
  expect(seen.url).toBe("https://api.github.com/repos/o/r/issues/5/comments");
  expect(JSON.parse(seen.opts.body)).toEqual({ body: "hi" });
});
