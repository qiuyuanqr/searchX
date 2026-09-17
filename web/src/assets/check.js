// web/src/assets/check.js — 事实核查提交页的纯逻辑（构造载荷 / 密钥读写 / 状态文案）。
// DOM 引导在 check-page.js；本文件只导出纯函数，可直接单测，不依赖 DOM / 全局。

// 纯函数：从传入的 storage 读密钥（key 名固定）。调用方注入 localStorage（持久免登）或单测 fake。
export function readKey(storage) {
  try { return storage.getItem("searchx_check_key") || ""; } catch { return ""; }
}

// 纯函数：把密钥写入传入的 storage。
export function saveKey(storage, key) {
  try { storage.setItem("searchx_check_key", key); } catch {}
}

// 纯函数：清除密钥。
export function clearKey(storage) {
  try { storage.removeItem("searchx_check_key"); } catch {}
}

// 纯函数：从 URL hash 提取免密专属链接携带的密钥（形如 "#k=<key>"）。非该形式返回空串。
// 密钥放 fragment 而非 query：fragment 永远不随 HTTP 请求发出，不进 Pages 访问日志。
export function keyFromHash(hash) {
  const m = /^#k=(.+)$/.exec(hash || "");
  if (!m) return "";
  let raw = m[1];
  try { raw = decodeURIComponent(raw); } catch {}
  return raw.trim();
}

// 纯函数：把服务端状态码映射成给用户看的中文。
// 注：401（密钥失效）在 check-page.js 提前专门处理（清密钥、退回密钥闸），不会走到这里。
export function describeCheckResult(ok) {
  if (ok) return { kind: "success", text: "已提交。通常 5–10 分钟出结果，下方「最近核查」会显示进度。" };
  return { kind: "error", text: "提交失败，请稍后重试。" };
}

// 纯函数：提交 fetch 的超时毫秒数。带图片时上传量大（慢网可达数十 MB 分钟级），给更长限时，
// 避免"网络慢但能通"的提交被误杀；纯文字/链接的请求本应秒回，30 秒足够判死。
export function submitTimeoutMs(imageCount) {
  return (imageCount || 0) > 0 ? 120000 : 30000;
}

// 纯函数：把提交阶段抛出的异常映射成给用户看的中文。
// 超时（TimeoutError；AbortError 是旧浏览器超时兜底的中断名）单独给文案——这类多半是
// 当前网络到核查服务不通（如运营商屏蔽），指引换网络比笼统"重试"有用。
export function describeSubmitError(err) {
  const name = (err && err.name) || "";
  if (name === "TimeoutError" || name === "AbortError") {
    return { kind: "error", text: "提交超时：当前网络似乎连不上核查服务，请换个网络（如切流量/开代理）再试。" };
  }
  return { kind: "error", text: "网络错误，请检查连接后重试。" };
}

// 纯函数：最近核查列表加载失败 → 给用户看的一行提示（渲染进列表区，不再静默）。
// status 是 HTTP 状态码；0 / undefined 表示网络层失败（超时、不可达）。
export function describeRecentError(status) {
  if (status === 401) return "密钥已失效，请点「退出」后重新输入。";
  if (status === 429) return "请求过于频繁被暂时限流，请稍后再试。";
  if (status) return `列表加载失败（HTTP ${status}），可点「刷新」重试。`;
  return "连不上核查服务（网络不通或被屏蔽），可点「刷新」重试。";
}

// 纯函数：按长边等比缩放尺寸。长边 ≤ maxEdge 原样返回（不放大），否则缩到长边 = maxEdge。
// 保字迹优先：截图只在确实过大时才缩，给模型读图留余量。退化输入（0）原样返回、不崩。
export function fitDimensions(w, h, maxEdge) {
  const W = Math.max(0, Math.round(w || 0));
  const H = Math.max(0, Math.round(h || 0));
  if (!W || !H) return { width: W, height: H };
  const longest = Math.max(W, H);
  if (longest <= maxEdge) return { width: W, height: H };
  const scale = maxEdge / longest;
  return { width: Math.round(W * scale), height: Math.round(H * scale) };
}

// 纯函数：最近核查列表那行标题——核查完成后回传的内容标题（title）优先；没有则退回提交时
// 生成的摘要（textSnippet：文本前段 / 链接域名 / N 张图）；再没有才退到占位文案。
// pending / 旧任务没有 title 属正常，此时走 snippet（对齐「过程中先用旧摘要顶着」的设计）。
export function taskTitle(t) {
  const x = t || {};
  const title = (x.title == null ? "" : String(x.title)).trim();
  if (title) return title;
  const snip = (x.textSnippet == null ? "" : String(x.textSnippet)).trim();
  if (snip) return snip;
  return "（无摘要）";
}

