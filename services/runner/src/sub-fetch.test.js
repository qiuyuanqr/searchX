// services/runner/src/sub-fetch.test.js
import { test, expect } from "bun:test";
import { fetchSubmitterEmail } from "./sub-fetch.js";

test("带密钥头请求 /sub/<n>，返回 email", async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url: String(url), opts };
    return { ok: true, json: async () => ({ ok: true, email: "a@b.com" }) };
  };
  const email = await fetchSubmitterEmail(
    { workerUrl: "https://w.dev", secret: "S", issueNumber: 7 },
    fetchImpl
  );
  expect(email).toBe("a@b.com");
  expect(seen.url).toBe("https://w.dev/sub/7");
  expect(seen.opts.headers["x-sub-secret"]).toBe("S");
});

test("非 2xx 抛错", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401 });
  await expect(
    fetchSubmitterEmail({ workerUrl: "https://w.dev", secret: "S", issueNumber: 7 }, fetchImpl)
  ).rejects.toThrow(/401/);
});

test("响应缺 email → 抛错", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true }) });
  await expect(
    fetchSubmitterEmail({ workerUrl: "https://w.dev", secret: "S", issueNumber: 7 }, fetchImpl)
  ).rejects.toThrow(/email/);
});
