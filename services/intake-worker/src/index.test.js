// services/intake-worker/src/index.test.js
// 覆盖 audit-2026-07-04 [25]：浏览器端点鉴权前的 KV 读若抛错（KV 抖动），不该穿透成裸
// Cloudflare 1101 错误页（无 CORS 头）——fetch() 最外层兜底需统一回带 CORS 的结构化 500。
import { test, expect } from "bun:test";
import worker from "./index.js";

const ENV = (kv) => ({
  ALLOWED_ORIGIN: "https://qiuyuanqr.github.io",
  GITHUB_TOKEN: "GT",
  GITHUB_OWNER: "qiuyuanqr",
  GITHUB_REPO: "searchX",
  AUTHOR_LOGIN: "qiuyuanqr",
  INTAKE_KV: kv,
});

function throwingKV() {
  return {
    async get() { throw new Error("kv jitter"); },
    async put() { throw new Error("kv jitter"); },
    async delete() { throw new Error("kv jitter"); },
    async list() { throw new Error("kv jitter"); },
  };
}

test("/verify 鉴权前 KV 读抛错 → 兜底结构化 500 + CORS 头（不裸抛 1101）", async () => {
  const req = new Request("https://w.dev/verify?k=TOK", { method: "GET" });
  const res = await worker.fetch(req, ENV(throwingKV()));
  expect(res.status).toBe(500);
  expect(res.headers.get("access-control-allow-origin")).toBe("https://qiuyuanqr.github.io");
  expect((await res.json())).toEqual({ ok: false, error: "internal" });
});

test("POST /check 鉴权前 KV 读（限频计数）抛错 → 兜底结构化 500 + CORS 头", async () => {
  const req = new Request("https://w.dev/check", {
    method: "POST",
    headers: { "content-type": "application/json", "x-check-key": "K" },
    body: JSON.stringify({ text: "x" }),
  });
  const res = await worker.fetch(req, ENV(throwingKV()));
  expect(res.status).toBe(500);
  expect(res.headers.get("access-control-allow-origin")).toBe("https://qiuyuanqr.github.io");
  expect((await res.json())).toEqual({ ok: false, error: "internal" });
});

test("GET /check/recent 鉴权前 KV 读抛错 → 兜底结构化 500 + CORS 头", async () => {
  const req = new Request("https://w.dev/check/recent", {
    method: "GET",
    headers: { "x-check-key": "K" },
  });
  const res = await worker.fetch(req, ENV(throwingKV()));
  expect(res.status).toBe(500);
  expect(res.headers.get("access-control-allow-origin")).toBe("https://qiuyuanqr.github.io");
});

test("/admin/list 鉴权前 KV 读（失败限流计数）抛错 → 兜底结构化 500 + CORS 头", async () => {
  const req = new Request("https://w.dev/admin/list", {
    method: "GET",
    headers: { "x-admin-key": "K" },
  });
  const res = await worker.fetch(req, ENV(throwingKV()));
  expect(res.status).toBe(500);
  expect(res.headers.get("access-control-allow-origin")).toBe("https://qiuyuanqr.github.io");
});

test("/verify 正常路径不受影响：无 token → { ok: false }，200", async () => {
  const kv = { async get() { return null; } };
  const req = new Request("https://w.dev/verify?k=BAD", { method: "GET" });
  const res = await worker.fetch(req, ENV(kv));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: false });
});

test("未知路径落到 handleIntake：非 POST → 405（路由本身照常工作）", async () => {
  const req = new Request("https://w.dev/", { method: "GET" });
  const res = await worker.fetch(req, ENV(throwingKV()));
  expect(res.status).toBe(405);
});
