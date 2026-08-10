import { test, expect } from "bun:test";
import { buildPayload, tokenFromQuery, resolveToken, clearStoredToken, TOKEN_STORAGE_KEY, describeVerify, describeResult, escapeHtml, renderSearchResultsHTML, findReportMeta, describeExistingReport, fetchAny, renderExcerpt, tokenFromHash } from "./submit.js";

// 假 storage：Map 撑起 get/set/remove；可选 throwOn 模拟隐私模式下方法抛错。
function fakeStorage(init = {}, throwOn = new Set()) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => { if (throwOn.has("get")) throw new Error("blocked"); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { if (throwOn.has("set")) throw new Error("blocked"); m.set(k, String(v)); },
    removeItem: (k) => { if (throwOn.has("remove")) throw new Error("blocked"); m.delete(k); },
    _map: m,
  };
}

test("buildPayload 去空白、带 token、不含 email/turnstile", () => {
  const p = buildPayload(
    { title: "  比特币挖矿  ", focus: " 能耗 ", message: "" },
    "TOK"
  );
  expect(p).toEqual({
    k: "TOK",
    title: "比特币挖矿",
    focus: "能耗",
    message: "",
  });
});

test("tokenFromQuery：从 ?k= 取 token；无则空串", () => {
  expect(tokenFromQuery("?k=abc123")).toBe("abc123");
  expect(tokenFromQuery("")).toBe("");
  expect(tokenFromQuery("?x=1")).toBe("");
});

test("resolveToken：URL 有 ?k= → 返回它并写进 storage（覆盖旧值）", () => {
  const s = fakeStorage({ [TOKEN_STORAGE_KEY]: "OLD" });
  expect(resolveToken("?k=NEW", s)).toBe("NEW");
  expect(s._map.get(TOKEN_STORAGE_KEY)).toBe("NEW"); // 新链接覆盖旧 token
});

test("resolveToken：URL 无 ?k= 但 storage 有 → 回退到 storage（返回首页/刷新/主屏重开场景）", () => {
  const s = fakeStorage({ [TOKEN_STORAGE_KEY]: "SAVED" });
  expect(resolveToken("", s)).toBe("SAVED");
  expect(resolveToken("?x=1", s)).toBe("SAVED");
});

test("resolveToken：URL 无、storage 无 → 空串", () => {
  expect(resolveToken("", fakeStorage())).toBe("");
});

test("resolveToken：storage 不可用（隐私模式）也不崩", () => {
  // setItem 抛错：URL 有 token 仍照常返回（只是没存住）
  expect(resolveToken("?k=NEW", fakeStorage({}, new Set(["set"])))).toBe("NEW");
  // getItem 抛错：URL 无 token 时降级为空串，不抛
  expect(resolveToken("", fakeStorage({}, new Set(["get"])))).toBe("");
  // storage 为 null/undefined 也不崩
  expect(resolveToken("?k=NEW", null)).toBe("NEW");
  expect(resolveToken("", undefined)).toBe("");
});

test("clearStoredToken：删掉本机 token；storage 不可用也不崩", () => {
  const s = fakeStorage({ [TOKEN_STORAGE_KEY]: "X" });
  clearStoredToken(s);
  expect(s._map.has(TOKEN_STORAGE_KEY)).toBe(false);
  expect(() => clearStoredToken(fakeStorage({}, new Set(["remove"])))).not.toThrow();
  expect(() => clearStoredToken(null)).not.toThrow();
});

test("describeVerify：有效回显邮箱并授权；无效给提示且不授权", () => {
  const ok = describeVerify({ ok: true, email: "b***@x.com" });
  expect(ok.authorized).toBe(true);
  expect(ok.email).toBe("b***@x.com");
  const no = describeVerify({ ok: false });
  expect(no.authorized).toBe(false);
  expect(no.text).toContain("专属链接");
});

test("describeResult: ok=true 给成功文案", () => {
  expect(describeResult({ ok: true }).kind).toBe("success");
});

test("describeResult: 已知错误码给对应中文", () => {
  expect(describeResult({ ok: false, error: "unauthorized" }).text).toContain("专属链接");
  expect(describeResult({ ok: false, error: "email_rate_limited" }).text).toContain("提交太多");
});

test("describeResult: 未知错误给兜底文案", () => {
  expect(describeResult({ ok: false, error: "weird" }).kind).toBe("error");
  expect(describeResult(null).kind).toBe("error");
});

