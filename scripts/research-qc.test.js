// scripts/research-qc.test.js
// 守卫 research-qc 的判定口径。**夹具绿不等于真实数据对**（CLAUDE.md）——本文件之外，
// 改动本模块后必须再对 `research/` 全部存量跑一遍 `bun run scripts/research-qc.js`。
// 下面带「变异验证」注释的用例，是把检查改坏后必须变红的那些。

import { test, expect } from "bun:test";
import {
  htmlToText, headings, reportNumbers, truthValues, candidates, reconciliationPower,
  checkNumbers, checkCoverage, checkFormat, runQc, renderReport, renderChallenge,
  hasBlocking, STOCK_SECTIONS, FORBIDDEN_WORDS,
} from "./research-qc.js";

// 齐全的股票报告骨架：章节名取自 STOCK_SECTIONS 的 key（**不抄字面量**——
// 改了常量而夹具没跟着改，会造出「测试绿、真跑红」的假绿）。
function stockHtml(body = "", { sections = STOCK_SECTIONS } = {}) {
  const hs = sections.map((s) => `<h2>${s.key}</h2>`).join("\n");
  return `<html><head><style>.a{font-size:14.5px;margin:32px}</style></head>
<body>${hs}<p>${body}</p></body></html>`;
}

// ========== 文本提取 ==========

test("htmlToText 剥掉 style/script 整块（否则模板 CSS 的数字会淹没数字对账）", () => {
  const t = htmlToText(stockHtml("正文 42.5 亿元"));
  expect(t).toContain("42.5");
  // 变异验证：去掉 style 剥离，下面两条会红
  expect(t).not.toContain("14.5");
  expect(t).not.toContain("32px");
});

test("htmlToText 剥标签连带属性（href 里的 URL 数字不该进正文）", () => {
  const t = htmlToText('<a href="https://x.com/a/998877">链接</a>');
  expect(t).toContain("链接");
  expect(t).not.toContain("998877");
});

test("headings 取 h2/h3 文本", () => {
  expect(headings("<h2>公司快照</h2><h3>子节</h3><p>正文</p>")).toEqual(["公司快照", "子节"]);
});

// ========== 数字提取 ==========

test("reportNumbers 滤掉年份 / 小序号 / 0 与 100（不是事实性数字）", () => {
  const vals = reportNumbers("2026 年第 3 季度，占 100%，营收 55.19 亿").map((n) => n.value);
  expect(vals).toContain(55.19);
  expect(vals).not.toContain(2026);
  expect(vals).not.toContain(3);
  expect(vals).not.toContain(100);
});

test("reportNumbers 剔除 URL / 时间 / 代码围栏里的数字", () => {
  const vals = reportNumbers("见 https://a.com/2222/3333 ，13:39 发布，```{x: 7777}``` 实为 8.88")
    .map((n) => n.value);
  expect(vals).toEqual([8.88]);
});

test("reportNumbers 不把带后缀代码切成数字（02513.HK / v4.2）", () => {
  const vals = reportNumbers("代码 02513.HK 与 v4.2 版本").map((n) => n.value);
  expect(vals).not.toContain(2513);
});

test("reportNumbers 认千分位写法", () => {
  expect(reportNumbers("总额 2,646.93 万").map((n) => n.value)).toContain(2646.93);
});

// ========== 数字对账 ==========

const candVals = (v, t, raw) => candidates(v, t, raw).map((c) => c.v);

test("candidates 按正文里那个数字自己的单位构造候选值", () => {
  expect(candVals(55.19, " 亿元")).toContain(5519000000); // 取数存「元」
  expect(candVals(2283.83, " 万股")).toContain(22838300);
  expect(candVals(50.4, "%——")).toContain(0.504); // 取数存小数比率
});

test("容差按正文写出的精度定：写「262」能对上库里的 262.3", () => {
  // 变异验证：改回固定相对容差（0.001→±0.262），本用例变红——2026-08-15 真跑时
  // 正是这一条把「净利 +262%」（库内 262.3）误报成待核。
  expect(checkNumbers("净利同比 +262%", new Set([262.3]))).toEqual([]);
  expect(checkNumbers("毛利率守住 46% 附近", new Set([46.06]))).toEqual([]);
  // 但写足精度就不该放过：46.99 与 46.06 差得远
  expect(checkNumbers("毛利率 46.99%", new Set([46.06])).length).toBe(1);
});

