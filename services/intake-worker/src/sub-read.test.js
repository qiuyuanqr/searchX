// services/intake-worker/src/sub-read.test.js
import { test, expect } from "bun:test";
import { handleSubRead } from "./sub-read.js";

function fakeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { store: m, async get(k){return m.has(k)?m.get(k):null;}, async put(k,v){m.set(k,v);} };
}
const ENV = (over = {}) => ({
  SUB_READ_SECRET: "S3CRET",
  INTAKE_KV: fakeKV({ "sub:7": "alice@gmail.com" }),
  ...over,
});
const get = (path, headers = {}) =>
  new Request(`https://w.dev${path}`, { method: "GET", headers });

test("非 GET → 405", async () => {
  const res = await handleSubRead(new Request("https://w.dev/sub/7", { method: "POST" }), ENV());
  expect(res.status).toBe(405);
});

test("缺密钥头 → 401", async () => {
  expect((await handleSubRead(get("/sub/7"), ENV())).status).toBe(401);
});

test("错密钥 → 401", async () => {
  expect((await handleSubRead(get("/sub/7", { "x-sub-secret": "wrong" }), ENV())).status).toBe(401);
});

test("路径非法（非数字）→ 400", async () => {
  expect((await handleSubRead(get("/sub/abc", { "x-sub-secret": "S3CRET" }), ENV())).status).toBe(400);
});

test("正确密钥 + 命中 → 200 + email", async () => {
  const res = await handleSubRead(get("/sub/7", { "x-sub-secret": "S3CRET" }), ENV());
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, email: "alice@gmail.com" });
});

test("正确密钥 + 未命中 → 404", async () => {
  expect((await handleSubRead(get("/sub/999", { "x-sub-secret": "S3CRET" }), ENV())).status).toBe(404);
});
