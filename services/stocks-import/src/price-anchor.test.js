// services/stocks-import/src/price-anchor.test.js
// 守卫「把带锚价位里的数值删掉」这条改写。判定口径必须与 research-qc 的价位红线**同面**：
// 改写器只动 QC 会报的那些，改完必须能过 QC——所以关键用例直接拿 checkFormat 断言，
// 而不是只比字符串（夹具绿不等于真跑绿，CLAUDE.md）。
import { test, expect } from "bun:test";
import { stripAnchoredPrice, stripAnchoredPriceDeep } from "./price-anchor.js";
import { checkFormat, STOCK_SECTIONS } from "../../../scripts/research-qc.js";

const stockHtml = (body) =>
  `<html><body>${STOCK_SECTIONS.map((s) => `<h2>${s.key}</h2>`).join("")}<p>${body}</p></body></html>`;
const blocking = (t) => checkFormat({ reportHtml: stockHtml(t), type: "股票" }).blocking;

// 真实存量原文（2026-08-25 那四篇搁置报告），改写后必须过 QC。
const REAL = [
  "筹码面上，站上 8/7 成本 15 分位 64.00 元后有望向中位成本 70.00 元推进",
  "股价向上突破 8-07 筹码的 85% 分位成本  70.80 元 一带（置信度：中）",
  "如果库内行情价格跌破 8-07 筹码的 50% 分位成本 54.00 元，且近 20 日特大单净流出",
  "股价先修复至筹码加权均本一线，站稳后向 85% 成本线 277.40 元的深套区试压",
  "现价已站上当时的 85 分位成本 289.00 元——按那份分布，眼下几乎全部持仓都在浮亏",
  "股价站上成本15分位64.00元后向中位成本70.00元推进，70元密集套牢区为第一道阻力",
];

test("真实存量原文：改写后一条硬红线都不剩（与 QC 同面）", () => {
  for (const s of REAL) {
    expect(blocking(s).length).toBeGreaterThan(0);              // 前提：原文确实踩线
    expect(blocking(stripAnchoredPrice(s).text)).toEqual([]);   // 改写后过闸
  }
});

test("只删数值、锚与判断一字不动", () => {
  const r = stripAnchoredPrice("如果库内行情价格跌破 8-07 筹码的 50% 分位成本 54.00 元，那么减仓");
  expect(r.text).toContain("跌破 8-07 筹码的 50% 分位成本");
  expect(r.text).toContain("那么减仓");
  expect(r.text).not.toContain("54.00");
});

test("数值在前、锚在括号里的写法，压成「触发词+锚」", () => {
  const r = stripAnchoredPrice("如果股价放量跌破 42.0 元（50 分位成本），那么减仓");
  expect(r.text).toContain("跌破 50 分位成本");
  expect(r.text).not.toContain("42.0");
  expect(blocking(r.text)).toEqual([]);
});

test("没有锚的裸价位不动——改写器不猜，交给 QC 拦下人工处理", () => {
  const s = "路径：估值向行业中位回归，跌破54.00元";
  expect(stripAnchoredPrice(s).text).toBe(s);
  expect(blocking(s).length).toBeGreaterThan(0);
});

test("客观披露价不动（收盘价 / 回购区间 / H 节筹码刻度）", () => {
  for (const s of [
    "B 节：基准日 2026-08-07 收盘 212.75 元，换手率 3.2%",
    "已回购 70.50 万股、均价 192.18~210 元区间，来源：新浪财经",
    "H 节筹码分布：15% 分位 54.00 元、50% 分位 64.00 元、85% 分位 70.80 元",
  ]) {
    expect(stripAnchoredPrice(s).text).toBe(s);
  }
});

test("每处改动都记进 changes，便于导入日志复核", () => {
  const r = stripAnchoredPrice("站上 8/7 成本 15 分位 64.00 元后，跌破 85% 成本线 70.80 元则回避");
  expect(r.changes.length).toBe(2);
  expect(r.changes[0]).toHaveProperty("from");
  expect(r.changes[0]).toHaveProperty("to");
});

test("深度版：递归处理 summary_json 那种嵌套对象，changes 汇总", () => {
  const r = stripAnchoredPriceDeep({
    scenarios: {
      base: { trigger: "如果跌破 50% 分位成本 54.00 元", path: "向下寻求支撑" },
      bull: { trigger: "站上 85% 成本线 70.80 元", path: "题材共振" },
    },
    note: "不含触发词的 H 节刻度：50% 分位 54.00 元",
  });
  expect(r.value.scenarios.base.trigger).toBe("如果跌破 50% 分位成本");
  expect(r.value.scenarios.bull.trigger).toBe("站上 85% 成本线");
  expect(r.value.note).toBe("不含触发词的 H 节刻度：50% 分位 54.00 元"); // 无触发词，不动
  expect(r.changes.length).toBe(2);
});

