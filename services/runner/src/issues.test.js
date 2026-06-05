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

test("listApprovedIssues：超过 100 条时翻页取全，不漏尾部", async () => {
  const mk = (n) => ({ number: n, title: `t${n}`, body: "", labels: [{ name: "approved" }] });
  const page1 = Array.from({ length: 100 }, (_, i) => mk(i + 1)); // 满 100 → 还有下一页
  const page2 = [
    ...Array.from({ length: 49 }, (_, i) => mk(101 + i)),
    { number: 150, title: "d", body: "", labels: [{ name: "approved" }, { name: "done" }] },
  ]; // 50 条（<100）→ 末页
  const seen = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    seen.push(u);
    const page = Number(new URL(u).searchParams.get("page"));
    return { ok: true, json: async () => (page === 1 ? page1 : page === 2 ? page2 : []) };
  };
  const out = await listApprovedIssues({ owner: "o", repo: "r", token: "T" }, fetchImpl);
  expect(out.length).toBe(149); // 共 150 条，排除 1 条 done
  expect(out.some((i) => i.number === 150)).toBe(false); // done 被过滤
  expect(out.some((i) => i.number === 130)).toBe(true); // 第二页尾部不再被漏
  expect(seen.length).toBe(2); // page1 满 100 → 取 page2；page2 不足 100 → 停
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