test("容差随单位换算同倍缩放（缩小后的候选不许沿用绝对容差）", () => {
  // 500.23 的 /1e4 候选是 0.050023。库里的 0.06 与它差 0.01——
  // 按旧写法（缩小后的候选沿用 ±0.011 绝对容差）会被判成「对上」，
  // 而 0.06 与 500.23 其实毫无关系。缩放容差后应判为未对上。
  expect(checkNumbers("某值 500.23", new Set([0.06])).length).toBe(1);
  // 真正对得上的（0.050023 本身）仍要放过
  expect(checkNumbers("某值 500.23", new Set([0.05]))).toEqual([]);
});

test("candidates 每个数字最多 4 个候选——绝不反过来展开真值池", () => {
  // 变异验证：改回「展开真值池」的老做法，本条与下面的判别力用例一起变红。
  // 老做法每个真值扩 32 个变体，数字空间被填满，捏造数字 100% 漏报。
  for (const t of [" 亿元", " 万股", "%", " 元"]) {
    expect(candidates(123.45, t).length).toBeLessThanOrEqual(4);
  }
});

test("reconciliationPower：真值稀疏→判别力高，真值密集→判别力低", () => {
  const nums = [{ value: 100.5, tail: " 亿元" }, { value: 88.2, tail: " 亿元" }];
  const sparse = new Set([100.5, 88.2]);
  expect(reconciliationPower(nums, sparse)).toBeGreaterThan(0.8);

  const dense = new Set();
  for (let v = 0; v < 400; v += 0.05) dense.add(Number(v.toFixed(2)));
  expect(reconciliationPower(nums, dense)).toBeLessThan(0.4);
});

test("reconciliationPower 结果可复现（固定种子，不用 Math.random）", () => {
  const nums = [{ value: 42.5, tail: " 亿元" }];
  const truth = new Set([1, 2, 3, 42.5]);
  expect(reconciliationPower(nums, truth)).toBe(reconciliationPower(nums, truth));
});

test("判别力弱时明说「说明不了问题」，不许把 0 个未对上渲染成已核对", () => {
  const out = renderReport({
    dir: "x", ok: true, blocking: [], review: [], coverage: [],
    numbersTotal: 187, numbersUnmatched: [], dataPresent: true, dataSkipped: [],
    power: 0, truthSize: 28178,
  });
  expect(out).toContain("判别力弱");
  expect(out).toContain("别把它当作数字已核对过");
});

test("checkNumbers：对得上的不报，对不上的报", () => {
  const truth = truthValues('{"close": 34.4585, "mv": 1119000000}');
  const un = checkNumbers("收盘 34.46 元，市值 11.19 亿，另有 987.65 无出处", truth);
  const vals = un.map((u) => u.value);
  expect(vals).toContain("987.65"); // 取数里没有 → 待核
  expect(vals).not.toContain("34.46"); // 四舍五入容差内
  expect(vals).not.toContain("11.19"); // 元→亿元换算
});

test("checkNumbers 同一个值只报一次并计数（不去重清单就没法读）", () => {
  const un = checkNumbers("首处 987.65，正文又写 987.65", truthValues("{}"));
  expect(un.length).toBe(1);
  expect(un[0].count).toBe(2);
});

// ========== 取数点覆盖 ==========

test("checkCoverage：整份取数零命中才点名，命中一个就算用上了", () => {
  const files = [
    { name: "used.json", content: '{"a": 4321.5, "b": 8765.25, "c": 9999.75}' },
    { name: "unused.json", content: '{"a": 1111.25, "b": 2222.5, "c": 3333.75}' },
  ];
  const out = checkCoverage("正文引用了 4321.5", files);
  expect(out.map((c) => c.file)).toEqual(["unused.json"]);
});

test("checkCoverage 探针太少就不下判断（宁可少测，别喊狼来了）", () => {
  expect(checkCoverage("正文无关", [{ name: "thin.json", content: '{"a": 4321.5}' }])).toEqual([]);
});

test("checkCoverage 不拿小整数当探针（1/2/3 满篇都是，等于恒命中）", () => {
  // 探针全是小整数 → 取不出有辨识度的值 → 不报
  expect(checkCoverage("完全无关的正文", [{ name: "s.json", content: '{"a":1,"b":2,"c":3,"d":4}' }]))
    .toEqual([]);
});

// ========== 格式：章节 ==========

test("股票缺章节 → 硬红线；节名写法不同也认（存量有三种写法）", () => {
  const full = checkFormat({ reportHtml: stockHtml(), type: "股票" });
  expect(full.blocking).toEqual([]);

  const variant = stockHtml().replace("<h2>公司快照</h2>", "<h2>公司画像（B）</h2>");
  expect(checkFormat({ reportHtml: variant, type: "股票" }).blocking).toEqual([]);

  const missing = checkFormat({
    reportHtml: stockHtml("", { sections: STOCK_SECTIONS.slice(0, -1) }),
    type: "股票",
  });
  expect(missing.blocking.join()).toContain(STOCK_SECTIONS.at(-1).key);
});

