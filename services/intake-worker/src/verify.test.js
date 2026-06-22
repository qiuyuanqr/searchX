import { test, expect } from "bun:test";
import { handleVerify } from "./verify.js";
import { mintInvite } from "./invite.js";

function fakeKV(){ const m=new Map(); return { store:m, async get(k){return m.has(k)?m.get(k):null;}, async put(k,v){m.set(k,v);}, async delete(k){m.delete(k);} }; }
const ENV = (kv) => ({ ALLOWED_ORIGIN: "https://qiuyuanqr.github.io", INTAKE_KV: kv });
const get = (q) => new Request(`https://w.dev/verify${q}`, { method: "GET" });

test("有效 token → ok + 打码邮箱（不泄露完整邮箱）", async () => {
  const kv = fakeKV();
  await mintInvite(kv, "bob@gmail.com", { gen: () => "TOK" });
  const r = await handleVerify(get("?k=TOK"), ENV(kv));
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.ok).toBe(true);
  expect(j.email).toBe("b***@gmail.com");
  expect(JSON.stringify(j)).not.toContain("bob@gmail.com");
});

test("无效 token → ok:false", async () => {
  const r = await handleVerify(get("?k=nope"), ENV(fakeKV()));
  expect((await r.json()).ok).toBe(false);
});

test("缺 k → ok:false", async () => {
  const r = await handleVerify(get(""), ENV(fakeKV()));
  expect((await r.json()).ok).toBe(false);
});
