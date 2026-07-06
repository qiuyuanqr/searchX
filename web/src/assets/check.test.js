import { test, expect } from "bun:test";
import {
  readKey,
  saveKey,
  clearKey,
  keyFromHash,
  describeCheckResult,
  describeSubmitError,
  describeRecentError,
  submitTimeoutMs,
  fitDimensions,
  validateCheckSubmission,
  describeTaskStatus,
  formatTaskTime,
  formatClockTime,
  shouldKeepPolling,
  parseFrontmatter,
  verdictTone,
  resultChips,
  describeResultError,
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

// --- keyFromHash（免密专属链接 #k=<key>）---

test("keyFromHash：#k=<key> → 取出密钥", () => {
  expect(keyFromHash("#k=abc123")).toBe("abc123");
});

test("keyFromHash：URL 编码与首尾空白被规整", () => {
  expect(keyFromHash("#k=%20abc%20")).toBe("abc");   // 编码的空格解码后被 trim
  expect(keyFromHash("#k=a%2Bb")).toBe("a+b");        // 编码字符正常解码
});

test("keyFromHash：非法 URL 编码不崩，按原文返回", () => {
  expect(keyFromHash("#k=a%zz")).toBe("a%zz");
});

test("keyFromHash：无 hash / 其它 hash / 空值 → 空串", () => {
  expect(keyFromHash("")).toBe("");
  expect(keyFromHash(undefined)).toBe("");
  expect(keyFromHash("#recent")).toBe("");
  expect(keyFromHash("#k=")).toBe("");
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

// --- submitTimeoutMs（提交超时：带图上传慢，给更长限时）---

test("submitTimeoutMs：无图 → 30 秒", () => {
  expect(submitTimeoutMs(0)).toBe(30000);
});

test("submitTimeoutMs：带图 → 120 秒（慢网上传大图不至于被误杀）", () => {
  expect(submitTimeoutMs(1)).toBe(120000);
  expect(submitTimeoutMs(9)).toBe(120000);
});

// --- describeSubmitError（提交异常 → 人话：超时给"换网络"指引，其余按一般网络错误）---

test("describeSubmitError：TimeoutError → error，提示网络不通、换网络重试", () => {
  const r = describeSubmitError(new DOMException("timed out", "TimeoutError"));
  expect(r.kind).toBe("error");
  expect(r.text).toContain("超时");
  expect(r.text).toContain("换");
});

test("describeSubmitError：AbortError（旧浏览器超时兜底）→ 同超时文案", () => {
  const r = describeSubmitError(new DOMException("aborted", "AbortError"));
  expect(r.kind).toBe("error");
  expect(r.text).toContain("超时");
});

test("describeSubmitError：普通网络错误 → error，通用重试文案", () => {
  const r = describeSubmitError(new TypeError("Failed to fetch"));
  expect(r.kind).toBe("error");
  expect(r.text).toContain("网络错误");
});

test("describeSubmitError：退化输入（undefined）→ 通用文案、不崩", () => {
  const r = describeSubmitError(undefined);
  expect(r.kind).toBe("error");
  expect(r.text).toContain("网络错误");
});

// --- describeRecentError（最近核查列表加载失败 → 可见提示，不再静默）---

test("describeRecentError：401 → 提示密钥失效", () => {
  expect(describeRecentError(401)).toContain("密钥");
});

test("describeRecentError：429 → 提示被限流、稍后再试", () => {
  expect(describeRecentError(429)).toContain("稍后");
});

test("describeRecentError：其它 HTTP 状态 → 带状态码、引导点刷新", () => {
  const t = describeRecentError(500);
  expect(t).toContain("500");
  expect(t).toContain("刷新");
});

test("describeRecentError：网络层失败（状态码 0 / undefined）→ 提示连不上、引导点刷新", () => {
  for (const s of [0, undefined]) {
    const t = describeRecentError(s);
    expect(t).toContain("连不上");
    expect(t).toContain("刷新");
  }
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

// --- formatClockTime（Date/ISO → 北京时间 HH:mm:ss，用于「已更新」提示）---

test("formatClockTime：UTC 时刻 → 北京时间 HH:mm:ss", () => {
  // 2026-07-02T01:30:05Z = 北京时间 09:30:05
  expect(formatClockTime(new Date("2026-07-02T01:30:05.000Z"))).toBe("09:30:05");
});

test("formatClockTime：接受 ISO 字符串输入", () => {
  expect(formatClockTime("2026-07-02T01:30:05.000Z")).toBe("09:30:05");
});

test("formatClockTime：补零到两位（个位时分秒）", () => {
  // 2026-07-01T20:03:07Z = 北京时间 04:03:07
  expect(formatClockTime("2026-07-01T20:03:07.000Z")).toBe("04:03:07");
});

test("formatClockTime：非法 / 空输入返回空串（不崩）", () => {
  expect(formatClockTime("not a date")).toBe("");
  expect(formatClockTime("")).toBe("");
  expect(formatClockTime(undefined)).toBe("");
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

// --- 结果详情：frontmatter 解析 / 裁定条 / 错误文案 ---

test("parseFrontmatter：解出 frontmatter 键值与正文", () => {
  const md = "---\nverdict: 误导\nconfidence: 高\n---\n## 真相直述\n内容";
  const { frontmatter, body } = parseFrontmatter(md);
  expect(frontmatter.verdict).toBe("误导");
  expect(frontmatter.confidence).toBe("高");
  expect(body).toBe("## 真相直述\n内容");
});
test("parseFrontmatter：无 frontmatter → 原文即 body", () => {
  const { frontmatter, body } = parseFrontmatter("## 直接正文");
  expect(frontmatter).toEqual({});
  expect(body).toBe("## 直接正文");
});
test("parseFrontmatter：去掉值两侧引号", () => {
  const { frontmatter } = parseFrontmatter('---\nverdict: "属实"\n---\n正文');
  expect(frontmatter.verdict).toBe("属实");
});
test("verdictTone：六档映射到色调", () => {
  expect(verdictTone("属实")).toBe("true");
  expect(verdictTone("大体属实")).toBe("true");
  expect(verdictTone("半真")).toBe("mixed");
  expect(verdictTone("误导")).toBe("mixed");
  expect(verdictTone("不实")).toBe("false");
  expect(verdictTone("无法证实")).toBe("unknown");
  expect(verdictTone("")).toBe("unknown");
});
test("resultChips：裁定带把握度着色，可信度 / 来源数 / 输入类型中性", () => {
  const chips = resultChips({ verdict: "不实", confidence: "高", source_credibility: "中", source_count: "5", input_type: "图片" });
  expect(chips[0]).toEqual({ label: "裁定：不实（高）", tone: "false" });
  expect(chips.some((c) => c.label === "来源可信度：中" && c.tone === "neutral")).toBe(true);
  expect(chips.some((c) => c.label === "5 个来源")).toBe(true);
  expect(chips.some((c) => c.label === "图片")).toBe(true);
});
test("resultChips：缺字段则不产出对应 chip", () => {
  expect(resultChips({})).toEqual([]);
});
test("describeResultError：404 提示去 Obsidian、401 提示重输、0 提示连不上", () => {
  expect(describeResultError(404)).toContain("Obsidian");
  expect(describeResultError(401)).toContain("失效");
  expect(describeResultError(0)).toContain("连不上");
});