test("escapeHtml 转义 & < > 与双引号", () => {
  expect(escapeHtml(`<a href="x">&`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
  expect(escapeHtml(null)).toBe("");
});

test("renderSearchResultsHTML 转义 title 与 url（防 DOM-XSS），excerpt 原样保留", () => {
  const html = renderSearchResultsHTML([
    { url: `x" onmouseover="alert(1)`, meta: { title: `<img src=x onerror=alert(1)>` }, excerpt: "命中<mark>片段</mark>" },
  ]);
  expect(html).not.toContain("<img src=x");                  // title 里的标签被转义
  expect(html).toContain("&lt;img src=x");
  expect(html).toContain(`href="x&quot; onmouseover=&quot;alert(1)"`); // url 引号被转义，无法逃逸属性
  expect(html).not.toContain(`href="x" onmouseover="alert(1)"`);       // 原始可执行形态不存在
  expect(html).toContain("命中<mark>片段</mark>");           // excerpt（Pagefind 高亮）原样保留
});

test("renderSearchResultsHTML 空标题回退「(无标题)」", () => {
  const html = renderSearchResultsHTML([{ url: "u", meta: { title: "" }, excerpt: "" }]);
  expect(html).toContain("(无标题)");
});

// ── findReportMeta：Pagefind 命中 URL ↔ reports.json 条目反查 ──
const ENTRIES = [
  { title: "巨轮智能 002031", type: "股票", date: "2026-07-03", href: "r/2026-07-03_greatoo-002031/" },
  { title: "虚拟币是干嘛的", type: "概念", date: "2026-07-02", href: "r/2026-07-02_crypto-explained/" },
];

test("findReportMeta：站点根相对 URL 命中对应条目", () => {
  expect(findReportMeta("/r/2026-07-03_greatoo-002031/", ENTRIES).title).toBe("巨轮智能 002031");
});

test("findReportMeta：子路径部署 / 带 index.html / 带 query·hash 都归一化后命中", () => {
  expect(findReportMeta("/searchX/r/2026-07-02_crypto-explained/", ENTRIES).type).toBe("概念");
  expect(findReportMeta("/r/2026-07-02_crypto-explained/index.html", ENTRIES).type).toBe("概念");
  expect(findReportMeta("/r/2026-07-03_greatoo-002031/?from=search#sec", ENTRIES).date).toBe("2026-07-03");
});

test("findReportMeta：查不到 / 空入参 → null（结果卡退化为无元信息，不炸）", () => {
  expect(findReportMeta("/r/2099-01-01_unknown/", ENTRIES)).toBeNull();
  expect(findReportMeta("", ENTRIES)).toBeNull();
  expect(findReportMeta("/r/2026-07-03_greatoo-002031/", null)).toBeNull();
  expect(findReportMeta("/r/2026-07-03_greatoo-002031/", [null, {}])).toBeNull();
});

test("renderSearchResultsHTML：传清单时结果卡带「日期 · 类型」元信息", () => {
  const html = renderSearchResultsHTML(
    [{ url: "/r/2026-07-03_greatoo-002031/", meta: { title: "巨轮智能 002031" }, excerpt: "x" }],
    ENTRIES
  );
  expect(html).toContain('<div class="rmeta">2026·07·03 · 股票</div>');
});

test("renderSearchResultsHTML：无清单 / 查不到条目 → 不渲染元信息行，行为与旧版一致", () => {
  const items = [{ url: "/r/2099-01-01_unknown/", meta: { title: "t" }, excerpt: "x" }];
  expect(renderSearchResultsHTML(items)).not.toContain("rmeta");
  expect(renderSearchResultsHTML(items, ENTRIES)).not.toContain("rmeta");
});

test("renderSearchResultsHTML：元信息里的 date/type 也转义（清单被投毒不成 XSS）", () => {
  const html = renderSearchResultsHTML(
    [{ url: "/r/x/", meta: { title: "t" }, excerpt: "" }],
    [{ href: "r/x/", date: `<img src=x onerror=alert(1)>`, type: `"><script>` }]
  );
  expect(html).not.toContain("<img src=x");
  expect(html).not.toContain("<script>");
});

test("describeExistingReport：含标题/天数/链接；无命中给空串", () => {
  expect(describeExistingReport(null)).toBe("");
  expect(describeExistingReport({})).toBe("");
  const h = describeExistingReport({
    entry: { title: "芯原股份（688521.SH）", href: "r/2026-06-08_verisilicon-688521/" },
    ageDays: 2, matchedBy: "name",
  });
  expect(h).toContain("2 天内已调研过");
  expect(h).toContain("芯原股份（688521.SH）");
  expect(h).toContain('href="r/2026-06-08_verisilicon-688521/"');
  expect(h).toContain("点此查看报告");
});

test("describeExistingReport：0 天显示『今天刚调研过』", () => {
  const h = describeExistingReport({ entry: { title: "X", href: "r/x/" }, ageDays: 0 });
  expect(h).toContain("今天刚调研过");
});

test("describeExistingReport：title/href 转义防 DOM-XSS", () => {
  const h = describeExistingReport({
    entry: { title: `<img src=x onerror=alert(1)>`, href: `r/" onmouseover="alert(1)` },
    ageDays: 1,
  });
  expect(h).not.toContain("<img src=x");
  expect(h).toContain("&lt;img src=x");
  expect(h).not.toContain(`href="r/" onmouseover="alert(1)"`); // 引号被转义，无法逃逸属性
});

// ── fetchAny：主备端点 + 超时 ──────────────────────────────

// 假 fetch：按 URL 决定成功/失败，并记录调用顺序与传入的 signal。
function fakeFetch(behavior) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, signal: opts && opts.signal });
    const b = behavior[url];
    if (b instanceof Error) throw b;
    return b;
  };
  impl.calls = calls;
  return impl;
}

