import { test, expect } from "bun:test";
import {
  readKey,
  saveKey,
  clearKey,
  describeCheckResult,
  fitDimensions,
  validateCheckSubmission,
  describeTaskStatus,
  formatTaskTime,
  shouldKeepPolling,
} from "./check.js";

// --- readKey / saveKey / clearKey ---

test("readKey / saveKey / clearKey 在 fake storage 上正常工作", () => {
  const store = new Map();
  const storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };

  expect(readKey(storage)).toBe("");       // 初始为空
  saveKey(storage, "MY_KEY");
  expect(readKey(storage)).toBe("MY_KEY"); // 存后读得到
  clearKey(storage);
  expect(readKey(storage)).toBe("");       // 清除后为空
});

// --- describeCheckResult ---

test("describeCheckResult：ok=true → success，引导到「最近核查」看进度", () => {
  const r = describeCheckResult(true);
  expect(r.kind).toBe("success");
  expect(r.text).toContain("最近核查");
});

test("describeCheckResult：ok=false → error，可重试", () => {
  const r = describeCheckResult(false);
  expect(r.kind).toBe("error");
  expect(r.text).toContain("重试");
});

// --- fitDimensions（手机端按长边缩放，保字迹优先）---

test("fitDimensions：长边 ≤ maxEdge → 原样返回", () => {
  expect(fitDimensions(1200, 800, 2000)).toEqual({ width: 1200, height: 800 });
});

test("fitDimensions：横图超限 → 等比缩到长边 = maxEdge", () => {
  expect(fitDimensions(4000, 2000, 2000)).toEqual({ width: 2000, height: 1000 });
});

test("fitDimensions：竖图超限 → 按高（长边）缩", () => {
  expect(fitDimensions(1500, 3000, 2000)).toEqual({ width: 1000, height: 2000 });
});

test("fitDimensions：退化输入（0）→ 原样、不崩", () => {
  expect(fitDimensions(0, 0, 2000)).toEqual({ width: 0, height: 0 });
});

// --- validateCheckSubmission（图片/文字/链接至少一项）---

test("validateCheckSubmission：三者全空 → not ok", () => {
  const r = validateCheckSubmission({ text: "", link: "", imageCount: 0 });
  expect(r.ok).toBe(false);
  expect(r.reason).toBeTruthy();
});

test("validateCheckSubmission：仅图片 → ok", () => {
  expect(validateCheckSubmission({ text: "", link: "", imageCount: 1 }).ok).toBe(true);
});

test("validateCheckSubmission：仅文字 → ok", () => {
  expect(validateCheckSubmission({ text: "消息", link: "", imageCount: 0 }).ok).toBe(true);
});

test("validateCheckSubmission：仅链接 → ok", () => {
  expect(validateCheckSubmission({ text: "", link: "https://x.com", imageCount: 0 }).ok).toBe(true);
});

test("validateCheckSubmission：纯空格文字 + 无图 → not ok", () => {
  expect(validateCheckSubmission({ text: "   ", link: "", imageCount: 0 }).ok).toBe(false);
});

test("validateCheckSubmission：text 超 4000 → not ok", () => {
  expect(validateCheckSubmission({ text: "a".repeat(4001), link: "", imageCount: 0 }).ok).toBe(false);
});

test("validateCheckSubmission：link 超 1000 → not ok", () => {
  expect(validateCheckSubmission({ text: "", link: "h".repeat(1001), imageCount: 0 }).ok).toBe(false);
});

test("validateCheckSubmission：图片超 9 张 → not ok", () => {
  expect(validateCheckSubmission({ text: "", link: "", imageCount: 10 }).ok).toBe(false);
});

// --- describeTaskStatus（最近核查列表的状态章）---

test("describeTaskStatus：pending → 排队中 / pending 色", () => {
  expect(describeTaskStatus("pending")).toEqual({ label: "排队中", kind: "pending" });
});

test("describeTaskStatus：done → 已完成 / success 色", () => {
  expect(describeTaskStatus("done")).toEqual({ label: "已完成", kind: "success" });
});

test("describeTaskStatus：failed → 已失败 / error 色", () => {
  expect(describeTaskStatus("failed")).toEqual({ label: "已失败", kind: "error" });
});

test("describeTaskStatus：未知状态兜底为原文 / pending 色（不崩）", () => {
  expect(describeTaskStatus("weird")).toEqual({ label: "weird", kind: "pending" });
  expect(describeTaskStatus("")).toEqual({ label: "未知", kind: "pending" });
});

// --- formatTaskTime（ISO → 北京时间 MM-DD HH:mm）---

test("formatTaskTime：UTC ISO 转北京时间显示", () => {
  // 2026-07-02T01:30:00Z = 北京时间 09:30
  expect(formatTaskTime("2026-07-02T01:30:00.000Z")).toBe("07-02 09:30");
});

test("formatTaskTime：跨日换算（UTC 深夜 = 北京次日）", () => {
  // 2026-07-01T18:05:00Z = 北京时间 07-02 02:05
  expect(formatTaskTime("2026-07-01T18:05:00.000Z")).toBe("07-02 02:05");
});

test("formatTaskTime：非法输入返回空串（不崩）", () => {
  expect(formatTaskTime("not a date")).toBe("");
  expect(formatTaskTime("")).toBe("");
  expect(formatTaskTime(undefined)).toBe("");
});

// --- shouldKeepPolling（有排队中任务才继续轮询）---

test("shouldKeepPolling：含 pending → true", () => {
  expect(shouldKeepPolling([{ status: "done" }, { status: "pending" }])).toBe(true);
});

test("shouldKeepPolling：全终态 → false", () => {
  expect(shouldKeepPolling([{ status: "done" }, { status: "failed" }])).toBe(false);
});

test("shouldKeepPolling：空列表 / 非数组 → false", () => {
  expect(shouldKeepPolling([])).toBe(false);
  expect(shouldKeepPolling(null)).toBe(false);
});
