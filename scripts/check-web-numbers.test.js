// scripts/check-web-numbers.test.js
// 守卫联网数字回链核验的判定口径。**夹具绿不等于真实数据对**（CLAUDE.md）——改动本模块后
// 必须再对真实归档跑一遍 `bun run scripts/check-web-numbers.js --dir <某篇>`，看清单还读不读得懂。
// 带「变异验证」注释的用例，是把检查改坏后必须变红的那些。

import { test, expect } from "bun:test";
import {
  stripTags, blocksWithLinks, citedNumbers, numberVariants, containsNumber,
  normalizePage, looksUnrendered, matchNumberInPages, planChecks, classify,
  renderReport, renderChallenge, pageNumbers, scaledCandidates, matchPower, resolveBin, fetchPage,
  reportUnit, pageIndex, matchByMagnitude, baiwanMatch, looksLikePdf,
} from "./check-web-numbers.js";

// ========== HTML → 带链接的块 ==========

test("只收含外链的块（没链接的数字不归本模块管）", () => {
  const bs = blocksWithLinks(`
    <p>营收 108.96 亿元，没有挂来源。</p>
    <p>美国收入占 61.7%（<a href="https://a.com/x">2025 年报</a>）。</p>`);
  expect(bs.length).toBe(1);
  expect(bs[0].urls).toEqual(["https://a.com/x"]);
  expect(bs[0].text).toContain("61.7");
});

test("表格按 </tr> 切、不按 </td> 切——否则数字与来源会被切散", () => {
  const bs = blocksWithLinks(
    `<table><tr><td>营业收入</td><td>108.96 亿元</td><td><a href="https://a.com/r">年报</a></td></tr></table>`
  );
  // 变异验证：把 </td> 加进块边界，这条会红（数字所在块将不含链接，整行漏核）
  expect(bs.length).toBe(1);
  expect(bs[0].text).toContain("108.96");
  expect(bs[0].urls).toEqual(["https://a.com/r"]);
});

test("同块多条链接全部收下（数字可能挂在其中任一条上）", () => {
  const bs = blocksWithLinks(
    `<p>集资 550.5 亿港元（<a href="https://a.com/1">招股书</a>、<a href="https://b.com/2">媒体</a>）</p>`
  );
  expect(bs[0].urls).toEqual(["https://a.com/1", "https://b.com/2"]);
});

test("stripTags 剥掉 style/script 整块（模板 CSS 的数字会淹没判断）", () => {
  const t = stripTags(`<style>.a{font-size:14.5px}</style><p>正文 42.5 亿元</p>`);
  expect(t).toContain("42.5");
  expect(t).not.toContain("14.5");
});

// ========== 待核数字的挑选 ==========

test("跳过没有辨识度的小整数，保留带单位的和带小数的", () => {
  const nums = citedNumbers("覆盖 42 家客户，毛利率 33%，营收 108.96 亿元，员工 800 人");
  const raws = nums.map((n) => n.raw);
  // 变异验证：去掉辨识度过滤，"42" 和 "800" 会混进来——它们在任何长网页里都必然命中
  expect(raws).not.toContain("42");
  expect(raws).not.toContain("800");
  expect(raws).toContain("33");
  expect(raws).toContain("108.96");
});

test("日期区间「1.1–7.16」不当数字核，但真实数值区间「1.5–3.2 倍」照核", () => {
  const raws = citedNumbers("1.1–7.16 累计签单 146.53 亿元").map((n) => n.raw);
  // 变异验证：去掉 stripDateRanges，"1.1"/"7.16" 会混进来，质证清单里全是核不上的日期
  expect(raws).not.toContain("7.16");
  expect(raws).toContain("146.53");
  const r2 = citedNumbers("估值 1.5–3.2 倍区间").map((n) => n.raw);
  expect(r2).toContain("1.5");
  expect(r2).toContain("3.2");
  // 收尾复审补的：带单位的区间与「月.日–月.日」形态完全一样，漏了单位判据会被静默吞掉
  const r3 = citedNumbers("募资 10.5–12.30 亿元").map((n) => n.raw);
  expect(r3).toContain("10.5");
  expect(r3).toContain("12.30");
});

test("证券代码与年份不进待核清单（沿用 research-qc 的过滤口径）", () => {
  const raws = citedNumbers("中际旭创 300308.SZ 于 2025 年营收 262.4 亿元").map((n) => n.raw);
  expect(raws).not.toContain("300308");
  expect(raws).not.toContain("2025");
  expect(raws).toContain("262.4");
});

// ========== 数字在页内的几种写法 ==========