test("非股票类不查 A–M 章节（概念/人物类没有这套框架）", () => {
  expect(checkFormat({ reportHtml: "<h2>随便</h2>", type: "概念" }).blocking).toEqual([]);
});

// ========== 格式：价位红线 ==========

test("操作触发条件用具体价位 → 硬红线", () => {
  const r = checkFormat({ reportHtml: stockHtml("若已持有，跌破 14 元转防御"), type: "股票" });
  expect(r.blocking.join()).toContain("跌破 14 元");
});

test("历史/现状行情陈述不算红线（存量标定出的唯一一类误报）", () => {
  const r = checkFormat({ reportHtml: stockHtml("从 394 元回落，现在回落到 311 元。"), type: "股票" });
  // 变异验证：删掉 PAST_TENSE_NEAR_RE 这条，本用例变红
  expect(r.blocking).toEqual([]);
});

test("券商目标价是别人的观点 → 只列「需判断」，不挡上线", () => {
  const r = checkFormat({ reportHtml: stockHtml("中金给出目标价 688 港元（卖方预期）"), type: "股票" });
  expect(r.blocking).toEqual([]);
  expect(r.review.join()).toContain("目标价");
});

test("大宗商品价不是股价：同句有价格主语 → 不报（2026-08-16 导入存量时标定）", () => {
  for (const s of [
    "国庆后飞天散瓶批价跌破 1369 元则减仓",
    "现货金站稳 4300 美元上方",
    "若面板价跌破 30 美元则重估",
    // 主语与触发词隔着好几个从句——山东黄金那篇的真实写法
    "2026-08-06 现货金收 4308 美元、单日 +4.20% 突破 4300 美元",
  ]) {
    // 变异验证：删掉 COMMODITY_SUBJ_RE 这一判据，四条全变红
    expect(checkFormat({ reportHtml: stockHtml(s), type: "股票" }).blocking).toEqual([]);
  }
});

test("时间状语落在动词后面的行情陈述不算红线（当前 / 现价）", () => {
  const r = checkFormat({ reportHtml: stockHtml("股价从年内高点 65.55 元回落至当前 30.48 元"), type: "股票" });
  expect(r.blocking).toEqual([]);
});

// 2026-08-25：触发词与价位跨了分句边界，就不是「触发词+触发价」的绑定关系。
// 「杀跌容易引发被动止损，但也常对应…支撑区（78–82 元）」——止损在描述**市场上其他人
// 的行为**，78–82 属于逗号另一侧的「成本密集支撑区」，不是止损位。
test("触发词与价位跨分句 → 不算触发价位（止损盘是市场行为描述）", () => {
  const r = checkFormat({
    reportHtml: stockHtml("这类结构下杀跌容易引发被动止损，但也常对应阶段性的成本密集支撑区（78–82 元区间）"),
    type: "股票",
  });
  // 只管 TRIGGER 这条；「78–82 元区间」由 BAND_PRICE_RE 另行判定，不在本用例范围
  expect(r.blocking.join()).not.toContain("具体触发价位");
});

// 守卫：收紧绝不能变成漏报。这句里「回落至」跨了逗号，但真正的触发词「跌破」紧贴价位——
// 正则必须自己往后找到它。若改成「在循环里跳过跨句命中」，lastIndex 已经越过这段，
// 这条真红线就被静默放跑（存量 300620 的真实写法）。
test("跨分句收紧后，正则自己找到真正的触发词，不许漏报", () => {
  const r = checkFormat({
    // 存量 300620 的原文写法（html 里中文与数字之间不带空格）
    reportHtml: stockHtml("如果2026Q3累计净利同比回落至60%以下，或股价收盘跌破筹码成本50%分位251.6元，那么观望或减仓"),
    type: "股票",
  });
  expect(r.blocking.join()).toContain("251.6");
});

// 2026-08-25 从 688008 存量实测抓出的第四类误报：BAND_PRICE_RE 一个豁免都没有
// （TRIGGER 那条有基准价 / 商品价三层），于是 M 节带来源的回购均价被当成三情景预测区间。
// SKILL §4.9 括号里白纸黑字：「客观披露价如回购区间、市值反算依据可保留」。
test("回购均价区间是客观披露 → 不报（§4.9 明文豁免）", () => {
  const r = checkFormat({
    reportHtml: stockHtml("后续 7-29~7-31 已回购 70.50 万股、均价 192.18~210 元区间，来源：新浪财经 2026-08-03"),
    type: "股票",
  });
  expect(r.blocking).toEqual([]);
});

