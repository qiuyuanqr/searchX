import { test, expect } from "bun:test";
import { handleAdmin } from "./admin.js";
import { emailForToken } from "./invite.js";

function fakeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    store: m,
    async get(k){ return m.has(k) ? m.get(k) : null; },
    async put(k, v){ m.set(k, v); },
    async delete(k){ m.delete(k); },
    async list({ prefix } = {}){ return { keys: [...m.keys()].filter((k)=>!prefix||k.startsWith(prefix)).map((name)=>({name})), list_complete: true, cursor: "" }; },
  };
}
const ENV = (over = {}) => ({ ALLOWED_ORIGIN: "https://qiuyuanqr.github.io", ADMIN_KEY: "SECRET", INTAKE_KV: fakeKV(), ...over });
const req = (method, path, { key, body } = {}) => new Request(`https://w.dev${path}`, {
  method,
  headers: { "content-type": "application/json", "cf-connecting-ip": "9.9.9.9", ...(key ? { "x-admin-key": key } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

test("无/错密钥 → 401", async () => {
  expect((await handleAdmin(req("GET", "/admin/list"), ENV())).status).toBe(401);
  expect((await handleAdmin(req("GET", "/admin/list", { key: "WRONG" }), ENV())).status).toBe(401);
});

test("add → 200 返回链接 token；list 能看到；提交侧能反查邮箱", async () => {
  const env = ENV();
  const r = await handleAdmin(req("POST", "/admin/add", { key: "SECRET", body: { email: "bob@x.com" } }), env, { now: () => 5, gen: () => "TOK" });
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j).toMatchObject({ ok: true, email: "bob@x.com", token: "TOK" });
  expect(await emailForToken(env.INTAKE_KV, "TOK")).toBe("bob@x.com");
  const list = await (await handleAdmin(req("GET", "/admin/list", { key: "SECRET" }), env)).json();
  expect(list.people).toEqual([{ email: "bob@x.com", token: "TOK", addedAt: 5 }]);
});

test("add 归一大小写：Bob@X.com 存成 bob@x.com（audit-2026-07-04 [28]）", async () => {
  const env = ENV();
  const r = await handleAdmin(req("POST", "/admin/add", { key: "SECRET", body: { email: "Bob@X.com" } }), env, { now: () => 5, gen: () => "TOK" });
  expect((await r.json())).toMatchObject({ ok: true, email: "bob@x.com" });
  const list = await (await handleAdmin(req("GET", "/admin/list", { key: "SECRET" }), env)).json();
  expect(list.people).toEqual([{ email: "bob@x.com", token: "TOK", addedAt: 5 }]);
});

test("大小写不同的同一邮箱 add 两次 → 归一后是同一条记录，非两条独立 allow", async () => {
  const env = ENV();
  await handleAdmin(req("POST", "/admin/add", { key: "SECRET", body: { email: "Bob@X.com" } }), env, { now: () => 5, gen: () => "TOK1" });
  await handleAdmin(req("POST", "/admin/add", { key: "SECRET", body: { email: "bob@x.com" } }), env, { now: () => 6, gen: () => "TOK2" });
  const list = await (await handleAdmin(req("GET", "/admin/list", { key: "SECRET" }), env)).json();
  expect(list.people.length).toBe(1); // 归一后视为同一邮箱，第二次是自愈补写而非新增
});

test("remove 用不同大小写也能命中归一后的同一条记录", async () => {
  const env = ENV();
  await handleAdmin(req("POST", "/admin/add", { key: "SECRET", body: { email: "Bob@X.com" } }), env, { gen: () => "TOK" });
  const r = await handleAdmin(req("POST", "/admin/remove", { key: "SECRET", body: { email: "BOB@X.COM" } }), env);
  expect((await r.json()).removed).toBe(true);
  expect(await emailForToken(env.INTAKE_KV, "TOK")).toBeNull();
});

test("add 非法邮箱 → 400", async () => {
  const r = await handleAdmin(req("POST", "/admin/add", { key: "SECRET", body: { email: "not-an-email" } }), ENV());
  expect(r.status).toBe(400);
});

test("remove → token 失效", async () => {
  const env = ENV();
  await handleAdmin(req("POST", "/admin/add", { key: "SECRET", body: { email: "a@x.com" } }), env, { gen: () => "TA" });
  const r = await handleAdmin(req("POST", "/admin/remove", { key: "SECRET", body: { email: "a@x.com" } }), env);
  expect(r.status).toBe(200);
  expect(await emailForToken(env.INTAKE_KV, "TA")).toBeNull();
});

test("失败限流：错密钥累计达阈值 → 429；其后正确密钥仍放行并清零计数", async () => {
  const env = ENV({ ADMIN_MAX_FAILS_PER_HOUR: "2" });
  expect((await handleAdmin(req("GET", "/admin/list", { key: "X" }), env, { now: () => 0 })).status).toBe(401); // fail 1
  expect((await handleAdmin(req("GET", "/admin/list", { key: "X" }), env, { now: () => 0 })).status).toBe(429); // fail 2 → 锁定
  expect((await handleAdmin(req("GET", "/admin/list", { key: "X" }), env, { now: () => 0 })).status).toBe(429); // 继续错 → 仍锁
  // 对密钥优先放行（不被邻居 IP 的错误尝试锁住），并清零失败计数
  expect((await handleAdmin(req("GET", "/admin/list", { key: "SECRET" }), env, { now: () => 0 })).status).toBe(200);
  expect((await handleAdmin(req("GET", "/admin/list", { key: "X" }), env, { now: () => 0 })).status).toBe(401); // 已清零 → 错一次只 401
});

test("OPTIONS 预检 → 204 + CORS", async () => {
  const r = await handleAdmin(req("OPTIONS", "/admin/list"), ENV());
  expect(r.status).toBe(204);
  expect(r.headers.get("access-control-allow-origin")).toBe("https://qiuyuanqr.github.io");
});

test("未配 ADMIN_KEY → 401（防空密钥裸奔）", async () => {
  const r = await handleAdmin(req("GET", "/admin/list", { key: "" }), ENV({ ADMIN_KEY: "" }));
  expect(r.status).toBe(401);
});

test("rotate：换新 token，旧失效", async () => {
  const env = ENV();
  await handleAdmin(req("POST", "/admin/add", { key: "SECRET", body: { email: "a@x.com" } }), env, { gen: () => "OLD" });
  const r = await handleAdmin(req("POST", "/admin/rotate", { key: "SECRET", body: { email: "a@x.com" } }), env, { now: () => 1, gen: () => "NEW" });
  expect(r.status).toBe(200);
  expect((await r.json()).token).toBe("NEW");
  expect(await emailForToken(env.INTAKE_KV, "OLD")).toBeNull();
});

test("提交 token 当 admin 密钥 → 401（凭证隔离）", async () => {
  const env = ENV();
  const add = await (await handleAdmin(req("POST", "/admin/add", { key: "SECRET", body: { email: "a@x.com" } }), env, { gen: () => "FRIENDTOK" })).json();
  const r = await handleAdmin(req("GET", "/admin/list", { key: add.token }), env);
  expect(r.status).toBe(401);
});

// ── 无鉴权写额度放大（2026-07-31 审查）────────────────────────────
// /admin/* 前面没有任何鉴权，谁都能打。老实现「先写计数、后判锁定」，锁定之后每个错密钥请求
// 仍写一次 KV——约一千个请求就能耗尽免费版每日写额度，全 Worker 的写路径瘫一整天。
test("锁定后不再写 KV：单 IP 每小时写次数封顶 maxFails", async () => {
  const env = ENV({ ADMIN_MAX_FAILS_PER_HOUR: "3" });
  let writes = 0;
  const put = env.INTAKE_KV.put.bind(env.INTAKE_KV);
  env.INTAKE_KV.put = async (...a) => { writes++; return put(...a); };
  for (let i = 0; i < 200; i++) {
    await handleAdmin(req("GET", "/admin/list", { key: "X" }), env, { now: () => 0 });
  }
  expect(writes).toBe(3); // 200 次攻击，只写了 3 次
});

test("计数值被写坏（非数字）：按 0 起算并覆盖回合法值，限流不永久失效", async () => {
  const env = ENV({ ADMIN_MAX_FAILS_PER_HOUR: "2" });
  // 先失败一次拿到真实的计数键名，再把值写坏，验证下一次能自愈
  await handleAdmin(req("GET", "/admin/list", { key: "X" }), env, { now: () => 0 });
  const failKey = [...env.INTAKE_KV.store.keys()].find((k) => k.startsWith("afail:"));
  expect(failKey).toBeTruthy();
  env.INTAKE_KV.store.set(failKey, "NaN");
  const r = await handleAdmin(req("GET", "/admin/list", { key: "X" }), env, { now: () => 0 });
  expect(r.status).toBe(401);                              // 坏值按 0 起算 → 没被误判成已锁定
  expect(env.INTAKE_KV.store.get(failKey)).toBe("1");      // 已覆盖回合法数字，可自愈
});
