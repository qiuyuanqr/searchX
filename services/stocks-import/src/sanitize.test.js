import { test, expect } from "bun:test";
import {
  sanitize, mapTerms, mapCodeSpan, mapBareIdentifiers, isInternalSentence,
  splitSentences, stripPreamble, tidyLine,
} from "./sanitize.js";

// ========== 术语映射 ==========

test("取数函数名换成中文口径名，而不是删掉（溯源信息不能丢）", () => {
  expect(mapCodeSpan("financials_recent")).toBe("库内财务");
  expect(mapCodeSpan("industry_peers(\"603009\", n=3)")).toBe("库内同业对比（取 3 家）");
  expect(mapCodeSpan("broker_view.titles")).toBe("库内研报");
});

test("取数窗口参数翻成中文后缀（否则两次不同窗口的调用会变成同一个词）", () => {
  // 走整条流水线：mapTerms 只做替换，中英之间的空格由 tidyLine 收
  const { md } = sanitize("# T\n\n`recent_news(days=60)` 与 `recent_news(days=180)` 均返回空。\n");
  expect(md).toContain("库内新闻（近 60 日）与库内新闻（近 180 日）均返回空。");
});

test("SQL / 源码路径整块抹掉；库表名与取数模块给中文读法（删了会把句子读断）", () => {
  expect(mapCodeSpan("SELECT MAX(d2.trade_date) FROM daily_basic")).toBeNull();
  expect(mapCodeSpan("lib/stock_research.py:346-353")).toBeNull();
  expect(mapCodeSpan("event_id=28740")).toBeNull();
  expect(mapCodeSpan("daily_basic")).toBe("行情库");
  expect(mapCodeSpan("lib.stock_research")).toBe("库内取数");
});

test("删标记时把跟在后面的「的」一并带走（防「与的『汽车配件』不一致」）", () => {
  // 库表名有中文读法，句子照样通顺（中英之间的空格由 tidyLine 收）
  const { md } = sanitize("# T\n\n涨停池标签是「专用设备」，与 `stock_basic` 的「汽车配件」不一致。\n");
  expect(md).toContain("与库内基础资料的「汽车配件」不一致");
  // 没有中文读法、只能删掉的标记，跟在后面的「的」也要一起带走
  expect(mapTerms("与 `event_id=28740` 的记录对不上")).toBe("与记录对不上");
});

test("标签与原文同义词撞成叠词时收敛（数据时点 数据时点 → 数据时点）", () => {
  const { md } = sanitize("# T\n\n`quote_brief` 数据时点 `as_of=16:29`（收盘后快照）。\n");
  expect(md).toContain("库内行情数据时点 16:29");
  expect(md).not.toContain("数据时点数据时点");
});

test("叠词收敛只认本模块产出的标签，不做通用重复词合并", () => {
  // 「一步一步」这类正常表达不能被动
  expect(mapTerms("产能是一步一步爬上来的")).toBe("产能是一步一步爬上来的");
});

test("取数模块后面跟着「函数」二字时不留「库内取数函数」这种半成品", () => {
  // mapTerms 只做替换，中英之间的空格留给 tidyLine
  expect(mapTerms("全部数字来自 `lib.stock_research` 函数返回值")).toBe("全部数字来自 库内取数返回值");
  expect(sanitize("# T\n\n全部数字来自 `lib.stock_research` 函数返回值。\n").md)
    .toContain("全部数字来自库内取数返回值。");
});

test("字段=值保留值（值有信息，字段名没有）", () => {
  expect(mapCodeSpan("end_date=20260331")).toBe("报告期 20260331");
  expect(mapCodeSpan("pe_ttm = null")).toBe("PE(TTM)");
});

test("抹掉标记后留下的空括号与孤立顿号一并收干净", () => {
  expect(mapTerms("行业中位 72.71 倍（`valuation_brief`，`ts_code`）"))
    .toBe("行业中位 72.71 倍（库内估值）");
});

test("裸标识符（没写在反引号里的）同样要换掉", () => {
  expect(mapBareIdentifiers("跌破 cost_85pct = 70.20 元")).toBe("跌破 85% 分位筹码成本 = 70.20 元");
});

test("URL 里的下划线串绝不能动（换了就是把链接改坏）", () => {
  const line = "见 [报道](https://x.com/a/t20250611_2594306?src=close_pe_ttm)";
  expect(mapBareIdentifiers(line)).toBe(line);
});

// ========== 整句剔除 ==========