test("变体覆盖千分位与尾零两种写法差异", () => {
  const v = numberVariants({ raw: "2,646.93", value: 2646.93, tail: "" });
  expect(v).toContain("2,646.93");
  expect(v).toContain("2646.93");
});

test("「亿」按放大方向换算出万与元的写法（公告原文常用）", () => {
  const v = numberVariants({ raw: "108.96", value: 108.96, tail: "亿元，" });
  expect(v).toContain("1089600");        // 万元
  expect(v).toContain("10896000000");    // 元
  expect(v).toContain("10,896,000,000"); // 元 + 千分位
});

test("变体封顶 8 个且不做反向缩放——候选越多，「搜到了」这个强证据越不强", () => {
  const v = numberVariants({ raw: "108.96", value: 108.96, tail: "亿元" });
  expect(v.length).toBeLessThanOrEqual(8);
  // 变异验证：若照 research-qc 早期那样按倍数任意展开，下面会红
  expect(v).not.toContain("0.010896");
});

test("containsNumber 卡数字边界：61.7 不许在 161.7 / 61.75 里命中", () => {
  // 变异验证：改成 indexOf，这两条会红——假「搜到」等于放过一条真硬错，是最坏的方向
  expect(containsNumber("营收161.7亿元", "61.7")).toBe(false);
  expect(containsNumber("占比61.75%", "61.7")).toBe(false);
  expect(containsNumber("占比61.7%", "61.7")).toBe(true);
});

test("千分位串两头也要卡住：1,089,600 不许在 1,089,600,000 里命中（差 1000 倍）", () => {
  // 变异验证：去掉 (?!,\d) / (?<!\d,) 任一条都会红。写这条是因为它真的漏过——
  // 「108.96 亿」的万元候选正是 1,089,600，页面里的 10.896 亿会写成 1,089,600,000。
  expect(containsNumber("现金流1,089,600,000元", "1,089,600")).toBe(false);
  expect(containsNumber("现金流12,089,600元", "089,600")).toBe(false);
  expect(containsNumber("现金流1,089,600元", "1,089,600")).toBe(true);
});

test("页面文本先去空白再搜（网页里「61.7 %」「108.96 亿」常夹空格换行）", () => {
  const page = normalizePage("美国区收入占比 61.7 %\n，同比提升");
  expect(containsNumber(page, "61.7")).toBe(true);
});

test("正文过短判「疑似未渲染」——JS 骨架页会批量造出假嫌疑", () => {
  expect(looksUnrendered("正文很短")).toBe(true);
  expect(looksUnrendered("正".repeat(900))).toBe(false);
});

test("matchNumberInPages 报出命中的是哪条来源、哪种写法", () => {
  const r = matchNumberInPages(
    { raw: "108.96", value: 108.96, tail: "亿元" },
    [{ url: "https://a.com/1", text: normalizePage("其他数字 5") },
     { url: "https://b.com/2", text: normalizePage("经营现金流净额 90.58 亿元") }]
  );
  const r2 = matchNumberInPages(
    { raw: "108.96", value: 108.96, tail: "亿元" },
    [{ url: "https://b.com/2", text: normalizePage("经营活动现金流净额 108.96 亿元") }]
  );
  expect(r.hit).toBe(false);
  expect(r2.hit).toBe(true);
  expect(r2.url).toBe("https://b.com/2");
  expect(r2.form).toContain("108.96");
  expect(r2.scaled).toBeFalsy(); // 原样搜到，不是换算来的
});

// ========== 量级比对（第二档） ==========

test("报告的四舍五入值能对上来源的千元精确值（智谱那篇的主要误报形态）", () => {
  // 「2025 年收入 7.24 亿元」而港交所公告原文是 724,187 千元——字符串永远搜不到
  const page = { url: "https://a.com/1", text: normalizePage("年内收入724,187千元") };
  const r = matchNumberInPages({ raw: "7.24", value: 7.24, tail: "亿元" }, [page]);
  expect(r.hit).toBe(true);
  expect(r.scaled).toBe(true);
  expect(r.form).toContain("千元");
});

test("量级比对的容差随倍数缩放（不缩放的话小数字会开出 22% 的窗口）", () => {
  const c = scaledCandidates({ raw: "7.24", value: 7.24, tail: "亿元" });
  const qian = c.find((x) => x.label === "千元");
  expect(qian.v).toBeCloseTo(724000, 0);
  // 变异验证：容差写死不随倍数走，这条会红
  expect(qian.tol).toBeGreaterThan(100);
  expect(qian.tol).toBeLessThan(1000);
});

