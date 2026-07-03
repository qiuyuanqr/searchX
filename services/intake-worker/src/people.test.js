import { test, expect } from "bun:test";
import { handlePeople } from "./people.js";

// 假 KV：撑起 listPeople 需要的 list({prefix}) + get。
function fakeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    store: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    async list({ prefix }) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    },
  };
}
const ENV = (over = {}) => ({
  SUB_READ_SECRET: "S3CRET",
  INTAKE_KV: fakeKV({
    [`allow:${encodeURIComponent("alice@gmail.com")}`]: JSON.stringify({ token: "tokA", addedAt: 111 }),
    [`allow:${encodeURIComponent("9527@qq.com")}`]: JSON.stringify({ token: "tokB", addedAt: 222 }),
    "invite:tokA": "alice@gmail.com",
    "invite:tokB": "9527@qq.com",
  }),
  ...over,
});
const get = (headers = {}) => new Request("https://w.dev/people", { method: "GET", headers });

test("非 GET → 405", async () => {
  const res = await handlePeople(new Request("https://w.dev/people", { method: "POST" }), ENV());
  expect(res.status).toBe(405);
});

test("缺/错密钥 → 401；服务端未配密钥 → 一律 401", async () => {
  expect((await handlePeople(get(), ENV())).status).toBe(401);
  expect((await handlePeople(get({ "x-sub-secret": "wrong!" }), ENV())).status).toBe(401);
  expect((await handlePeople(get({ "x-sub-secret": "S3CRET" }), ENV({ SUB_READ_SECRET: "" }))).status).toBe(401);
});

test("带密钥 → 返回全部授权，邮箱打码、token/addedAt 原样", async () => {
  const res = await handlePeople(get({ "x-sub-secret": "S3CRET" }), ENV());
  expect(res.status).toBe(200);
  const j = await res.json();
  expect(j.ok).toBe(true);
  expect(j.people.length).toBe(2);
  const byToken = Object.fromEntries(j.people.map((p) => [p.token, p]));
  expect(byToken.tokA.email).toBe("a***@gmail.com"); // 打码，不泄露完整邮箱
  expect(byToken.tokB.email).toBe("9***@qq.com");
  expect(byToken.tokA.addedAt).toBe(111);
  expect(j.people.every((p) => !p.email.includes("alice"))).toBe(true);
});
