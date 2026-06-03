// services/intake-worker/src/turnstile.test.js
import { test, expect } from "bun:test";
import { verifyTurnstile } from "./turnstile.js";

const okFetch = async (url, opts) => ({
  ok: true,
  json: async () => ({ success: true }),
  _url: url,
  _body: opts.body,
});
const failFetch = async () => ({ ok: true, json: async () => ({ success: false }) });

test("token 为空直接 false，不发请求", async () => {
  let called = false;
  const r = await verifyTurnstile("", "secret", "1.2.3.4", async () => { called = true; });
  expect(r).toBe(false);
  expect(called).toBe(false);
});

test("siteverify success=true → true，且 secret/response/remoteip 进了表单体", async () => {
  let seen;
  const r = await verifyTurnstile("TKN", "SECRET", "1.2.3.4", async (u, o) => {
    seen = o.body;
    return okFetch(u, o);
  });
  expect(r).toBe(true);
  expect(seen).toContain("secret=SECRET");
  expect(seen).toContain("response=TKN");
  expect(seen).toContain("remoteip=1.2.3.4");
});

test("success=false → false", async () => {
  expect(await verifyTurnstile("TKN", "S", null, failFetch)).toBe(false);
});

test("HTTP 非 2xx → false", async () => {
  expect(await verifyTurnstile("TKN", "S", null, async () => ({ ok: false }))).toBe(false);
});