test("量级比对不许放过量级对不上的数", () => {
  // 注意夹具不能用 72,418——那个数按「万元」读正好是 7.2418 亿，落在容差内、**本就该命中**。
  // 本模块只比数值不读页面单位（同 research-qc），这是已写进注释的固有局限。
  const page = { url: "https://a.com/1", text: normalizePage("金额7,241元与3,905元") };
  expect(matchNumberInPages({ raw: "7.24", value: 7.24, tail: "亿元" }, [page]).hit).toBe(false);
});

test("判别力自测：页面数字越密，判别力越低（低了要在输出里明说这轮不作数）", () => {
  const mk = (text) => [{ value: 7.24, raw: "7.24", tail: "亿元", pages: [{ url: "u", text, nums: pageNumbers(text) }] }];
  const sparse = mk(normalizePage("收入724,187千元"));
  // 密集页：间隔 100 的网格，与万元档的容差窗（「7.24」写到两位小数 → ±50 万元）一样细——
  // 招股书那种满篇数字的页面就是这个形态。每个数后面带「万元」：量级比对现在要求页面上那个数
  // 像这个口径的数（紧跟「万」即认），裸数或紧跟「元」的数进不了万元档，那样就测不出「密」了
  const dense = normalizePage(Array.from({ length: 12000 }, (_, i) => `${10000 + i * 100}万元`).join("，"));
  expect(matchPower(sparse, 40)).toBeGreaterThan(0.8);
  // 变异验证：去掉判别力自测（永远返回 null / 1），这条会红——「全部命中」正是检查失效的样子
  expect(matchPower(mk(dense), 40)).toBeLessThan(0.5);
});

// ========== 分档 ==========

const ITEM = { raw: "61.7", value: 61.7, tail: "%", context: "美国收入占 61.7%", urls: ["https://a.com/x"] };

test("抓到页面且搜到 → confirmed", () => {
  const f = new Map([["https://a.com/x", { ok: true, text: normalizePage("美国区收入占比61.7%") }]]);
  const { confirmed, notFound, untested } = classify([ITEM], f);
  expect(confirmed.length).toBe(1);
  expect(notFound.length + untested.length).toBe(0);
});

test("抓到页面但搜不到 → notFound（待质证）", () => {
  const f = new Map([["https://a.com/x", { ok: true, text: normalizePage("境外收入占比90.58%") }]]);
  const { notFound } = classify([ITEM], f);
  expect(notFound.length).toBe(1);
  expect(notFound[0].tried).toEqual(["https://a.com/x"]);
});

test("页面没抓到 → untested，绝不混进 notFound", () => {
  // 这是本模块最关键的一条：把「没测」说成「搜不到」，清单会立刻失信
  const f = new Map([["https://a.com/x", { ok: false, note: "超时" }]]);
  const { notFound, untested } = classify([ITEM], f);
  expect(notFound.length).toBe(0);
  expect(untested.length).toBe(1);
  expect(untested[0].notes[0]).toContain("超时");
});

test("同块多来源：任一条页面里搜到即算确认", () => {
  const item = { ...ITEM, urls: ["https://a.com/1", "https://b.com/2"] };
  const f = new Map([
    ["https://a.com/1", { ok: true, text: normalizePage("无关内容".repeat(50)) }],
    ["https://b.com/2", { ok: true, text: normalizePage("美国收入占61.7%") }],
  ]);
  expect(classify([item], f).confirmed.length).toBe(1);
});

// ========== 只管「联网数字」 ==========

test("能对回本地 data/ 的数字不进待核清单（那是 research-qc 数字对账的活）", () => {
  const html = `<p>营收 262.4 亿元、毛利率 46.06%（<a href="https://a.com/1">年报</a>）</p>`;
  // localValues = 「对不回 data/ 的数值」集合；262.4 不在其中 ⇒ 它对得回 data/ ⇒ 排除
  const p = planChecks(html, { localValues: new Set([46.06]) });
  expect(p.items.map((i) => i.raw)).toEqual(["46.06"]);
  expect(p.skippedLocal).toBe(1);
});

test("没有 data/ 时（localValues=null）一个都不排除——「没测」不能当「测过了」", () => {
  const html = `<p>营收 262.4 亿元、毛利率 46.06%（<a href="https://a.com/1">年报</a>）</p>`;
  // 变异验证：若把 null 也当成空集合去过滤，这里会变成 0 条，整份检查静默空转
  const p = planChecks(html, { localValues: null });
  expect(p.items.length).toBe(2);
  expect(p.skippedLocal).toBe(0);
});

test("上下文自称推算的，标 derived（只标注不排除——自称推算也可能是编的）", () => {
  const html = `<p>2025Q4 营收 132.35 亿＝382.40−250.05（<a href="https://a.com/1">年报</a>）</p>
                <p>美国收入占 61.7%（<a href="https://b.com/2">年报</a>）</p>`;
  const p = planChecks(html, {});
  expect(p.items.find((i) => i.raw === "132.35").derived).toBe(true);
  expect(p.items.find((i) => i.raw === "61.7").derived).toBe(false);
});

