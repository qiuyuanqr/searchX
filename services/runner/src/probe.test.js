// 守卫 probe.js 的分类与统计口径。
// **不造真实网络故障**：真并发 / 真连接失败的测试本机绿、CI 必挂（2026-08-20 教训），
// 这里一律用构造出来的错误对象与文本喂纯函数。
import { test, expect } from "bun:test";
import {
  classifyFetchError, probeLogLine, rollLines, summarizeProbeLog, PROBE_LOG_MAX_LINES,
} from "./probe.js";

test("超时归 timeout（AbortSignal.timeout 抛的是 TimeoutError）", () => {
  expect(classifyFetchError(Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }))).toBe("timeout");
  expect(classifyFetchError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe("timeout");
});

test("TLS 握手失败单列一类——这是墙内 SNI 阻断的特征，不能和普通超时混在一起", () => {
  expect(classifyFetchError(new Error("SSL_ERROR_SYSCALL in connection to qiuyuanqr.github.io:443"))).toBe("tls");
  expect(classifyFetchError(new Error("TLS handshake failed"))).toBe("tls");
});

// 下面这些 code 是 2026-08-31 在本机 Bun 上**实测**抓到的真实形态，不是照 Node 抄的。
// 第一版夹具用 `code: "ECONNREFUSED"` 写得漂漂亮亮，真跑一次却记成了 other——
// 「夹具绿不等于真实数据对」（CLAUDE.md）在这条上原样应验了一次。
test("Bun 真实错误形态：拒绝连接 / 证书 / 连接被断", () => {
  expect(classifyFetchError(Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" }))).toBe("refused");
  expect(classifyFetchError(Object.assign(new Error("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }))).toBe("tls");
  expect(classifyFetchError(Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }))).toBe("tls");
  expect(classifyFetchError(Object.assign(new Error("connection closed"), { code: "ConnectionClosed" }))).toBe("reset");
});

test("Node 风格的错误码也认（换运行时 / 换 fetch 实现不至于全掉进兜底）", () => {
  expect(classifyFetchError(Object.assign(new Error("x"), { code: "ENOTFOUND" }))).toBe("dns");
  expect(classifyFetchError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe("refused");
  expect(classifyFetchError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe("reset");
});

// 兜底必须保留原始 code：运行时升级冒出的新形态记成 other 就等于把信息扔了，
// 而这份历史唯一的用途就是事后判读。
test("认不出的 code 原样保留，不塌成 other", () => {
  expect(classifyFetchError(Object.assign(new Error("x"), { code: "SomeNewBunError" }))).toBe("SomeNewBunError");
});

// 守卫：标签之间不能互相吃掉。tls 的判据同时看 code 与文案，排在 reset 前面，
// 所以「握手中被 reset」这种两边都沾的错误落进 tls——这正是想要的：墙内阻断打断握手
// 就长这样，归到 tls 才能和「对端真的挂了」区分开。这里把取舍钉死，防止后来有人
// 调换顺序、让它悄悄变成 reset。
test("守卫：握手期间被断归 tls，不被 reset 抢走", () => {
  const e = Object.assign(new Error("connection reset during SSL handshake"), { code: "ECONNRESET" });
  expect(classifyFetchError(e)).toBe("tls");
});

test("cause 里的 code / message 也认（fetch 常把底层错误塞进 cause）", () => {
  const e = new Error("fetch failed");
  e.cause = { code: "ECONNREFUSED", message: "connect ECONNREFUSED" };
  expect(classifyFetchError(e)).toBe("refused");
});

test("认不出来的记 other / unknown，不抛", () => {
  expect(classifyFetchError(new Error("something weird"))).toBe("other");
  expect(classifyFetchError(null)).toBe("unknown");
});

test("rollLines 只保留最近 max 行", () => {
  const existing = Array.from({ length: 5 }, (_, i) => `L${i}`).join("\n");
  const out = rollLines(existing, "NEW", 3).split("\n").filter(Boolean);
  expect(out).toEqual(["L3", "L4", "NEW"]);
});

test("rollLines 从空文件起步也正常（首次探活）", () => {
  expect(rollLines("", "FIRST", 10)).toBe("FIRST\n");
});

test("默认上限够攒半个月（每 5 分钟一 tick）", () => {
  expect(PROBE_LOG_MAX_LINES / (24 * 12)).toBeGreaterThan(14);
});

test("summarizeProbeLog 算成功率与失败类型分布", () => {
  const text = [
    probeLogLine({ at: "2026-08-30T00:00:00Z", results: { site: "ok", primary: "ok" } }),
    probeLogLine({ at: "2026-08-30T00:05:00Z", results: { site: "timeout", primary: "ok" } }),
    probeLogLine({ at: "2026-08-30T00:10:00Z", results: { site: "tls", primary: "ok" } }),
    probeLogLine({ at: "2026-08-30T00:15:00Z", results: { site: "ok", primary: "ok" } }),
  ].join("\n");
  const s = summarizeProbeLog(text);
  expect(s.rows).toBe(4);
  expect(s.targets.site.total).toBe(4);
  expect(s.targets.site.ok).toBe(2);
  expect(s.targets.site.failRate).toBe(0.5);
  expect(s.targets.site.reasons).toEqual({ timeout: 1, tls: 1 });
  expect(s.targets.primary.failRate).toBe(0);
});

// 守卫：写盘中途断电 / 人手改坏一行，不能让整份统计炸掉或悄悄归零。
test("守卫：坏行跳过，其余照常统计", () => {
  const text = ['{"t":"2026-08-30T00:00:00Z","site":"ok"}', "{截断的坏行", "", '{"t":"2026-08-30T00:05:00Z","site":"tls"}'].join("\n");
  const s = summarizeProbeLog(text);
  expect(s.rows).toBe(2);
  expect(s.targets.site.reasons).toEqual({ tls: 1 });
});

test("since 只统计指定时间之后的行", () => {
  const text = [
    probeLogLine({ at: "2026-08-29T00:00:00Z", results: { site: "tls" } }),
    probeLogLine({ at: "2026-08-30T00:00:00Z", results: { site: "ok" } }),
  ].join("\n");
  expect(summarizeProbeLog(text, { since: "2026-08-30" }).rows).toBe(1);
  expect(summarizeProbeLog(text, { since: "2026-08-30" }).targets.site.failRate).toBe(0);
});
