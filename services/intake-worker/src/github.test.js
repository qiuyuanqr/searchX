// services/intake-worker/src/github.test.js
import { test, expect } from "bun:test";
import { createIssue } from "./github.js";

test("成功 → 回 number/url，并带正确的 URL/headers/body", async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ number: 42, html_url: "https://github.com/o/r/issues/42" }) };
  };
  const r = await createIssue(
    { owner: "o", repo: "r", token: "T", title: "标题", body: "正文", labels: ["pending"], assignees: ["qiuyuanqr"] },
    fetchImpl
  );
  expect(r).toEqual({ ok: true, number: 42, url: "https://github.com/o/r/issues/42" });
  expect(seen.url).toBe("https://api.github.com/repos/o/r/issues");
  expect(seen.opts.headers.authorization).toBe("Bearer T");
  expect(seen.opts.headers["user-agent"]).toBeTruthy();
  const body = JSON.parse(seen.opts.body);
  expect(body.title).toBe("标题");
  expect(body.labels).toEqual(["pending"]);
  expect(body.assignees).toEqual(["qiuyuanqr"]);
});

test("非 2xx → ok:false 带 status", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => "forbidden" });
  const r = await createIssue(
    { owner: "o", repo: "r", token: "T", title: "t", body: "b", labels: [], assignees: [] },
    fetchImpl
  );
  expect(r.ok).toBe(false);
  expect(r.status).toBe(403);
});