test("讲索引 / 执行计划 / 主机 / 源码的句子整句删", () => {
  for (const s of [
    "根因是该函数对 daily_basic 使用相关子查询，ts_code 上无独立索引。",
    "EXPLAIN QUERY PLAN 显示外层是 SCAN d1，全表扫描 4,261,869 行。",
    "补法：在 Mac mini 上重跑该函数。",
    "库内同业对比在本机库上连续跑 21 分钟未返回，已终止。",
  ]) expect(isInternalSentence(s)).toBe(true);
});

test("真实的数据缺口陈述与免责声明**不**算系统内部叙述（实测标定出的两类误伤）", () => {
  for (const s of [
    "库内事件日历未返回任何解禁项。",
    "这些公司的财务数据本次未查，不对它们的基本面作任何陈述。",
    "本库无任何产量 / 出货量 / 分部营收字段。",
    "联网检索「北特科技 7 月涨停 消息」亦未返回具体催化。",
  ]) expect(isInternalSentence(s)).toBe(false);
});

test("裸 CPU 不算系统词——海光信息是一家做 CPU 的公司（防回归）", () => {
  expect(isInternalSentence("CPU + DCU 双线，且 CPU 侧生态壁垒真实存在。")).toBe(false);
  expect(isInternalSentence("进程 100% CPU 持续占用，最终被手动终止。")).toBe(true);
});

test("「切换成本机理」不得被「本机」跨词命中（防回归）", () => {
  expect(isInternalSentence("这是本行业最真实的一层壁垒（切换成本机理属行业常识）。")).toBe(false);
  expect(isInternalSentence("该函数在本机库上不可用。")).toBe(true);
});

test("句子切分保留句末标点，拼回后与原文一致", () => {
  const s = "第一句。第二句；第三句！";
  expect(splitSentences(s).join("")).toBe(s);
});

// ========== 结构处理 ==========

test("剥掉正文前的跑批自述，正文从第一个标题开始", () => {
  const md = "本机：qiuyuanmacmini（数据/服务主机）。以下是报告全文。\n\n---\n\n# 某公司（000001）\n\n正文";
  expect(stripPreamble(md).startsWith("# 某公司")).toBe(true);
});

test("整节剔除：末尾的「交付前机器质检」是流水线自检，不是报告内容", () => {
  const md = "# 标题\n\n## A. 结论\n\n有用的话\n\n### ⚙️ 交付前机器质检\n\n- 判别力 92%\n- `abc_def` 截断引文\n\n## B. 快照\n\n保留";
  const { md: out } = sanitize(md);
  expect(out).toContain("有用的话");
  expect(out).toContain("保留");
  expect(out).not.toContain("判别力");
  expect(out).not.toContain("机器质检");
});

test("围栏代码块原样保留（靠空格对齐的产业链图），但里面的函数名照样要换", () => {
  const md = "# T\n\n```\n上游：原料\n        ↓  毛利率（`financials_recent` 2026H1）\n下游：客户\n```\n";
  const { md: out } = sanitize(md);
  expect(out).toContain("        ↓");          // 缩进没被收敛
  expect(out).toContain("库内财务");
  expect(out).not.toContain("financials_recent");
});

test("落单的 ** 会被收掉（整句删完后剩半边加粗记号会直出星号）", () => {
  expect(tidyLine("**只剩半边加粗")).toBe("只剩半边加粗");
  expect(tidyLine("**完整加粗**")).toBe("**完整加粗**");
});

test("只剩标记的列表项（补法/根因）在整句删完后一并丢掉", () => {
  const md = "# T\n\n- **补法**：给 daily_basic 加索引后重跑。\n- 这条要留下。\n";
  const { md: out } = sanitize(md);
  expect(out).not.toContain("补法");
  expect(out).toContain("这条要留下");
});

test("紧跟标题的悬空承接词去掉（被删的往往正是「所以」的那个前提）", () => {
  const md = "# T\n\n## D. 竞争格局\n\n因此本节改用行业分位数据作答。\n";
  const { md: out } = sanitize(md);
  expect(out).toContain("本节改用行业分位数据作答。");
  expect(out).not.toContain("因此本节");
});

test("正文中间的承接词不动（只收拾紧跟标题的那个）", () => {
  const md = "# T\n\n## D. 竞争格局\n\n第一句在这里。\n\n因此可以得出结论。\n";
  expect(sanitize(md).md).toContain("因此可以得出结论。");
});

test("sanitize 报告删了哪些句子（供人抽查，不能悄悄删）", () => {
  const md = "# T\n\n正常结论。根因是相关子查询走不了索引。\n";
  const { dropped } = sanitize(md);
  expect(dropped.length).toBe(1);
  expect(dropped[0]).toContain("相关子查询");
});
