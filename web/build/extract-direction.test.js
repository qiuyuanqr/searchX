import { test, expect } from "bun:test";
import { extractDirection, stripLeadBoilerplate } from "./extract-direction.js";

test("extractDirection：存量真实导语的方向短语与分类", () => {
  const cases = [
    ["未来约 13 周方向偏弱、震荡偏跌，置信度中。政策题材已被完整买涨又卖光。", "down", "偏弱"],
    ["未来约 13 周方向偏跌、震荡偏弱（下行风险为主），置信度中。", "down", "偏跌"],
    ["未来 13 周方向：高位震荡转跌（基准情景约 50%）。业绩高增但估值极端。", "down", "高位震荡转跌"],
    ["未来 ~13 周方向判断：震荡偏中性，上下空间均不对称地大。", "flat", "震荡偏中性"],
    ["未来 13 周方向偏涨但波动放大（基准 50%）。二次定价集中在三个节点。", "up", "偏涨但波动放大"],
    ["未来 13 周方向偏震荡偏强、高波动（基准 55%）。基本面真扎实。", "up", "偏震荡偏强"],
    ["未来 13 周 震荡偏强为基准：基本面 2026Q1 转亏。", "up", "震荡偏强"],
    ["未来约 13 周方向：震荡（略偏弱），置信度中（基准约 50%）。", "down", "震荡·略偏弱"],
    ["未来 13 周方向：偏跌 / 高位震荡偏空（置信度中）。", "down", "偏跌"],
  ];
  for (const [tldr, cls, label] of cases) {
    const d = extractDirection(tldr);
    expect(d?.cls).toBe(cls);
    expect(d?.label).toBe(label);
  }
});

test("extractDirection：箭头跟随分类", () => {
  expect(extractDirection("方向偏涨。").arrow).toBe("↗");
  expect(extractDirection("方向偏跌。").arrow).toBe("↘");
  expect(extractDirection("方向震荡。").arrow).toBe("↔");
});

test("extractDirection：方向落在第二句时也认（须「未来/方向」引导 + 强方向短语）", () => {
  const d = extractDirection("一只基本面扎实、但被题材推到历史极端估值的股票。未来 3 个月震荡偏弱、高波动，估值回归主导。");
  expect(d?.cls).toBe("down");
  expect(d?.label).toBe("震荡偏弱");
});

test("extractDirection：第一二句都没有合格方向短语 → null（正文里的行情词不误命中）", () => {
  // 第二句「震荡走弱」是行情描述：非强方向短语（裸「震荡」+ 无「偏」），不算
  expect(extractDirection("阳光电源做两件事：光伏逆变器 + 储能系统。近期股价震荡走弱。")).toBe(null);
  // 第二句有强短语但没有「未来/方向」引导，同样不算
  expect(extractDirection("公司主业稳定。同业普遍震荡偏弱。")).toBe(null);
  expect(extractDirection("")).toBe(null);
  expect(extractDirection(null)).toBe(null);
});

test("stripLeadBoilerplate：剥掉开头方向套话句与置信度/免评级碎片", () => {
  expect(stripLeadBoilerplate(
    "未来约 13 周方向偏弱、震荡偏跌，置信度中。政策题材（工业 5G 专网）已被完整买涨又卖光、主力资金逐日净流出。"
  )).toBe("政策题材（工业 5G 专网）已被完整买涨又卖光、主力资金逐日净流出。");
  expect(stripLeadBoilerplate(
    "未来 13 周方向偏震荡偏强、高波动（基准 55% / 乐观 30% / 悲观 15%）。基本面真扎实且 Q 布已有一手收入。不给目标价 / 不给评级，操作一律条件式。"
  )).toBe("基本面真扎实且 Q 布已有一手收入。");
});

test("stripLeadBoilerplate：剥完剩太短则返回原文（导语只有方向句时不清空）", () => {
  const only = "未来 13 周方向：高位震荡转跌（基准情景约 50%）。";
  expect(stripLeadBoilerplate(only)).toBe(only);
});

test("stripLeadBoilerplate：没有套话的导语原样返回", () => {
  const t = "金刚石在 AI 里真正落地的只有散热一条线。";
  expect(stripLeadBoilerplate(t)).toBe(t);
});

test("stripLeadBoilerplate：中段的「信息截止」纪律行与悬着的方向句也剥，且剥到句读即止", () => {
  expect(stripLeadBoilerplate(
    "园区级数据中心批发龙头，算力基础设施层 Tier-0。信息截止 2026-06-04（北京时间）。未来 13 周方向：震荡（催化兑现则偏多）；关注上架率与中报。"
  )).toBe("园区级数据中心批发龙头，算力基础设施层 Tier-0。关注上架率与中报。");
  // 分号后的真内容不能被方向句剥除误伤
  expect(stripLeadBoilerplate(
    "一只被题材推到极端估值的股票。未来 3 个月震荡偏弱、高波动；真正贡献业绩的只有 MLCC 等少数业务。"
  )).toBe("一只被题材推到极端估值的股票。真正贡献业绩的只有 MLCC 等少数业务。");
});