// 守卫⓪：「均价」从商品主语表里拿掉之后，商品价不能跟着变误报——它由主语（金价）与
// 每单位后缀（美元/盎司）两条判据兜着。句子取自存量原文。
// 变异验证：把 COMMODITY_SUBJ_RE 里的「金价」也删掉，本用例变红。
test("商品价不靠「均价」也放行（金价主语 / 每单位后缀兜底）", () => {
  for (const s of [
    "支撑在于 Q2 金价均价同比 +37%，8/6 突破 4300 美元",
    "2026Q2 LBMA 午盘金价均价 4,506.29 美元/盎司、同比上行",
  ]) {
    expect(checkFormat({ reportHtml: stockHtml(s), type: "股票" }).blocking).toEqual([]);
  }
});

// 守卫①：同一句「但不得作为买卖触发条件」——SKILL 那半句必须仍然生效。
test("回购价一旦当买卖触发条件用，豁免不成立 → 照样报", () => {
  const r = checkFormat({
    reportHtml: stockHtml("若跌破回购均价 192.18~210 元区间下沿则减仓"),
    type: "股票",
  });
  expect(r.blocking.join()).toContain("192.18");
});

// 守卫②：豁免窗口必须够窄。同段提过回购，不等于后面那个情景区间也是回购价——
// 用「整句有回购就放行」会把这条真红线一起放跑（这正是「加一层保护先问是不是拆了另一层」）。
test("同句提过回购，不豁免后面的情景预测区间", () => {
  const r = checkFormat({
    reportHtml: stockHtml("公司已完成回购，悲观情景下股价在 150–170 元区间宽幅震荡"),
    type: "股票",
  });
  expect(r.blocking.join()).toContain("150");
});

test("否定式隐私免责不是泄露（每篇都写，误报会让清单失信）", () => {
  const r = checkFormat({ reportHtml: stockHtml("本报告不含任何用户持仓 / 自选 / 账户信息"), type: "股票" });
  expect(r.blocking).toEqual([]);
});

test("否定守卫不越界：真的写了个人持仓照样报", () => {
  const r = checkFormat({ reportHtml: stockHtml("这只票没有大涨，按我的持仓成本价计算仍浮亏"), type: "股票" });
  expect(r.blocking.join()).toContain("私人信息");
});

test("大宗商品价不是股价：带每单位后缀 → 不报", () => {
  const r = checkFormat({ reportHtml: stockHtml("若碳酸锂跌破 6.5 万元/吨则成本端改善"), type: "股票" });
  expect(r.blocking).toEqual([]);
});

test("「元/股」不算商品单位——它就是股价，必须照报", () => {
  const r = checkFormat({ reportHtml: stockHtml("若股价回落至 60 元/股以下则回购恢复"), type: "股票" });
  expect(r.blocking.join()).toContain("60 元");
});

test("商品语境判据不越界：普通触发价位照样报", () => {
  const r = checkFormat({ reportHtml: stockHtml("金价上行背景下，若股价跌破 14 元转防御"), type: "股票" });
  expect(r.blocking.join()).toContain("跌破 14 元");
});

test("客观披露价不带触发语境时不报（基准日收盘是必含项）", () => {
  expect(checkFormat({ reportHtml: stockHtml("基准日收盘 212.75 元"), type: "股票" }).blocking)
    .toEqual([]);
});

// ========== 格式：禁词 ==========

test("禁词一律带上下文报出，且只进「需判断」", () => {
  const r = checkFormat({ reportHtml: stockHtml("我们建议买入该标的"), type: "股票" });
  expect(r.blocking).toEqual([]);
  expect(r.review.join()).toContain("建议买入"); // 变异验证：不带上下文时本条变红
});

test("资金流口径复合词不算禁词（否则每篇都被报一遍）", () => {
  for (const s of ["融资净买入 8.85 亿元", "主力净买入 43.75 亿", "融资买入额创新高"]) {
    expect(checkFormat({ reportHtml: stockHtml(s), type: "股票" }).review).toEqual([]);
  }
});

test("非股票类不查禁词（方法论报告聊交易时「买入」是正常词汇）", () => {
  const r = checkFormat({ reportHtml: "<p>左侧交易在下跌中分批买入</p>", type: "方法论" });
  expect(r.review).toEqual([]);
  expect(r.blocking).toEqual([]);
});

