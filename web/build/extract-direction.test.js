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

// ── 冒号接续形态（2026-07-31 审查）─────────────────────────────────
// SKILL 钉死的格式是「第一句给方向，随后讲差异化理由」，但作者普遍写成
// 「未来约 13 周方向偏X：理由一，理由二；理由三。」这种冒号长句。
// 老实现的 [^。；]* 会一路吃到第一个句号，把冒号后的全部核心理由一并吞掉——
// 实测存量 4 篇股票卡的首页导语因此被掏空或从半截转折句开头。
test("方向句用冒号携带理由：只剥到冒号，理由全部保留", () => {
  const tldr = "未来约 13 周方向偏跌：市净率约 26 倍、市盈率 900 倍以上的极端估值，叠加 89.82% 的资产负债率；主力资金持续净流出。";
  const out = stripLeadBoilerplate(tldr);
  expect(out.startsWith("市净率约 26 倍")).toBe(true);
  expect(out).toContain("89.82%");
  expect(out).toContain("主力资金持续净流出");
});

test("方向句不带冒号：整句照旧剥掉（不回归）", () => {
  const tldr = "未来约 13 周方向偏跌。基本面恶化叠加估值透支是下行主线。";
  expect(stripLeadBoilerplate(tldr)).toBe("基本面恶化叠加估值透支是下行主线。");
});

test("导语几乎只有方向句：兜底也要清掉置信度套话，不整段回流首页", () => {
  const tldr = "未来约 13 周方向偏跌。整体置信度：中。不给目标价与买卖评级。";
  const out = stripLeadBoilerplate(tldr);
  expect(out).not.toContain("置信度");
  expect(out).not.toContain("不给目标价");
});

// ── 首句里的裸「震荡」不截胡真方向 ────────────────────────────────
test("首句先出现行情描述里的「震荡」，方向仍按后面的「偏涨」判定", () => {
  const d = extractDirection("近期股价震荡整理，未来约 13 周方向偏涨：产能释放在即。");
  expect(d.cls).toBe("up");
  expect(d.arrow).toBe("↗");
});

test("首句只有裸「震荡」时仍判 flat（别把判定做过头）", () => {
  const d = extractDirection("未来约 13 周方向震荡。");
  expect(d.cls).toBe("flat");
  expect(d.arrow).toBe("↔");
});

// ── 条件方向不能盖过基准判断（2026-07-31 第二轮审查）───────────────
// 首轮为修「描述句里的裸震荡截胡真方向」加了「非震荡优先」，但那是全局偏好：
// 「未来 13 周方向震荡，若中报超预期则偏涨」里基准是震荡、偏涨只是条件分支，
// 非震荡优先会把徽章标成与结论相反的 ↗。
test("首句「方向震荡，若…则偏涨」：徽章取基准的震荡，不取条件分支", () => {
  expect(extractDirection("未来 13 周方向震荡，若 8 月中报超预期则偏涨。").cls).toBe("flat");
  expect(extractDirection("未来约 13 周方向偏跌，若政策转向则偏涨。").cls).toBe("down");
});

test("锚不到声明词时仍走原兜底：描述句里的裸震荡不截胡真方向", () => {
  expect(extractDirection("近期股价震荡整理，未来约 13 周方向偏涨：产能释放在即。").cls).toBe("up");
});
