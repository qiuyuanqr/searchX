import { test, expect } from "bun:test";
import { shouldAlert, composeAlert, evaluateProbe, nextStreaks, isTransientQueueError, nextQueueStreak, MIN_INTERVAL_MS, PROBE_CONFIRM_TICKS, QUEUE_FETCH_CONFIRM_TICKS } from "./alert.js";

test("shouldAlert：无历史记录（NaN/undefined）→ 发", () => {
  expect(shouldAlert(NaN, 1000)).toBe(true);
  expect(shouldAlert(undefined, 1000)).toBe(true);
});

test("shouldAlert：间隔不足 → 不发；到点 → 发（防每 5 分钟一 tick 的轰炸）", () => {
  expect(shouldAlert(0, MIN_INTERVAL_MS - 1)).toBe(false);
  expect(shouldAlert(0, MIN_INTERVAL_MS)).toBe(true);
});

test("composeAlert：收件人=作者、主题含 key、正文含详情，且只有运维信息", () => {
  const m = composeAlert({
    key: "runner-failed", detail: "定时 runner 退出码 1",
    authorEmail: "author@x.com", fromEmail: "from@x.com", when: "2026/7/3 18:00:00",
  });
  expect(m.to).toBe("author@x.com");
  expect(m.from).toBe("from@x.com");
  expect(m.subject).toContain("runner-failed");
  expect(m.text).toContain("定时 runner 退出码 1");
  expect(m.text).toContain("6 小时"); // 告知限频语义：没再收到信 ≠ 已恢复
});

test("evaluateProbe：全通 → 不报警", () => {
  const v = evaluateProbe({ siteOk: true, primaryOk: true, fallbackOk: true, site: "s", primary: "p", fallback: "f",
    streaks: { site: 0, primary: 0 } });
  expect(v.alert).toBe(false);
});

test("evaluateProbe：仅备用挂 → 不报警只留痕（workers.dev 墙内间歇阻断是已知常态）", () => {
  const v = evaluateProbe({ siteOk: true, primaryOk: true, fallbackOk: false, site: "s", primary: "p", fallback: "f",
    streaks: { site: 0, primary: 0 } });
  expect(v.alert).toBe(false);
  expect(v.detail).toContain("f");
});

test("evaluateProbe：主端点断但未达连续阈值 → 不报警只留痕（墙内分钟级瞬时抖动是已知常态）", () => {
  const v = evaluateProbe({ siteOk: true, primaryOk: false, fallbackOk: true, site: "s", primary: "p", fallback: "f",
    streaks: { site: 0, primary: 1 } });
  expect(v.alert).toBe(false);
  expect(v.detail).toContain("p");
  expect(v.detail).toContain("连续");
});

test("evaluateProbe：主端点连续达阈值 → 报警；主备全挂 → 报警并注明链路完全断", () => {
  const v = evaluateProbe({ siteOk: true, primaryOk: false, fallbackOk: true, site: "s", primary: "p", fallback: "f",
    streaks: { site: 0, primary: PROBE_CONFIRM_TICKS } });
  expect(v.alert).toBe(true);
  expect(v.detail).toContain("p");
  const all = evaluateProbe({ siteOk: true, primaryOk: false, fallbackOk: false, site: "s", primary: "p", fallback: "f",
    streaks: { site: 0, primary: PROBE_CONFIRM_TICKS } });
  expect(all.alert).toBe(true);
  expect(all.detail).toContain("完全断");
});

test("evaluateProbe：站点断同样要连续达阈值才报警（朋友打不开首页是事故，但单次抖动不是）", () => {
  const brief = evaluateProbe({ siteOk: false, primaryOk: true, fallbackOk: true, site: "https://site", primary: "p", fallback: "f",
    streaks: { site: 1, primary: 0 } });
  expect(brief.alert).toBe(false);
  const sustained = evaluateProbe({ siteOk: false, primaryOk: true, fallbackOk: true, site: "https://site", primary: "p", fallback: "f",
    streaks: { site: PROBE_CONFIRM_TICKS, primary: 0 } });
  expect(sustained.alert).toBe(true);
  expect(sustained.detail).toContain("https://site");
});

test("evaluateProbe：不传 streaks（旧调用方/状态文件读失败）→ 视为已达阈值照报，宁多报不静默", () => {
  const v = evaluateProbe({ siteOk: true, primaryOk: false, fallbackOk: true, site: "s", primary: "p", fallback: "f" });
  expect(v.alert).toBe(true);
});

test("nextStreaks：断则累加、通则清零；历史缺失/损坏从零起算", () => {
  expect(nextStreaks({}, { siteOk: false, primaryOk: false })).toEqual({ site: 1, primary: 1 });
  expect(nextStreaks({ site: 2, primary: 5 }, { siteOk: false, primaryOk: false })).toEqual({ site: 3, primary: 6 });
  expect(nextStreaks({ site: 2, primary: 5 }, { siteOk: true, primaryOk: true })).toEqual({ site: 0, primary: 0 });
  expect(nextStreaks(null, { siteOk: false, primaryOk: true })).toEqual({ site: 1, primary: 0 });
  expect(nextStreaks({ site: "垃圾", primary: -3 }, { siteOk: false, primaryOk: false })).toEqual({ site: 1, primary: 1 });
});

test("isTransientQueueError：fetch 抛错(无 status)/5xx → 瞬时防抖；4xx → 非瞬时立即报警", () => {
  // fetch 自身抛错（连接/TLS/超时）——无 HTTP 响应，无 status：墙内到 api.github.com 的分钟级瞬断
  expect(isTransientQueueError(new Error("The operation timed out."))).toBe(true);
  expect(isTransientQueueError(Object.assign(new Error("timeout"), { code: 23, name: "TimeoutError" }))).toBe(true);
  // 5xx：GitHub 服务端抽风（如 2026-07-17 返回错误页 HTML）——也是外部瞬时故障，防抖
  expect(isTransientQueueError(Object.assign(new Error("list issues failed: 503"), { status: 503 }))).toBe(true);
  expect(isTransientQueueError(Object.assign(new Error("500"), { status: 500 }))).toBe(true);
  // 4xx：配置/权限问题（401 PAT 失效、403 限流）——防抖会掩盖真问题，须立即报警
  expect(isTransientQueueError(Object.assign(new Error("401"), { status: 401 }))).toBe(false);
  expect(isTransientQueueError(Object.assign(new Error("404"), { status: 404 }))).toBe(false);
});

test("nextQueueStreak：失败累加、成功清零、历史缺失/损坏从零起算（与 nextStreaks 同语义、单目标）", () => {
  expect(nextQueueStreak(0, true)).toBe(1);
  expect(nextQueueStreak(3, true)).toBe(4);
  expect(nextQueueStreak(3, false)).toBe(0);   // 成功即清零：只有「连续」失败才累计报警
  expect(nextQueueStreak(undefined, true)).toBe(1);
  expect(nextQueueStreak(null, true)).toBe(1);
  expect(nextQueueStreak("垃圾", true)).toBe(1);
  expect(nextQueueStreak(-3, true)).toBe(1);
});

test("QUEUE_FETCH_CONFIRM_TICKS：正整数（与探活阈值同量级，约 20 分钟才判真故障）", () => {
  expect(Number.isInteger(QUEUE_FETCH_CONFIRM_TICKS)).toBe(true);
  expect(QUEUE_FETCH_CONFIRM_TICKS).toBeGreaterThanOrEqual(2);
});
