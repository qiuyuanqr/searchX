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
