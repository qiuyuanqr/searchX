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
  taskTitle,
  formatTaskTime,
  formatClockTime,
  shouldKeepPolling,
  parseFrontmatter,
  verdictTone,
  resultHero, parseSummary, describeTask, extractLink, isWeixinLink, obsidianUri, verdictMark, readVault, saveVault, RUNNING_STALE_MS,
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

// --- taskTitle（最近核查列表那行标题：完成后内容标题优先，否则退回旧摘要）---

test("taskTitle：有 title → 用 title（替代 N 张图 / 长文本前段）", () => {
  expect(taskTitle({ title: "某公司五倍海力士说法", textSnippet: "1 张图" })).toBe("某公司五倍海力士说法");
});

test("taskTitle：无 title（pending / 旧任务）→ 退回 textSnippet", () => {
  expect(taskTitle({ textSnippet: "mp.weixin.qq.com" })).toBe("mp.weixin.qq.com");
});

test("taskTitle：title 为空白串 → 退回 textSnippet", () => {
  expect(taskTitle({ title: "   ", textSnippet: "2 张图" })).toBe("2 张图");
});

test("taskTitle：title 与 snippet 都无 → 占位文案；入参为空也不崩", () => {
  expect(taskTitle({})).toBe("（无摘要）");
  expect(taskTitle(null)).toBe("（无摘要）");
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
test("describeResultError：404 提示去 Obsidian、401 提示重输、0 提示连不上", () => {
  expect(describeResultError(404)).toContain("Obsidian");
  expect(describeResultError(401)).toContain("失效");
  expect(describeResultError(0)).toContain("连不上");
});

// --- 2026-09-17 第二批：结论解析 / 任务徽章 / 链接识别 / Obsidian 深链 / 裁定头卡 ---

test("verdictTone：解答 → answer；verdictMark 七档记号、未知为空", () => {
  expect(verdictTone("解答")).toBe("answer");
  expect(verdictMark("属实")).toBe("✅");
  expect(verdictMark("无法证实")).toBe("⚫");
  expect(verdictMark("解答")).toBe("💬");
  expect(verdictMark("随便")).toBe("");
});

test("parseSummary：标准格式、全半角括号冒号、无把握度都能解；对不上返回 null", () => {
  expect(parseSummary("不实（高）：该截图系 2023 年旧闻拼接")).toEqual({ verdict: "不实", confidence: "高", text: "该截图系 2023 年旧闻拼接" });
  expect(parseSummary("属实(中): 确有其事")).toEqual({ verdict: "属实", confidence: "中", text: "确有其事" });
  expect(parseSummary("解答：章鱼与乌鸦各擅其长")).toEqual({ verdict: "解答", confidence: "", text: "章鱼与乌鸦各擅其长" });
  expect(parseSummary("  大体属实（低）：主干成立  ")).toEqual({ verdict: "大体属实", confidence: "低", text: "主干成立" });
  // 真跑时出现过的写法：括号里把握度后面带附注 → 把握度照取，附注并进正文开头
  expect(parseSummary("大体属实（高，补证据重查维持不变）：官方说明书未列为管制药物")).toEqual({ verdict: "大体属实", confidence: "高", text: "补证据重查维持不变。官方说明书未列为管制药物" });
  expect(parseSummary("不实（把握度高）：假的")).toEqual({ verdict: "不实", confidence: "", text: "把握度高。假的" });
  expect(parseSummary("连续失败 3 次，已停止重试")).toBeNull();
  expect(parseSummary("")).toBeNull();
  expect(parseSummary(null)).toBeNull();
});

test("describeTask：pending 无 startedAt → 排队中；有 retries → 重试排队中", () => {
  expect(describeTask({ status: "pending" }, 0)).toEqual({ label: "排队中", tone: "pending", text: "" });
  expect(describeTask({ status: "pending", retries: 1 }, 0)).toEqual({ label: "重试排队中", tone: "pending", text: "" });
});

test("describeTask：pending 且 startedAt 在 45 分钟内 → 核查中 · 已 N 分钟；刚开始 <1 分钟；超窗退回排队中", () => {
  const now = Date.parse("2026-09-17T06:10:00Z");
  expect(describeTask({ status: "pending", startedAt: "2026-09-17T06:06:30Z" }, now)).toEqual({ label: "核查中 · 已 3 分钟", tone: "running", text: "" });
  expect(describeTask({ status: "pending", startedAt: "2026-09-17T06:09:40Z" }, now)).toEqual({ label: "核查中 · 刚开始", tone: "running", text: "" });
  expect(describeTask({ status: "pending", startedAt: new Date(now - RUNNING_STALE_MS).toISOString() }, now).label).toBe("排队中");
  expect(describeTask({ status: "pending", startedAt: "垃圾" }, now).label).toBe("排队中");
  // startedAt 在未来（两机时钟不一致）→ 不显示负数，退回排队中
  expect(describeTask({ status: "pending", startedAt: "2026-09-17T06:20:00Z" }, now).label).toBe("排队中");
});

test("describeTask：done 解析结论 → 徽章带记号与把握度、text 去前缀；解不出 → 已完成 + 原文", () => {
  expect(describeTask({ status: "done", summary: "不实（高）：截图系伪造" })).toEqual({ label: "🔴 不实 · 高", tone: "false", text: "截图系伪造" });
  expect(describeTask({ status: "done", summary: "解答：各有所长" })).toEqual({ label: "💬 解答", tone: "answer", text: "各有所长" });
  expect(describeTask({ status: "done", summary: "老格式的结论" })).toEqual({ label: "已完成", tone: "done", text: "老格式的结论" });
  expect(describeTask({ status: "done" })).toEqual({ label: "已完成", tone: "done", text: "" });
});

test("describeTask：failed → 失败徽章 + 原因；未知状态 / 空入参不崩", () => {
  expect(describeTask({ status: "failed", summary: "连续失败 3 次" })).toEqual({ label: "失败 · 已停止重试", tone: "failed", text: "连续失败 3 次" });
  expect(describeTask({ status: "weird" }).label).toBe("weird");
  expect(describeTask(null).label).toBe("未知");
});

test("extractLink：整段是 URL → text 清空；URL 混在文字里 → text 保留、link 取第一个；无 URL → link 空；括号 / 引号不并入", () => {
  expect(extractLink("https://mp.weixin.qq.com/s/abc")).toEqual({ text: "", link: "https://mp.weixin.qq.com/s/abc" });
  expect(extractLink("  https://e.com/a  ")).toEqual({ text: "", link: "https://e.com/a" });
  expect(extractLink("看看这个 https://e.com/a 是真的吗 http://f.com")).toEqual({ text: "看看这个 https://e.com/a 是真的吗 http://f.com", link: "https://e.com/a" });
  expect(extractLink("（链接：https://e.com/a）")).toEqual({ text: "（链接：https://e.com/a）", link: "https://e.com/a" });
  expect(extractLink("没有链接")).toEqual({ text: "没有链接", link: "" });
  expect(extractLink("")).toEqual({ text: "", link: "" });
});

test("isWeixinLink：只认 mp.weixin.qq.com 主机；非法 URL false", () => {
  expect(isWeixinLink("https://mp.weixin.qq.com/s/abc")).toBe(true);
  expect(isWeixinLink("http://MP.WEIXIN.QQ.COM/s/abc")).toBe(true);
  expect(isWeixinLink("https://weixin.qq.com/")).toBe(false);
  expect(isWeixinLink("https://evil.com/mp.weixin.qq.com")).toBe(false);
  expect(isWeixinLink("不是链接")).toBe(false);
});

test("obsidianUri：库名 + 笔记路径 → obsidian://open，去 .md、做编码；任一为空 → 空串", () => {
  expect(obsidianUri("饺子的旷野", "Factcheck/2026-09-17_deepseek发布.md")).toBe(
    "obsidian://open?vault=" + encodeURIComponent("饺子的旷野") + "&file=" + encodeURIComponent("Factcheck/2026-09-17_deepseek发布")
  );
  expect(obsidianUri("", "Factcheck/a.md")).toBe("");
  expect(obsidianUri("v", "")).toBe("");
  expect(obsidianUri(null, null)).toBe("");
});

test("resultHero：从 frontmatter 组头卡——裁定 / 把握度 / 记号 / 色调 / 一句话 / meta", () => {
  const h = resultHero({ verdict: "不实", confidence: "高", summary: "不实（高）：截图系伪造", source_credibility: "低", input_type: "图片", source_count: "4", date: "2026-07-13" });
  expect(h).toEqual({
    verdict: "不实", confidence: "高", tone: "false", mark: "🔴", summaryText: "截图系伪造",
    meta: [{ k: "来源可信度", v: "低" }, { k: "输入", v: "图片" }, { k: "来源", v: "4 个" }, { k: "核查于", v: "2026-07-13" }],
  });
});

test("resultHero：缺字段不报错——老笔记无 summary 时一句话为空、无 verdict 时 tone unknown；confidence 可从 summary 补", () => {
  expect(resultHero({})).toEqual({ verdict: "", confidence: "", tone: "unknown", mark: "", summaryText: "", meta: [] });
  expect(resultHero({ verdict: "属实", summary: "属实（中）：真" }).confidence).toBe("中");
  expect(resultHero({ verdict: "属实", summary: "老格式" }).summaryText).toBe("老格式");
});

test("readVault / saveVault：存取 Obsidian 库名，空值即删除，坏 storage 不崩", () => {
  const m = new Map();
  const st = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  expect(readVault(st)).toBe("");
  saveVault(st, "  饺子的旷野 ");
  expect(readVault(st)).toBe("饺子的旷野");
  saveVault(st, "");
  expect(readVault(st)).toBe("");
  const bad = { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); }, removeItem() { throw new Error("x"); } };
  expect(readVault(bad)).toBe("");
  saveVault(bad, "v");
});