test("fetchAny：主端点成功 → 用主端点，不碰备用", async () => {
  const resp = { ok: true };
  const f = fakeFetch({ "https://a/": resp, "https://b/": new Error("不该被调") });
  const r = await fetchAny(["https://a/", "https://b/"], {}, { fetchImpl: f });
  expect(r).toBe(resp);
  expect(f.calls.map((c) => c.url)).toEqual(["https://a/"]);
});

test("fetchAny：主端点抛错（超时/黑洞）→ 自动落到备用端点", async () => {
  const resp = { ok: true };
  const f = fakeFetch({ "https://a/": new Error("aborted"), "https://b/": resp });
  const r = await fetchAny(["https://a/", "https://b/"], {}, { fetchImpl: f });
  expect(r).toBe(resp);
  expect(f.calls.map((c) => c.url)).toEqual(["https://a/", "https://b/"]);
});

test("fetchAny：全部端点失败 → 抛最后一个错误（调用方映射成失败文案）", async () => {
  const f = fakeFetch({ "https://a/": new Error("e1"), "https://b/": new Error("e2") });
  await expect(fetchAny(["https://a/", "https://b/"], {}, { fetchImpl: f })).rejects.toThrow("e2");
});

test("fetchAny：空串端点滤掉、重复端点去重（备用未配置时退化为单端点）", async () => {
  const f = fakeFetch({ "https://a/": new Error("boom") });
  await expect(fetchAny(["https://a/", "", null, "https://a/"], {}, { fetchImpl: f })).rejects.toThrow("boom");
  expect(f.calls.length).toBe(1); // 只调一次：空的滤掉、重复的去重
});

test("fetchAny：每次调用都带 AbortSignal（超时兜底，杜绝无限『提交中』）", async () => {
  const f = fakeFetch({ "https://a/": { ok: true } });
  await fetchAny(["https://a/"], {}, { fetchImpl: f });
  expect(f.calls[0].signal).toBeTruthy();
  expect(typeof f.calls[0].signal.aborted).toBe("boolean");
});