test("planChecks 去重 URL 并按 maxUrls 截断", () => {
  const html = `<p>甲 12.5 亿（<a href="https://a.com/1">源</a>）</p>
                <p>乙 33.4%（<a href="https://a.com/1">源</a>、<a href="https://b.com/2">源2</a>）</p>`;
  const p = planChecks(html, { maxUrls: 1 });
  expect(p.urlsTotal).toBe(2);
  expect(p.urls).toEqual(["https://a.com/1"]);
  expect(p.items.length).toBe(2);
});

// ========== 输出 ==========

test("跑不完时明说「未测」，不渲染成通过", () => {
  const out = renderReport({ dir: "x", ok: false, error: "report.html 不存在" });
  expect(out).toContain("未跑完");
  expect(out).not.toContain("✅");
});

test("质证清单：无发现返回空串（不硬造质证点）", () => {
  expect(renderChallenge({ ok: true, confirmed: [ITEM], notFound: [], untested: [] })).toBe("");
});

test("质证清单只出 notFound 一档，且措辞是「质证」不是「判错」", () => {
  const c = renderChallenge({
    ok: true, confirmed: [], untested: [{ ...ITEM, notes: ["x（超时）"] }],
    notFound: [{ ...ITEM, tried: ["https://a.com/x"] }],
  });
  expect(c).toContain("61.7");
  expect(c).toContain("质证");
  expect(c).not.toContain("超时"); // untested 不进质证清单
});

// ========== 归一化不许把相邻数字粘成一串 ==========
// 2026-09-18 审查：老 normalizePage 删掉**全部**空白，PDF 与英文表格里只隔空白的相邻数字会连成
// 「3,016,714,649.182,573,139,460.90」。对英维克半年报 PDF 实测，1826 个独立成行的小数里 87%
// 原样搜不到、全部退成弱档「换算命中」；英文页面「2024 2025 108.96 61.7」则直接漏判。

test("normalizePage：数字之间保留一个分隔，数字与单位/中文之间的空白照删", () => {
  expect(normalizePage("美国区收入占比 61.7 %\n，同比提升")).toBe("美国区收入占比61.7%，同比提升");
  expect(normalizePage("净利润 136.51 亿元")).toBe("净利润136.51亿元");
  expect(normalizePage("3,016,714,649.18\n\n2,573,139,460.90\n\n17.24%")).toBe("3,016,714,649.18 2,573,139,460.90 17.24%");
  expect(normalizePage("Revenue 2024 2025 108.96 61.7")).toBe("Revenue2024 2025 108.96 61.7");
  expect(normalizePage("123.45 -67.8")).toBe("123.45 -67.8"); // 负数也是数字，不能粘
});

test("PDF 表格式排布（数字只隔换行）：每个数字都能原样搜到", () => {
  const page = normalizePage("营业收入（元）\n3,016,714,649.18\n\n2,573,139,460.90\n\n17.24%\n归母净利润\n249,027,196.66\n");
  const mk = (raw, tail = " 元") => ({ raw, value: Number(raw.replace(/,/g, "")), tail });
  const pages = [{ url: "https://a.com/1", text: page }];
  for (const raw of ["3,016,714,649.18", "2,573,139,460.90", "249,027,196.66"]) {
    const r = matchNumberInPages(mk(raw), pages);
    expect(r.hit).toBe(true);
    expect(r.form).toBe(`原样「${raw}」`);   // 强证据档，不是退化成「换算命中」
    expect(Boolean(r.scaled)).toBe(false);
  }
  expect(matchNumberInPages(mk("17.24", "%"), pages).form).toBe("原样「17.24」");
});

test("英文表格（数字只隔空格）：不再被粘成一串而漏判", () => {
  const page = normalizePage("Revenue 2024 2025 108.96 61.7 % of total");
  expect(containsNumber(page, "61.7")).toBe(true);
  expect(containsNumber(page, "108.96")).toBe(true);
  expect([...pageNumbers(page)]).toContain(61.7);
});

// ========== 亿 / 万 ↔ billion / million ==========
// 2026-09-18 审查：SKILL 明写科技类优先英文一手来源，而候选只有 万元/千元/元。对 nvidia 那篇实跑，
// 14 条「搜不到」里 200 亿美元（$20 billion）/ 32 亿 / 40 亿 / 1300 万颗 都是这一形态，近半是假嫌疑。