// 纯函数：ISO 时间 → 北京时间 "MM-DD HH:mm" 显示；非法输入返回空串。
export function formatTaskTime(iso) {
  const d = new Date(iso || "");
  if (isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || "";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

// 纯函数：Date 或 ISO → 北京时间时钟 "HH:mm:ss"，用于手动刷新后的「已更新 <时刻>」提示。
// 秒级（比列表里的分钟级更细）：这样即便两次刷新在同一分钟内、且列表内容没变，时刻也每次都变，
// 用户据此确信「刷新真的发生过」。非法 / 空输入返回空串（调用方退化为只显示「已更新」）。
export function formatClockTime(input) {
  const d = input instanceof Date ? input : new Date(input || "");
  if (isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || "";
  return `${get("hour")}:${get("minute")}:${get("second")}`;
}

// 纯函数：列表里还有排队中的任务才继续轮询，全部终态即停。
export function shouldKeepPolling(tasks) {
  return Array.isArray(tasks) && tasks.some((t) => t && t.status === "pending");
}

// 纯函数：校验提交是否可发。图片 / 文字 / 链接至少一项；并各自限长 / 限张。返回 { ok, reason }。
export function validateCheckSubmission({ text, link, imageCount } = {}) {
  const t = (text == null ? "" : String(text)).trim();
  const l = (link == null ? "" : String(link)).trim();
  const n = imageCount || 0;
  if (!t && !l && !n) return { ok: false, reason: "图片、文字、链接至少填一项。" };
  if (t.length > 4000) return { ok: false, reason: "核查内容过长（上限 4000 字）。" };
  if (l.length > 1000) return { ok: false, reason: "链接过长。" };
  if (n > 9) return { ok: false, reason: "最多 9 张图片。" };
  return { ok: true, reason: "" };
}

// 纯函数：解析笔记开头的 YAML frontmatter（--- 包裹），返回 { frontmatter, body }。
// 只解标量键值（verdict/confidence/... 都是标量）；数组类（tags/related）跳过不用。
// 无 frontmatter 时 frontmatter={}、body 为原文。
export function parseFrontmatter(md) {
  const s = String(md == null ? "" : md).replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(s);
  if (!m) return { frontmatter: {}, body: s };
  const frontmatter = {};
  for (const line of m[1].split("\n")) {
    const mm = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!mm) continue;
    let v = mm[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    frontmatter[mm[1]] = v;
  }
  return { frontmatter, body: s.slice(m[0].length) };
}

// 七档裁定（六档真假 + 解答型）。顺序无意义，只做识别。
export const VERDICTS = ["属实", "大体属实", "半真", "误导", "不实", "无法证实", "解答"];

// 纯函数：裁定 → 着色键（true 属实系 / mixed 半真误导 / false 不实 / unknown 无法证实 / answer 解答）。
// 未知字样一律 unknown（灰），绝不猜。
export function verdictTone(verdict) {
  const v = String(verdict || "").trim();
  if (v === "属实" || v === "大体属实") return "true";
  if (v === "半真" || v === "误导") return "mixed";
  if (v === "不实") return "false";
  if (v === "解答") return "answer";
  return "unknown";
}

// 纯函数：裁定 → 徽章前的记号（与 SKILL 六档表一致；解答用 💬）。未知 → 空串。
export function verdictMark(verdict) {
  const v = String(verdict || "").trim();
  return { "属实": "✅", "大体属实": "🟢", "半真": "🟡", "误导": "🟠", "不实": "🔴", "无法证实": "⚫", "解答": "💬" }[v] || "";
}

// 纯函数：解析一行结论「裁定（把握度）：一句话真相」→ { verdict, confidence, text }。
// 容忍全角 / 半角括号与冒号、把握度缺失、前后空白；对不上格式返回 null（调用方按"已完成 + 原文"降级）。
export function parseSummary(summary) {
  const s = String(summary == null ? "" : summary).trim();
  if (!s) return null;
  const m = /^(属实|大体属实|半真|误导|不实|无法证实|解答)\s*(?:[（(]\s*(高|中|低)\s*[）)])?\s*[：:]\s*([\s\S]*)$/.exec(s);
  if (!m) return null;
  return { verdict: m[1], confidence: m[2] || "", text: m[3].trim() };
}

// 「核查中」的有效窗口：startedAt 早于此值仍是 pending，多半是上一轮 runner 中途崩了、等下一轮重取，
// 显示成「核查中 · 已 90 分钟」会误导，退回「排队中」。claude 硬超时 30 分钟，45 分钟留足余量。
export const RUNNING_STALE_MS = 45 * 60 * 1000;

// 纯函数：一条任务 → 列表徽章与结论行。
// 返回 { label, tone, text }：label 徽章文字；tone 着色键（pending / running / failed / true / mixed /
// false / unknown / answer / done）；text 徽章下那行（结论去掉「裁定（把握度）：」前缀，或失败原因）。
export function describeTask(t, nowMs = Date.now()) {
  const x = t || {};
  if (x.status === "pending") {
    const started = Date.parse(x.startedAt || "");
    if (!isNaN(started) && nowMs - started >= 0 && nowMs - started < RUNNING_STALE_MS) {
      const min = Math.floor((nowMs - started) / 60000);
      return { label: min < 1 ? "核查中 · 刚开始" : `核查中 · 已 ${min} 分钟`, tone: "running", text: "" };
    }
    return { label: x.retries ? "重试排队中" : "排队中", tone: "pending", text: "" };
  }
  if (x.status === "failed") {
    return { label: "失败 · 已停止重试", tone: "failed", text: String(x.summary || "").trim() };
  }
  if (x.status === "done") {
    const p = parseSummary(x.summary);
    if (p) {
      const conf = p.confidence ? ` · ${p.confidence}` : "";
      return { label: `${verdictMark(p.verdict)} ${p.verdict}${conf}`.trim(), tone: verdictTone(p.verdict), text: p.text };
    }
    return { label: "已完成", tone: "done", text: String(x.summary || "").trim() };
  }
  return { label: String(x.status || "未知"), tone: "pending", text: "" };
}

// 纯函数：从输入框文本里识别链接。整段就是一个 URL → text 清空、link 取它；URL 混在文字里 →
// text 原样保留、link 取第一个。没有 URL → link 空。
export function extractLink(input) {
  const text = String(input == null ? "" : input).trim();
  const m = /https?:\/\/[^\s<>"'）)】\]]+/i.exec(text);
  if (!m) return { text, link: "" };
  const link = m[0];
  return { text: text === link ? "" : text, link };
}

// 纯函数：是不是微信公众号文章链接（提交前提示"会先尝试直抓，抓不到再补截图"）。
export function isWeixinLink(url) {
  try { return /(^|\.)mp\.weixin\.qq\.com$/i.test(new URL(String(url || "")).hostname); } catch { return false; }
}

// 纯函数：Obsidian 深链。vault 为空或 note 为空 → 空串（页面据此隐藏按钮）。
// file 参数不带 .md（Obsidian URI 约定）；vault / file 都做 URL 编码。
export function obsidianUri(vault, note) {
  const v = String(vault == null ? "" : vault).trim();
  const n = String(note == null ? "" : note).trim().replace(/\.md$/i, "");
  if (!v || !n) return "";
  return `obsidian://open?vault=${encodeURIComponent(v)}&file=${encodeURIComponent(n)}`;
}

// 纯函数：结果页裁定头卡的数据。缺 verdict 时 verdict 为空串、tone unknown（老笔记 / 字段不全也不报错）。
// summaryText 是一行结论去掉前缀的那句话（没有 summary 就空）。meta 是头卡下方的小字项。
export function resultHero(fm) {
  const f = fm || {};
  const verdict = String(f.verdict || "").trim();
  const p = parseSummary(f.summary);
  const meta = [];
  if (f.source_credibility) meta.push({ k: "来源可信度", v: String(f.source_credibility) });
  if (f.input_type) meta.push({ k: "输入", v: String(f.input_type) });
  if (f.source_count) meta.push({ k: "来源", v: `${f.source_count} 个` });
  if (f.date) meta.push({ k: "核查于", v: String(f.date) });
  return {
    verdict,
    confidence: String(f.confidence || (p ? p.confidence : "") || "").trim(),
    tone: verdictTone(verdict),
    mark: verdictMark(verdict),
    summaryText: p ? p.text : String(f.summary || "").trim(),
    meta,
  };
}

// Obsidian 库名（设置项）存 localStorage：与密钥同一套容错读写。
export function readVault(storage) {
  try { return storage.getItem("searchx_check_vault") || ""; } catch { return ""; }
}
export function saveVault(storage, vault) {
  try {
    const v = String(vault == null ? "" : vault).trim();
    if (v) storage.setItem("searchx_check_vault", v); else storage.removeItem("searchx_check_vault");
  } catch {}
}

// 纯函数：详情结果加载失败 → 给用户看的一行提示（对齐 describeRecentError 的语气）。
export function describeResultError(status) {
  if (status === 401) return "密钥已失效，请点「退出」后重新输入。";
  if (status === 429) return "请求过于频繁被暂时限流，请稍后再试。";
  if (status === 404) return "结果暂不可用（可能仍在处理、回传失败或已超 7 天），可去 Obsidian 查看。";
  if (status) return `结果加载失败（HTTP ${status}），可返回列表重试。`;
  return "连不上核查服务（网络不通或被屏蔽），可返回列表重试。";
}