test("数值被 HTML 标签裹着时整处跳过——改写器只处理 markdown 源，不许改坏 HTML", () => {
  // 2026-08-26 实测踩到：把改写器直接用在已生成的 report.html 上，
  // 「分位成本 <strong>70.80 元</strong>」被改成「分位成本 <strong>」，留下一个孤立开标签。
  // 宁可不改（QC 会照常拦下搁置），也不能产出结构损坏的页面。
  const s = "股价向上突破 8-07 筹码的 85% 分位成本 <strong>70.80 元</strong> 一带";
  const r = stripAnchoredPrice(s);
  expect(r.text).toBe(s);
  expect(r.changes).toEqual([]);
});

test("同句多个带锚价位要全部删干净——删掉前一个会让后一个落进匹配窗口", () => {
  // 2026-08-25_runze-tech-300442 真实原文。第一版改写器只跑一遍，删掉 64.00 元之后
  // 「站上」与「70.00 元」的距离缩短、反而落进了 24 字窗口，QC 照样拦下。
  const r = stripAnchoredPrice("筹码面上，站上 8/7 成本 15 分位 64.00 元后有望向中位成本 70.00 元推进");
  expect(r.text).not.toContain("64.00");
  expect(r.text).not.toContain("70.00");
  expect(blocking(r.text)).toEqual([]);
});

test("绝不碰改动处以外的空白——缩进在 markdown 里是有语义的", () => {
  // 2026-08-26 实测踩到：收尾那句全文 /[ \t]{2,}/ 压缩，把整个 report.html 的缩进压平了
  // （只删 2 个数值，diff 却有 376 行）。markdown 源更糟：代码块与嵌套列表全靠缩进。
  const src = [
    "- 情景：",
    "    - 乐观｜触发：跌破 50% 分位成本 54.00 元",
    "```",
    "    保留   这里的   多空格",
    "```",
  ].join("\n");
  const r = stripAnchoredPrice(src);
  expect(r.text).toContain("    - 乐观｜触发：跌破 50% 分位成本");  // 列表缩进原样
  expect(r.text).toContain("    保留   这里的   多空格");           // 代码块原样
  expect(r.text).not.toContain("54.00");
});

// 2026-09-01 两篇（002903 宇环数控 / 300583 赛托生物）被搁置的真实原文。根因不是 Stocks
// 写错了——它完全按自己的 SKILL 写了「锚在前、数值紧跟其后」，是这边的锚词表只收了
// 「均线」「低点」这类**概念名**，认不出 `MA20`、「最低」、「收盘」这些**人真正会写的形式**，
// 于是有锚也被当成裸价位放过。触发词表同样漏了「失守」（QC 那边一并补了，两表同面）。
const REAL_2026_09_01 = [
  "如果回落至MA20 29.24元下方且苹果发布会后两周无订单公告那么回避",
  "如果跌破9-01当日最低13.81元且大涨仍不可归因那么观望不追高",
  "如果跌破8-31收盘12.97元那么回避",
  "题材溢价快速收缩，先失守MA20 29.24元",
];

test("2026-09-01 两篇真实原文：锚的实际写法（MA20/最低/收盘）与「失守」都认得出", () => {
  for (const s of REAL_2026_09_01) {
    expect(blocking(s).length).toBeGreaterThan(0);            // 前提：原文确实踩线
    expect(blocking(stripAnchoredPrice(s).text)).toEqual([]); // 改写后过闸
  }
});

test("锚被保留、只掉数值——剥完仍读得懂是哪条线", () => {
  expect(stripAnchoredPrice("如果回落至MA20 29.24元下方那么回避").text)
    .toBe("如果回落至MA20下方那么回避");
  expect(stripAnchoredPrice("如果跌破9-01当日最低13.81元那么观望").text)
    .toBe("如果跌破9-01当日最低那么观望");
});

// 反向守卫：客观陈述（无触发词）不许被动。B 节「由此反推：8-31 收盘 12.97 元」是行情事实，
// 读者要靠它知道锚对应哪个数——扩锚词表时若把「收盘」「最低」写成无条件匹配，这段会被削掉。
test("无触发词的客观行情陈述一个字不动", () => {
  const objective =
    "由此反推：8-31 收盘 12.97 元、今日最高 14.99 元、最低 13.81 元（据库内行情推算）";
  expect(stripAnchoredPrice(objective).text).toBe(objective);
  const ma = "截至 2026-08-31：MA5 30.19 元、MA20 29.24 元、MA60 34.65 元（据日 K 收盘价推算）";
  expect(stripAnchoredPrice(ma).text).toBe(ma);
});