test("亿/万 能对上英文页面的 billion / million 写法（带单位词，强证据档）", () => {
  const page = normalizePage("Nvidia is buying Groq for about $20 billion. Corning deal up to $3.2 billion; China stockpiled 13 million HBM stacks; revenue $55.05B, capex 1.2bn.");
  const pages = [{ url: "https://a.com/1", text: page }];
  const hit = (raw, tail) => matchNumberInPages({ raw, value: Number(raw), tail }, pages);
  expect(hit("200", "亿美元").hit).toBe(true);
  expect(hit("200", "亿美元").form).toContain("billion");
  expect(Boolean(hit("200", "亿美元").scaled)).toBe(false);
  expect(hit("32", "亿美元").hit).toBe(true);
  expect(hit("1300", "万颗").hit).toBe(true);
  expect(hit("1300", "万颗").form).toContain("million");
  expect(hit("550.5", "亿").hit).toBe(true);   // 55.05B
  expect(hit("12", "亿").hit).toBe(true);      // 1.2bn
});

test("守卫：billion/million 换算必须带单位词——页面里一个裸「20」不能证明「200 亿美元」", () => {
  // 日期里的 20、章节号 20 满篇都是，若把 200亿→20 作为裸数字候选，等于把「已找到」这档变成恒命中。
  const page = normalizePage("Published 2026-03-20. Section 20 covers pricing. The deal was worth 20 million dollars.");
  const pages = [{ url: "https://a.com/1", text: page, nums: pageNumbers(page) }];
  const r = matchNumberInPages({ raw: "200", value: 200, tail: "亿美元" }, pages);
  expect(r.hit).toBe(false); // 20 million ≠ 200 亿，裸 20 也不算
});

test("守卫：单字母缩写 m/b 不许在「13 months」「4 bytes」这类词里命中，$ 前缀或后接非字母才算", () => {
  const hit = (page, raw, tail) =>
    matchNumberInPages({ raw, value: Number(raw), tail }, [{ url: "u", text: normalizePage(page), nums: new Set() }]).hit;
  expect(hit("waited 13 months for delivery", "1300", "万颗")).toBe(false);   // 13m…onths：单字母后接字母
  expect(hit("needs 4 bytes per entry", "40", "亿美元")).toBe(false);          // 4b…ytes
  expect(hit("deal worth $4B, closed", "40", "亿美元")).toBe(true);            // $ 前缀
  expect(hit("volume 13M, up 5%", "1300", "万颗")).toBe(true);                 // 后接非字母
  expect(hit("13 million HBM stacks", "1300", "万颗")).toBe(true);             // 全词后面接字母也认（空白已删）
});

// ========== 外部程序定位 ==========
// launchd 拉起的 runner 只有系统 PATH，/opt/homebrew/bin 不在里面：poppler 装了、pdftotext 照样找不到，
// 所有 PDF 来源静默「未测」（2026-09-18 Mac mini 实测）。

test("resolveBin：PATH 找不到时退到 Homebrew 固定路径；环境变量可强制指定；都没有返回 null", () => {
  const none = () => null;
  expect(resolveBin("pdftotext", { env: {}, which: none, exists: (p) => p === "/opt/homebrew/bin/pdftotext" }))
    .toBe("/opt/homebrew/bin/pdftotext");
  expect(resolveBin("pdftotext", { env: {}, which: () => "/usr/local/bin/pdftotext", exists: () => true }))
    .toBe("/usr/local/bin/pdftotext");                       // PATH 里有就用 PATH 的
  expect(resolveBin("pdftotext", { env: { SEARCHX_PDFTOTEXT: "/x/pdftotext" }, which: none, exists: () => false }))
    .toBe("/x/pdftotext");                                   // 环境变量优先于一切
  expect(resolveBin("pdftotext", { env: {}, which: none, exists: () => false })).toBe(null);
});

// ========== https 403 → http 兜底 ==========
// 巨潮 static.cninfo.com.cn 对 Mac mini 的 https 回 403、http 正常（2026-09-18 实测），它是最主要的披露级来源。

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    const r = routes[String(url)] || { status: 404 };
    const body = r.body || "";
    return {
      ok: r.status === 200, status: r.status,
      headers: { get: () => r.ct || "text/html; charset=utf-8" },
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  };
  fn.calls = calls;
  return fn;
}
const LONG = "营业收入 3,016,714,649.18 元。" + "正文填充。".repeat(400);

test("https 回 403 → 换 http 再抓一次，成功时 note 写明走了 http", async () => {
  const fetchImpl = fakeFetch({
    "https://static.cninfo.com.cn/a.html": { status: 403 },
    "http://static.cninfo.com.cn/a.html": { status: 200, body: LONG },
  });
  const r = await fetchPage("https://static.cninfo.com.cn/a.html", { fetchImpl });
  expect(r.ok).toBe(true);
  expect(r.note).toContain("http");
  expect(r.text).toContain("3,016,714,649.18");
  expect(fetchImpl.calls).toEqual(["https://static.cninfo.com.cn/a.html", "http://static.cninfo.com.cn/a.html"]);
});

