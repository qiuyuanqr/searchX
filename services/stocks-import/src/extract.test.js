import { test, expect } from "bun:test";
import {
  pickOneLiner, pickMainBusiness, pickLinks, pickDate, pickTextSources,
  classifySource, pickGlossary,
} from "./extract.js";

test("一句话逻辑：A 节 BLUF 里最凝练的那句", () => {
  expect(pickOneLiner("**一句话逻辑**：中报的漂亮是后视镜。\n其它")).toBe("中报的漂亮是后视镜。");
  expect(pickOneLiner("没有这一行")).toBe("");
});

test("主营必须锚在行首标签上（正文里提到「主营」的句子不算）", () => {
  expect(pickMainBusiness("- **主营（库内原文）**：「视窗防护玻璃的研发」"))
    .toBe("视窗防护玻璃的研发");
  // 防回归：这句含「主营」但不是业务描述
  expect(pickMainBusiness("1. **2026Q1 的利润不是主营挣来的**：营收 11.12 亿")).toBe("");
});

test("外链按出现顺序去重，带链接文字", () => {
  const md = "见 [央广网 2026-07-08](https://a.example/x) 与 [同一条](https://a.example/x)";
  expect(pickLinks(md)).toEqual([{ url: "https://a.example/x", text: "央广网 2026-07-08" }]);
});

test("来源日期从链接文字里抽，抽不到就留空（不拿报告日期冒充）", () => {
  expect(pickDate("央广网 2026-07-08")).toBe("2026-07-08");
  expect(pickDate("OFweek 显示网 2026-07")).toBe("2026-07");
  expect(pickDate("财联社（郭明錤爆料）")).toBe("");
});

test("文字出处：显式「（来源：X；Y）」按分号拆条", () => {
  const got = pickTextSources("（来源：新浪财经 2026-07-05；证券时报 2026-07-06）");
  expect(got).toEqual(["新浪财经 2026-07-05", "证券时报 2026-07-06"]);
});

test("文字出处：不带「来源：」标签的「媒体名 + 日期」也算", () => {
  expect(pickTextSources("（同花顺 2026-05-21；搜狐财经 2026-04-29 披露预案）"))
    .toEqual(["同花顺 2026-05-21", "搜狐财经 2026-04-29 披露预案"]);
});

test("文字出处：光有日期、没有出处词的括号不算来源（防误收）", () => {
  expect(pickTextSources("（截至 2026-08-14 收盘）")).toEqual([]);
  expect(pickTextSources("（库内估值，2026-08-14）")).toEqual([]);
});

test("文字出处：已作为链接文字收过的不重复计数", () => {
  const md = "[央广网 2026-07-08](https://a.example/x)（来源：央广网 2026-07-08）";
  expect(pickTextSources(md, ["央广网 2026-07-08"])).toEqual([]);
});

test("来源分类：先看体裁词，再看域名", () => {
  expect(classifySource("上交所监管问询函", "https://x.example")).toBe("监管");
  expect(classifySource("2026 年半年度业绩预告公告", "https://x.example")).toBe("披露");
  expect(classifySource("国金证券研报：买入", "https://x.example")).toBe("研究");
  expect(classifySource("某标题", "http://static.cninfo.com.cn/a.PDF")).toBe("披露");
  expect(classifySource("某讨论", "https://xueqiu.com/1/2")).toBe("社区");
  expect(classifySource("某报道", "https://finance.sina.com.cn/x")).toBe("媒体");
});

test("名词小抄只收报告里真出现过的术语", () => {
  const g = pickGlossary("PB 1.58 倍、毛利率 15.6%");
  const terms = g.map(([t]) => t);
  expect(terms).toContain("PB");
  expect(terms).toContain("毛利率");
  expect(terms).not.toContain("限售解禁");
});
