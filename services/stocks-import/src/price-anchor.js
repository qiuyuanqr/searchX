// services/stocks-import/src/price-anchor.js
// 把「操作触发条件里的价位」删成只剩相对锚：`跌破 50% 分位成本 54.00 元` → `跌破 50% 分位成本`。
//
// 为什么要有这层：Stocks 的报告是**私人**的，写具体价位是有用的操作参考；searchX 是**公开站**，
// 同一句话落到公开页面上就成了对公众的买卖指令（stock SKILL §4.9：价位红线的边界是「用途」
// 不是数字本身）。两边规则不对齐是有道理的，所以不去改 Stocks 的写作口径，在导入这一步转换。
//
// 与 index.js 里 PRICE_REDLINE_FIXES 那张明表的分工：明表是首批 25 篇导入时逐条手列的历史遗留
// （精确到 reportId + 原文），继续保留；这里处理的是**有相对锚**的通用形态——锚（筹码分位成本、
// 成本线、均本）本身是可复现的客观刻度，数值只是它在当期的快照，删掉数值判断一点不变。
//
// **没有锚的裸价位一律不动**（`跌破54.00元`）：改写器不猜。那种交给 QC 拦下、搁置人工处理——
// 猜错了就是替别人改判断，比搁置更糟。
//
// 每处改动都记进 changes 并由导入流程打进日志：改的是别人报告里的字，必须看得见、可复核
// （这条要求来自 PRICE_REDLINE_FIXES 的原注释，通用规则同样适用）。

// 触发词表与 research-qc.js 的 TRIGGER_PRICE_RE **必须同面**：改写器只动 QC 会报的那些，
// 改完才保证过闸。改这里之前先看那边（两处都改，测试用 checkFormat 直接钉着）。
const TRIGGER = "突破|跌破|站上|站稳|回落至|回落到|下探至|上探至|回踩至|回踩|回调至|回测|测试|止损|止盈";
// 相对锚：可复现的客观刻度。没有这些词就是裸价位，不动。
const ANCHOR = "成本|分位|成本线|均本|中枢|均线|支撑位|压力位|低点|高点|授予价|回购上限";
const NUM = String.raw`\d[\d,]*(?:\.\d+)?\s*(?:元|港元|美元|港币)`;
// 中间段不许跨分句边界——理由同 research-qc 那条：跨过逗号，价位就不再是触发词的宾语。
const GAP = String.raw`[^。；！？\n，,、（）()]*?`;

// 形态一：触发词 + 锚 + 数值（`站上 8/7 成本 15 分位 64.00 元`）。删掉数值。
const ANCHOR_THEN_PRICE = new RegExp(`(${TRIGGER})(${GAP}(?:${ANCHOR})${GAP})\\s*${NUM}`, "g");
// 形态二：触发词 + 数值 +（锚）（`跌破 42.0 元（50 分位成本）`）。压成触发词 + 锚。
const PRICE_THEN_ANCHOR = new RegExp(`(${TRIGGER})\\s*${NUM}\\s*[（(]([^）)]*(?:${ANCHOR})[^）)]*)[）)]`, "g");

// 匹配范围里出现 HTML 标签就整处跳过。改写器的输入应当是 markdown 源（导入流程给的就是），
// 一旦被误用在已生成的 report.html 上，「分位成本 <strong>70.80 元</strong>」会被削成
// 「分位成本 <strong>」——留下孤立开标签，页面结构就坏了（2026-08-26 清存量时真踩到）。
// 宁可不改：QC 会照常把它拦下搁置，人工处理比产出坏页面强。
const HAS_TAG = /<[^>]+>/;

// 反复跑到不动点。一遍不够：同句里有两个带锚价位时（「站上 15 分位 64.00 元后有望向中位成本
// 70.00 元推进」），删掉前一个会让触发词与后一个数值的距离缩短、这才落进 24 字匹配窗口——
// 只跑一遍的话 QC 照样拦下（2026-08-26 用真实存量原文标定出来的；我第一版夹具把这半句
// 简化掉了，恰好绕过缺陷、测试全绿）。上限只是防御性的，正常两三轮就收敛。
const MAX_PASSES = 8;

export function stripAnchoredPrice(text) {
  let out = String(text ?? "");
  const changes = [];
  for (let i = 0; i < MAX_PASSES; i++) {
    const n = changes.length;
    out = onePass(out, changes);
    if (changes.length === n) break;
  }
  return { text: out, changes };
}

function onePass(input, changes) {
  let out = input;
  out = out.replace(ANCHOR_THEN_PRICE, (whole, trigger, anchor) => {
    if (HAS_TAG.test(whole)) return whole;
    // 只压匹配段自己尾部的空白（`分位成本  70.80 元` → `分位成本`），匹配段以外一个字节都不碰：
    // 全文压缩会把 HTML 缩进和 markdown 的代码块 / 嵌套列表一起压平（守卫测试钉着）。
    const to = `${trigger}${anchor.replace(/\s+$/, "")}`;
    changes.push({ from: whole.trim(), to: to.trim() });
    return to;
  });
  out = out.replace(PRICE_THEN_ANCHOR, (whole, trigger, anchor) => {
    if (HAS_TAG.test(whole)) return whole;
    const to = `${trigger} ${anchor.trim()}`;
    changes.push({ from: whole.trim(), to });
    return to;
  });
  return out;
}

// 深度版：summary_json 是嵌套对象（scenarios.base.trigger 之类），逐个字符串走一遍。
// 与 index.js 的 applyPriceFixes 同构，返回 { value, changes }，changes 汇总供日志复核。
export function stripAnchoredPriceDeep(obj) {
  const changes = [];
  const walk = (v) => {
    if (typeof v === "string") {
      const r = stripAnchoredPrice(v);
      changes.push(...r.changes);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return { value: walk(obj), changes };
}
