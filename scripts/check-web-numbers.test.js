// scripts/check-web-numbers.test.js
// 守卫联网数字回链核验的判定口径。**夹具绿不等于真实数据对**（CLAUDE.md）——改动本模块后
// 必须再对真实归档跑一遍 `bun run scripts/check-web-numbers.js --dir <某篇>`，看清单还读不读得懂。
// 带「变异验证」注释的用例，是把检查改坏后必须变红的那些。

import { test, expect } from "bun:test";
import {
  stripTags, blocksWithLinks, citedNumbers, numberVariants, containsNumber,
  normalizePage, looksUnrendered, matchNumberInPages, planChecks, classify,
  renderReport, renderChallenge, pageNumbers, scaledCandidates, matchPower,
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
  // 密集页：间隔 200 的网格，比容差还细——招股书那种满篇数字的页面就是这个形态
  // 用「元」而不是空格分隔：normalizePage 会去掉全部空白，空格分隔的话整片数字会连成一串
  const dense = normalizePage(Array.from({ length: 12000 }, (_, i) => `${100000 + i * 200}元`).join(""));
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