test("http 也失败 → 仍报「未测」，且只降级一次；非 403 / 本就是 http 的不降级", async () => {
  const both = fakeFetch({ "https://x.com/a": { status: 403 }, "http://x.com/a": { status: 403 } });
  const r1 = await fetchPage("https://x.com/a", { fetchImpl: both });
  expect(r1.ok).toBe(false);
  expect(r1.note).toContain("403");
  expect(both.calls.length).toBe(2);                       // 不会无限互试
  const f500 = fakeFetch({ "https://x.com/b": { status: 500 } });
  expect((await fetchPage("https://x.com/b", { fetchImpl: f500 })).note).toBe("HTTP 500");
  expect(f500.calls.length).toBe(1);                       // 500 不降级
  const fhttp = fakeFetch({ "http://x.com/c": { status: 403 } });
  expect((await fetchPage("http://x.com/c", { fetchImpl: fhttp })).note).toBe("HTTP 403");
  expect(fhttp.calls.length).toBe(1);                      // 本就是 http，没得降
});

// ========== 假「已找到」：整数白捡小数、换算档不看单位（2026-09-23） ==========
// normalizePage 不再把相邻数字粘成一串以后，行情侧栏、PDF 表格里的独立小数与股票代码成批撞进来。
// 下面的页面片段都摘自 22 篇存量真跑时抓到的原文（缓存回放），不是编的形态。

const hitOn = (raw, tail, text) =>
  matchNumberInPages({ raw, value: Number(raw.replace(/,/g, "")), tail }, [{ url: "u", text: normalizePage(text) }]);

test("reportUnit：取报告数字后第一个单位字，标点不算，繁简全半角归一", () => {
  expect(reportUnit(" 亿港元")).toBe("亿");
  expect(reportUnit("%）")).toBe("%");
  expect(reportUnit("％")).toBe("%");
  expect(reportUnit(" 萬股")).toBe("万");
  expect(reportUnit(" 吨 +")).toBe("吨");
  expect(reportUnit("）机器人")).toBe(null);
  expect(reportUnit("")).toBe(null);
});

test("整数碰上「N.xx」：四舍五入对得上且紧跟同单位才认", () => {
  // 变异验证：去掉「紧跟同单位」这条，第一条（侧栏股价）与第三条（股价 vs 报告的 %）会红
  expect(containsNumber(normalizePage("09-16锦华新材920015 18.15新浪财经"), "18", { unit: "亿" })).toBe(false);
  expect(containsNumber("报收于30.37元，上涨1.98%", "30", { unit: "%" })).toBe(false);
  // 变异验证：去掉「四舍五入对得上」这条，这两条会红（42.53 取整是 43，20.94 是 21）
  expect(containsNumber("营业收入年复合增长率42.53%，归属", "42", { unit: "%" })).toBe(false);
  expect(containsNumber("20.94亿元", "20", { unit: "亿" })).toBe(false);
  // 合理四舍五入：照样命中
  expect(containsNumber("中际旭创2025年实现382.4亿元营业收入", "382", { unit: "亿" })).toBe(true);
  expect(containsNumber("净利润达4626.39万元", "4626", { unit: "万" })).toBe(true);
  expect(containsNumber("同比增长1034.18%，已成为", "1034", { unit: "%" })).toBe(true);
  expect(containsNumber("2,138.17%102,051,079.29", "2,138", { unit: "%" })).toBe(true);
  // 小数部分全 0 就是同一个数；不给单位（换算来的写法）时「N.xx」一律不认
  expect(containsNumber("from18.0%in2024to21.0%in2025", "21")).toBe(true);
  expect(containsNumber("实现382.4亿元", "382")).toBe(false);
  // 同页别处有干净的写法，不因第一个位置被拒而漏掉
  expect(containsNumber("型号V64.3A；效率超过64%", "64", { unit: "%" })).toBe(true);
});

test("三个真实假命中修后不再算找到（侧栏股价 / PDF 表格小数 / 侧栏股票代码）", () => {
  // 变异验证：containsNumber 恢复旧边界，前两条会红；量级档恢复「只比数值」，第三条会红
  expect(hitOn("18", " 亿港元", "云汉芯城301563 27 09-16锦华新材920015 18.15新浪财经意见反馈留言板").hit).toBe(false);
  expect(hitOn("20", " 亿元、", "9,098,838 22.31 2.00 101,486,112 38,768,964 20.94 8.00 445,843,090 100.0").hit).toBe(false);
  expect(hitOn("92", "亿美元", "成交额1.2万元 08-19贝特利301697--08-17华大海天920288 12.57 08-14高凯技术688835 61.36").hit).toBe(false);
});

