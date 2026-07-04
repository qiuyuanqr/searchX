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

test("KV 坏数据：listPeople 跳过损坏条目、不抛", async () => {
  const kv = fakeKV();
  await mintInvite(kv, "good@x.com", { now: () => 1, gen: () => "TG" });
  kv.store.set(allowKey("bad@x.com"), "{not json");     // 损坏
  const people = await listPeople(kv);
  expect(people).toEqual([{ email: "good@x.com", token: "TG", addedAt: 1 }]);
});

test("KV 坏数据：mintInvite 对损坏记录自愈重铸、不抛", async () => {
  const kv = fakeKV();
  kv.store.set(allowKey("a@x.com"), "garbage");
  const r = await mintInvite(kv, "a@x.com", { now: () => 9, gen: () => "NEW" });
  expect(r).toEqual({ email: "a@x.com", token: "NEW", addedAt: 9 });
  expect(await emailForToken(kv, "NEW")).toBe("a@x.com");
});

test("KV 坏数据：revoke 清掉损坏的 allow 记录、不抛", async () => {
  const kv = fakeKV();
  kv.store.set(allowKey("a@x.com"), "garbage");
  expect(await revoke(kv, "a@x.com")).toBe(true);
  expect(await kv.get(allowKey("a@x.com"))).toBeNull();
});

test("revoke 穷尽清理：allow 记录之外的孤儿 invite token 也被一并删除（撤销彻底）", async () => {
  // 场景：重复 mint / 半写留下孤儿 T1（有效但不被 allow 追踪），allow 只记着 T2
  const kv = fakeKV({
    [inviteKey("T1")]: "bob@x.com",   // 孤儿：listPeople 看不见、按记录删够不着
    [inviteKey("T2")]: "bob@x.com",
    [allowKey("bob@x.com")]: JSON.stringify({ token: "T2", addedAt: 1 }),
    [inviteKey("T9")]: "carol@y.com", // 别人的 token 不许误删
  });
  expect(await revoke(kv, "bob@x.com")).toBe(true);
  expect(await kv.get(inviteKey("T1"))).toBe(null);  // 孤儿也被清掉
  expect(await kv.get(inviteKey("T2"))).toBe(null);
  expect(await kv.get(allowKey("bob@x.com"))).toBe(null);
  expect(await kv.get(inviteKey("T9"))).toBe("carol@y.com"); // 无关授权原样保留
});

test("mintInvite 写序：先 allow（追踪键）后 invite（生效键）——半写只会留下可自愈的追踪记录", async () => {
  // invite 写入抛错（模拟 KV 抖动）：allow 已写入 → 重试 mint 命中记录、自愈补写 invite 键
  const kv = fakeKV();
  const rawPut = kv.put.bind(kv);
  let failInvite = true;
  kv.put = async (k, v) => {
    if (failInvite && k.startsWith("invite:")) throw new Error("KV put 瞬时失败");
    return rawPut(k, v);
  };
  await expect(mintInvite(kv, "bob@x.com", { now: () => 1, gen: () => "TOK1" })).rejects.toThrow("KV put 瞬时失败");
  expect(await kv.get(inviteKey("TOK1"))).toBe(null);            // 生效键没写成 → token 不可用（不是幽灵授权）
  expect(await kv.get(allowKey("bob@x.com"))).not.toBe(null);    // 但已被追踪
  failInvite = false;
  const again = await mintInvite(kv, "bob@x.com", { now: () => 2, gen: () => "TOK2" });
  expect(again.token).toBe("TOK1");                              // 重试复用被追踪的 token
  expect(await kv.get(inviteKey("TOK1"))).toBe("bob@x.com");     // 自愈补写完成，链接恢复可用
});
