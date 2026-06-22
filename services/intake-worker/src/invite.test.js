import { test, expect } from "bun:test";
import { genToken, mintInvite, emailForToken, listPeople, revoke, rotate, inviteKey, allowKey } from "./invite.js";

function fakeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    store: m,
    async get(k){ return m.has(k) ? m.get(k) : null; },
    async put(k, v){ m.set(k, v); },
    async delete(k){ m.delete(k); },
    async list({ prefix } = {}){
      const keys = [...m.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: "" };
    },
  };
}
const seq = (...vals) => { let i = 0; return () => vals[i++]; };

test("genToken：32 位十六进制", () => {
  const t = genToken((arr) => { for (let i=0;i<arr.length;i++) arr[i] = i; return arr; });
  expect(t).toMatch(/^[0-9a-f]{32}$/);
});

test("mintInvite：写双向键，返回 token；emailForToken 反查得邮箱", async () => {
  const kv = fakeKV();
  const r = await mintInvite(kv, "bob@x.com", { now: () => 1000, gen: () => "TOK1" });
  expect(r).toEqual({ email: "bob@x.com", token: "TOK1", addedAt: 1000 });
  expect(await kv.get(inviteKey("TOK1"))).toBe("bob@x.com");
  expect(JSON.parse(await kv.get(allowKey("bob@x.com")))).toEqual({ token: "TOK1", addedAt: 1000 });
  expect(await emailForToken(kv, "TOK1")).toBe("bob@x.com");
});

test("mintInvite 幂等：同邮箱再 mint 复用原 token", async () => {
  const kv = fakeKV();
  await mintInvite(kv, "bob@x.com", { now: () => 1, gen: seq("TOK1", "TOK2") });
  const again = await mintInvite(kv, "bob@x.com", { now: () => 2, gen: seq("TOK3") });
  expect(again.token).toBe("TOK1"); // 不新建
});

test("emailForToken：未知 token → null", async () => {
  expect(await emailForToken(fakeKV(), "nope")).toBeNull();
});

test("listPeople：列出全部授权人", async () => {
  const kv = fakeKV();
  await mintInvite(kv, "a@x.com", { now: () => 1, gen: () => "TA" });
  await mintInvite(kv, "b@x.com", { now: () => 2, gen: () => "TB" });
  const people = await listPeople(kv);
  expect(people).toEqual(expect.arrayContaining([
    { email: "a@x.com", token: "TA", addedAt: 1 },
    { email: "b@x.com", token: "TB", addedAt: 2 },
  ]));
  expect(people.length).toBe(2);
});

test("revoke：删双向键，token 失效；不存在返回 false", async () => {
  const kv = fakeKV();
  await mintInvite(kv, "a@x.com", { now: () => 1, gen: () => "TA" });
  expect(await revoke(kv, "a@x.com")).toBe(true);
  expect(await emailForToken(kv, "TA")).toBeNull();
  expect(await kv.get(allowKey("a@x.com"))).toBeNull();
  expect(await revoke(kv, "ghost@x.com")).toBe(false);
});

test("rotate：旧 token 失效、发新 token、邮箱不变", async () => {
  const kv = fakeKV();
  await mintInvite(kv, "a@x.com", { now: () => 1, gen: () => "OLD" });
  const r = await rotate(kv, "a@x.com", { now: () => 9, gen: () => "NEW" });
  expect(r).toEqual({ email: "a@x.com", token: "NEW", addedAt: 9 });
  expect(await emailForToken(kv, "OLD")).toBeNull();
  expect(await emailForToken(kv, "NEW")).toBe("a@x.com");
});

test("含 : 的邮箱不污染键", async () => {
  const kv = fakeKV();
  await mintInvite(kv, "wei:rd@x.com", { now: () => 1, gen: () => "T" });
  expect(await kv.get(allowKey("wei:rd@x.com"))).toBeTruthy();
});