test("合理的四舍五入仍算找到：紧跟同单位的走原样档，别处有精确值的退到原值档", () => {
  expect(hitOn("382", " 亿、", "中际旭创2025年实现382.4亿元营业收入").hit).toBe(true);
  expect(hitOn("3118", " 万）", "该项目已经累计实现效益3118.46万元。").hit).toBe(true);
  const r = hitOn("108", " 亿，", "归母净利润107.97亿元同比增长108.78%；毛利率");
  expect(r.hit).toBe(true);
  expect(r.form).toContain("107.97");   // 不是撞上 108.78% 那个百分数
});

test("量级比对·原值档：页面数紧跟单位字的必须同单位；不跟单位的只在报告写到小数位时认", () => {
  // 变异验证：原值档不查单位，前三条会红
  expect(hitOn("69", " 亿美元", "AXT Inc. (AXTI) is up 14.2%, or $8.56 to $68.99. 7 weeks ago").hit).toBe(false); // 股价
  expect(hitOn("603305", "）机器人", "汉朔科技301275 27.5 02-28永杰新材603271--02-21").hit).toBe(false);          // 另一只代码
  expect(hitOn("2.2", " 万元/吨", "2026年预计达115万吨（+22.3%），储能占比").hit).toBe(false);                       // 千元档撞上百分数
  expect(hitOn("67", " 亿，", "实现营业收入66.89亿元，").hit).toBe(true);
  expect(hitOn("55.4", "%、毛", "锂电铜箔 58.00% 55.37%锂电").hit).toBe(true);
  expect(hitOn("31", "%）", "Forecast Year, 2034 USD 1,055.11 Mn CAGR, 2025-2034 30.66% Report").hit).toBe(true);
});

test("量级比对·万元/千元档：紧跟本单位直接认；表格裸数要像金额且页面有口径词；紧跟别的单位不认", () => {
  // 留下的：A 股公告表格（通篇万元）、港股人民幣千元表、华虹 US$ thousands 表
  expect(hitOn("12.11", " 亿、", "单位：万元 营业总收入 121,138.73 108,622.10 11.53").hit).toBe(true);
  expect(hitOn("22.59", " 亿元及", "（人民幣千元）現金 108,593 2,259,147 42,621").hit).toBe(true);
  expect(hitOn("20.04", " 亿美元", "Summary of Operating Results (Amounts in US$ thousands) ROE 2024 (Unaudited) 2,003,993 205,128 10.2%").hit).toBe(true);
  expect(hitOn("12.83", " 亿 ", "公司实现营业收入128,349.29万元，").hit).toBe(true);
  // 挡掉的：
  // 变异验证：去掉「页面要有千元类口径词」，第一条会红（「单位：元」表里的 27,040,815.86 当成 270 亿）
  expect(hitOn("270", " 亿元。", "单位：元 52,680,744.28 27,040,815.86 41,533,950.43").hit).toBe(false);
  // 变异验证：去掉「要像金额」，这两条会红（股票代码、链接里的编号）
  expect(hitOn("92", "亿美元", "成交额1.2万元 华大海天920288 12.57").hit).toBe(false);
  expect(hitOn("1.7", " 亿个，", "单位：万元 https://www.anandtech.com/show/17259/intel-disclosure").hit).toBe(false);
  // 变异验证：去掉「紧跟别的单位不认」，这条会红（2,259.1 是百萬，不是万元）
  expect(hitOn("0.23", " 亿元。", "人民幣千元 現金及現金等價物為人民幣2,259.1百萬元，較2024年").hit).toBe(false);
});

test("pageIndex 记下每个数的原串与紧跟字符，以及页面级的万元/千元口径词", () => {
  const idx = pageIndex(normalizePage("单位：万元 营收 121,138.73 万元；Amounts in US$ thousands"));
  expect(idx.wan).toBe(true);
  expect(idx.qian).toBe(true);
  expect(idx.toks.find((t) => t.v === 121138.73).next.startsWith("万")).toBe(true);
  expect(pageIndex("单位：元 12,345").qian).toBe(false);
  expect(matchByMagnitude({ raw: "7.24", value: 7.24, tail: "亿元" }, pageIndex("年内收入724,187千元")).hit).toBe(true);
});

// ========== 港股「百萬港元」（2026-09-23） ==========
// 智谱那篇：「313.75 亿港元」配售公告原文「31,374.95百萬港元」、「48.96 亿港元」原文「4,896.2百萬港元」，
// 修前一直挂在待质证里。