test("FORBIDDEN_WORDS 只含买入/卖出（减仓、回避是允许的）", () => {
  expect(FORBIDDEN_WORDS).toEqual(["买入", "卖出"]);
  expect(checkFormat({ reportHtml: stockHtml("则减仓、回避"), type: "股票" }).review).toEqual([]);
});

// ========== 格式：隐私 ==========

test("个人持仓/账户 → 硬红线（CLAUDE.md 绝对红线）", () => {
  const r = checkFormat({ reportHtml: stockHtml("按我的持仓成本价计算"), type: "股票" });
  expect(r.blocking.join()).toContain("私人信息");
});

test("被研究对象的「持仓理念」不是用户私人信息（存量标定出的误报）", () => {
  const r = checkFormat({ reportHtml: "<p>他公开自己的持仓理念，不卖课</p>", type: "方法论" });
  expect(r.blocking).toEqual([]);
});

test("机构/北向持仓是正常正文，不该被泛匹配误伤", () => {
  const r = checkFormat({ reportHtml: stockHtml("北向持仓上升，机构持仓集中度提高"), type: "股票" });
  expect(r.blocking).toEqual([]);
});

test("「若已持有…跌破 X 元」仍算红线——裸「已」不得被当成过去时（防回归）", () => {
  const r = checkFormat({ reportHtml: stockHtml("若已持有，跌破 14 元转防御"), type: "股票" });
  // 变异验证：把裸「已」加回 PAST_TENSE_NEAR_RE，本用例变红
  expect(r.blocking.join()).toContain("跌破 14 元");
});

test("证券代码不进数字对账（02513.HK / 600519.SH 满篇都是）", () => {
  const vals = reportNumbers("智谱 02513.HK 与贵州茅台 600519.SH").map((n) => n.value);
  expect(vals).toEqual([]);
});

// ========== 格式：首页导语（复用 parse-note 真实抽取器）==========

const NOTE_HEAD = "---\ntype: 股票\n---\n\n# 某股（600519.SH）\n\n## 一句话结论\n\n";

test("导语抽不出 → 硬红线（列表会被真实抽取器跳过）", () => {
  const md = `${NOTE_HEAD}- 列表形态的结论\n- 第二条\n`;
  const r = checkFormat({ reportHtml: stockHtml(), notesMd: md, type: "股票" });
  expect(r.blocking.join()).toContain("导语");
});

test("正常段落导语不报", () => {
  const md = `${NOTE_HEAD}未来约 13 周方向偏震荡：估值处历史高位、基本面尚未兑现，全部悬念压在半年报。\n`;
  const r = checkFormat({ reportHtml: stockHtml(), notesMd: md, type: "股票" });
  expect(r.blocking).toEqual([]);
});

test("导语过短只提醒、不挡（首页会剥掉方向套话句）", () => {
  const md = `${NOTE_HEAD}未来 13 周方向偏跌。\n`;
  const r = checkFormat({ reportHtml: stockHtml(), notesMd: md, type: "股票" });
  expect(r.blocking).toEqual([]);
  expect(r.review.join()).toContain("导语");
});

// ========== 汇总与渲染 ==========

test("runQc fail-open：目录不存在也不抛，且 ok=false", () => {
  const qc = runQc("不存在的目录", "research");
  expect(qc.ok).toBe(false);
  expect(hasBlocking(qc)).toBe(false);
});

test("质检没跑成时明说「未跑完」，绝不渲染成通过", () => {
  const out = renderReport({ dir: "x", ok: false, error: "boom" });
  expect(out).toContain("未跑完");
  expect(out).not.toContain("✅");
});

test("无 data/ 时数字对账写「未跑」，不说「一致」", () => {
  const out = renderReport({
    dir: "x", ok: true, blocking: [], review: [], coverage: [],
    numbersTotal: 0, numbersUnmatched: [], dataPresent: false, dataSkipped: [],
  });
  expect(out).toContain("未跑");
  expect(out).not.toContain("数字对账：正文");
});

test("renderChallenge 无发现返回空串（别硬造质证点诱导乱改）", () => {
  expect(renderChallenge({
    ok: true, blocking: [], review: [], coverage: [], numbersUnmatched: [],
  })).toBe("");
});

test("renderChallenge 把未用取数点与待核数字交到核验员手上", () => {
  const c = renderChallenge({
    ok: true, blocking: [], review: [],
    coverage: [{ file: "k.json", probes: ["1", "2"] }],
    numbersUnmatched: [{ value: "9.87", context: "…ctx…", count: 1 }],
  });
  expect(c).toContain("k.json");
  expect(c).toContain("9.87");
  expect(c).toContain("绝不许补编");
});