// ── Pagefind 摘录必须转义（2026-07-31 审查）─────────────────────
// excerpt 是从报告正文里摘出来的片段，而报告正文由全权限 headless Claude 生成。
// 老实现「按 Pagefind 约定原样保留」等于把报告正文直接写进首页 innerHTML；
// 首页同源 localStorage 里存着邀请 token 与 CHECK_KEY。
test("renderExcerpt：只放行 <mark>，其余标签一律转义", () => {
  expect(renderExcerpt("普通<mark>命中</mark>文字")).toBe("普通<mark>命中</mark>文字");
  expect(renderExcerpt('<img src=x onerror=alert(1)>')).toBe("&lt;img src=x onerror=alert(1)&gt;");
  expect(renderExcerpt("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(renderExcerpt(null)).toBe("");
});

test("renderSearchResultsHTML：excerpt 里的注入被转义后才拼进 HTML", () => {
  const html = renderSearchResultsHTML([
    { url: "/r/x/", meta: { title: "标题" }, excerpt: '<img src=x onerror=alert(1)><mark>命中</mark>' },
  ]);
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
  expect(html).toContain("<mark>命中</mark>");
});

// ── degraded 信号必须传达给提交者（2026-07-31 审查）───────────────
// Worker 在「Issue 建成、但 issue 号→邮箱映射没写进 KV」时回 {ok:true, degraded:true}。
// 邮箱映射写不进去，runner 跑完就不知道该发给谁，那封「已上线」邮件永远发不出。
// 老实现只看 ok，照样承诺「结果会发到你的邮箱」，提交者干等一场还不知道出了什么事。
test("describeResult：degraded 时不承诺发邮件，如实说明", () => {
  const out = describeResult({ ok: true, degraded: true });
  expect(out.kind).toBe("warn");
  expect(out.text).not.toContain("会发到你的邮箱。");
  expect(out.text).toContain("可能发不到");
});

test("describeResult：正常成功仍是 success 文案（不回归）", () => {
  const out = describeResult({ ok: true });
  expect(out.kind).toBe("success");
  expect(out.text).toContain("发到你的邮箱");
});

// ── 专属链接：新式 #k= 与旧式 ?k= 都要认（2026-07-31）─────────────
// token 走 fragment 后不再进 Pages / Worker 访问日志、不随 referer 外泄；
// 但已经发给朋友的 ?k= 旧链接必须永久有效，不能让人重新去要链接。
test("tokenFromHash：从 #k= 取 token；无则空串", () => {
  expect(tokenFromHash("#k=ABC")).toBe("ABC");
  expect(tokenFromHash("#k=A%2FB")).toBe("A/B");     // 解码
  expect(tokenFromHash("#submit")).toBe("");
  expect(tokenFromHash("")).toBe("");
  expect(tokenFromHash(null)).toBe("");
});

test("resolveToken：新式 #k= 优先于旧式 ?k=，两者都会落盘", () => {
  const mk = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
  const s1 = mk();
  expect(resolveToken({ search: "?k=OLD", hash: "#k=NEW" }, s1)).toBe("NEW");
  expect(s1.getItem(TOKEN_STORAGE_KEY)).toBe("NEW");

  const s2 = mk();
  expect(resolveToken({ search: "?k=OLD", hash: "" }, s2)).toBe("OLD");   // 旧链接照常工作
  expect(s2.getItem(TOKEN_STORAGE_KEY)).toBe("OLD");
});

test("resolveToken：URL 没带就回退本机存储（点开报告再返回、刷新、冷启动都还在授权态）", () => {
  const m = new Map([[TOKEN_STORAGE_KEY, "SAVED"]]);
  const st = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  expect(resolveToken({ search: "", hash: "" }, st)).toBe("SAVED");
});

test("resolveToken：仍兼容「只传 search 字符串」的旧调用形态", () => {
  const m = new Map();
  const st = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  expect(resolveToken("?k=OLD", st)).toBe("OLD");
});

test("resolveToken：storage 不可用时不抛，仍能返回链接里的 token", () => {
  const boom = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
  expect(resolveToken({ search: "", hash: "#k=T" }, boom)).toBe("T");
  expect(resolveToken({ search: "", hash: "" }, boom)).toBe("");
  expect(resolveToken({ search: "", hash: "" }, null)).toBe("");
});

// ── 搜索结果卡片的系列角标（方案 C）────────────────────────────────
// 搜「胜宏科技」会并排出现两张同名卡，正是最困惑的地方，角标必须同样生效。
const SERIES_ENTRIES = [
  { title: "胜宏科技（300476.SZ）", type: "股票", date: "2026-07-26", href: "r/2026-07-26_shenghong/",
    series: { index: 2, total: 2, daysSincePrev: 48, newerHref: null } },
  { title: "胜宏科技（300476.SZ）", type: "股票", date: "2026-06-08", href: "r/2026-06-08_shenghong/",
    series: { index: 1, total: 2, daysSincePrev: null, newerHref: "r/2026-07-26_shenghong/" } },
];

test("搜索结果：较新一篇出「第 2 次 · 48 天后」，较旧一篇出「已有更新版 →」并压暗", () => {
  const html = renderSearchResultsHTML([
    { url: "/r/2026-07-26_shenghong/", meta: { title: "胜宏科技（300476.SZ）" }, excerpt: "e" },
    { url: "/r/2026-06-08_shenghong/", meta: { title: "胜宏科技（300476.SZ）" }, excerpt: "e" },
  ], SERIES_ENTRIES);
  expect(html).toContain('<span class="series-badge">第 2 次<span class="series-gap"> · 48 天后</span></span>');
  expect(html).toContain('<a class="series-newer" href="r/2026-07-26_shenghong/">已有更新版 →</a>');
  expect(html).toContain('class="result is-superseded"');
});

test("搜索结果：更新版链接在结果卡的 <a> 之外（<a> 套 <a> 会被浏览器拆开）", () => {
  const html = renderSearchResultsHTML(
    [{ url: "/r/2026-06-08_shenghong/", meta: { title: "胜宏科技" }, excerpt: "e" }], SERIES_ENTRIES);
  expect(html.indexOf("series-newer")).toBeGreaterThan(html.indexOf("</a>"));
});

test("搜索结果：清单里没有 series 字段时不出任何角标（旧 reports.json 缓存也不炸）", () => {
  const html = renderSearchResultsHTML(
    [{ url: "/r/x/", meta: { title: "某报告" }, excerpt: "e" }],
    [{ title: "某报告", date: "2026-01-01", type: "股票", href: "r/x/" }]);
  expect(html).not.toContain("series-badge");
  expect(html).not.toContain("series-newer");
  expect(html).not.toContain("is-superseded");
});