test("亿 ↔ 百萬：带单位词、按报告精度比数值——四舍五入对上的算找到（弱档），正好相等的算原样", () => {
  const a = hitOn("313.75", " 亿港元", "配售事項所得款項淨額合共約為31,374.95百萬港元。");
  expect(a.hit).toBe(true);
  expect(a.form).toContain("百萬");
  expect(a.scaled).toBe(true);
  expect(hitOn("48.96", " 亿港元", "全球發售所得款項淨額總計約為4,896.2百萬港元").hit).toBe(true);
  expect(hitOn("48.96", " 亿港元", "所得款項淨額總計約為4,896.2百万港元").hit).toBe(true);   // 简体「百万」
  const c = hitOn("2.789", " 亿元）", "承接總額約為人民幣278.90百萬元之債務");
  expect(c.hit).toBe(true);
  expect(c.scaled).toBeFalsy();
});

test("守卫：百萬档必须紧跟单位词、容差随报告精度走、只管「亿」", () => {
  // 变异验证：去掉「紧跟百萬」，第一条会红（表格里的裸数不在这档管）
  expect(hitOn("313.75", " 亿港元", "所得款項淨額 31,374.95 其他").hit).toBe(false);
  // 变异验证：容差不随 ×100 缩放（仍用 ±0.0245），第二条会红；放得太宽，第三条会红
  expect(baiwanMatch({ raw: "48.96", value: 48.96, tail: " 亿港元" }, "4,896.2百萬港元")).not.toBe(null);
  expect(baiwanMatch({ raw: "48.96", value: 48.96, tail: " 亿港元" }, "4,910.0百萬港元")).toBe(null);
  expect(baiwanMatch({ raw: "950", value: 950, tail: " 万股" }, "9.5百萬股")).toBe(null);
});

// ========== PDF 链接回的不是 PDF（2026-09-23） ==========
// 上交所 static.sse.com.cn 的公告 PDF 链接对脚本回 200 + text/html 的反爬 JS 挑战页，原先报成
// 「缺 pdftotext 或为扫描件」——在 runner 刚补好 pdftotext 之后又报一次「缺 pdftotext」，排查方向全错。

const CHALLENGE = "<html><script>\n        var arg1='A75DE4BCCE331556855C45335D25BFEB6DA39F2F';\n var _0x4818=function(){};</script></html>";

test("链接是 .pdf、回来的是网页：如实报「返回的是网页不是 PDF」，不再提 pdftotext", async () => {
  // 变异验证：改回按后缀送 pdftotext，这条会红
  const f = fakeFetch({ "https://static.sse.com.cn/a/688521_20260711_8Q6V.pdf": { status: 200, body: CHALLENGE } });
  const r = await fetchPage("https://static.sse.com.cn/a/688521_20260711_8Q6V.pdf", { fetchImpl: f });
  expect(r.ok).toBe(false);
  expect(r.note).toBe("返回的是网页不是 PDF（可能是反爬验证页）");
  const g = fakeFetch({ "https://x.com/doc": { status: 200, body: "<!doctype html><p>hi</p>", ct: "application/pdf" } });
  expect((await fetchPage("https://x.com/doc", { fetchImpl: g })).note).toBe("返回的是网页不是 PDF（可能是反爬验证页）");
  const z = fakeFetch({ "https://x.com/b.pdf": { status: 200, body: "PK\u0003\u0004zip", ct: "application/octet-stream" } });
  expect((await fetchPage("https://x.com/b.pdf", { fetchImpl: z })).note).toContain("返回的内容不是 PDF");
});

test("判据是内容本身：文件头 %PDF- 在前 1024 字节内就当 PDF（不管后缀与 content-type）", async () => {
  expect(looksLikePdf(new TextEncoder().encode("%PDF-1.7\n..."))).toBe(true);
  expect(looksLikePdf(new TextEncoder().encode("\r\n\r\n%PDF-1.4"))).toBe(true);
  expect(looksLikePdf(new TextEncoder().encode(CHALLENGE))).toBe(false);
  // 没有 .pdf 后缀、content-type 还写着 html，但内容是 PDF：走 PDF 路径（抽不抽得出取决于本机
  // 有没有 pdftotext、这份假 PDF 能不能解析），无论如何不能报成「网页」
  const f = fakeFetch({ "https://x.com/file?id=1": { status: 200, body: "%PDF-1.4\nnot really a pdf" } });
  const r = await fetchPage("https://x.com/file?id=1", { fetchImpl: f });
  expect(r.ok).toBe(false);
  expect(r.note).toContain("PDF 未能提取文本");
  expect(r.note).not.toContain("网页");
});
