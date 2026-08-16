// 从（已过滤的）Stocks 报告 markdown 里抽出建三件套需要的零件。
// 全部是"从原文里找现成的句子"，**不改写、不概括、不生成新事实**——
// 抽不到就退回空串，由调用方决定怎么降级，绝不编一句填坑。

// 「**一句话逻辑**：xxx」——A 节 BLUF 里最凝练的一句，25 篇存量全都有。
export function pickOneLiner(md) {
  const m = String(md).match(/\*\*一句话逻辑\*\*\s*[:：]\s*(.+)/);
  return m ? m[1].replace(/\*\*/g, "").trim() : "";
}

// 「- **主营（库内原文）**：…」这类**行首带标签**的主营描述。
// 必须锚在行首：正文里「2026Q1 的利润不是主营挣来的」这种句子也含「主营」，
// 用宽松匹配会把它当成业务描述抓走（实测在拓荆那篇中招）。
export function pickMainBusiness(md) {
  for (const line of String(md).split("\n")) {
    const m = line.match(/^\s*(?:[-*+]\s*)?\**\s*主营(?:业务)?\s*\**\s*(?:（[^）]*）|\([^)]*\))?\s*\**\s*[:：]\s*(.+)$/);
    if (!m) continue;
    return m[1]
      .replace(/\*\*/g, "")
      .replace(/^[「"']|[」"']$/g, "")
      .replace(/（[^）]*原文[^）]*）/g, "")
      .trim();
  }
  return "";
}

// 正文里出现过的所有外链，按出现顺序去重。返回 [{url, text}]。
// sources.md 必须**覆盖**报告正文里的全部外链（scripts/check-sources.js 的判定口径），
// 所以来源清单直接由这份结果生成，天然满足包含关系。
export function pickLinks(md) {
  const seen = new Map();
  for (const m of String(md).matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    const url = m[2].trim();
    if (!seen.has(url)) seen.set(url, m[1].replace(/\*\*/g, "").trim());
  }
  return [...seen].map(([url, text]) => ({ url, text }));
}

// 有 7 篇报告**全篇一个 URL 都没有**：它们把出处写成正文里的「（来源：新浪财经 2026-07-05）」。
// 这类文字出处照样是可追溯线索，不收就等于把这几篇的来源清单做成空的。
// 只认「来源：」这个显式标签，不做"看着像媒体名"的猜测；分号/顿号分条。
// 出处词：括号里出现日期**且**出现这些词之一，才算一条文字出处。
// 光有日期不算——「（截至 2026-08-14 收盘）」「（库内估值，2026-08-14）」都不是来源。
const SOURCE_HINT_RE =
  /财联社|同花顺|东方财富|新浪|网易|搜狐|腾讯|界面|澎湃|21\s*世纪|第一财经|证券时报|上海证券报|中国证券报|经济观察|每日经济|证券之星|金融界|格隆汇|钛媒体|IT之家|新华|人民|央广|央视|中新|财新|华尔街见闻|智通财经|巨潮|公告|问询函|交易所|年报|半年报|季报|招股|研报|周刊|日报|时报|通讯社|官网|白皮书|统计局|工信部|发改委|证监会/;

export function pickTextSources(md, seenTexts = []) {
  const out = new Set();
  const seen = seenTexts.join(" ");
  const add = (s) => {
    const t = s.replace(/\*\*/g, "").trim().replace(/^[、,，;；]+|[、,，;；]+$/g, "").trim();
    if (!t || t.length > 80 || t.length < 4) return;
    if (seen.includes(t)) return;          // 已经作为链接文字收过，不重复计数
    out.add(t);
  };
  // ① 显式「（来源：X；Y）」
  for (const m of String(md).matchAll(/[（(]\s*来源\s*[:：]\s*([^）)]{1,200})[）)]/g)) {
    for (const part of m[1].split(/[；;]/)) add(part);
  }
  // ② 「（同花顺 2026-05-21；搜狐财经 2026-04-29 披露预案）」这类不带「来源：」标签的
  for (const m of String(md).matchAll(/[（(]([^）()]{4,120})[）)]/g)) {
    const body = m[1];
    if (/来源\s*[:：]/.test(body)) continue;                   // ① 已收
    if (!/20\d{2}[-/年]\d{1,2}/.test(body)) continue;          // 必须带日期
    if (!SOURCE_HINT_RE.test(body)) continue;                  // 必须带出处词
    for (const part of body.split(/[；;]/)) add(part);
  }
  return [...out];
}

// 链接文字里常带日期（「央广网 2026-07-08」「新浪科技 · …（2026-06-17）」），
// 抽出来放进来源清单的日期位。抽不到就留空——不拿报告日期冒充来源日期。
export function pickDate(text) {
  const m = String(text).match(/(20\d{2})[-/年.](\d{1,2})(?:[-/月.](\d{1,2}))?/);
  if (!m) return "";
  const p = (n) => String(n).padStart(2, "0");
  return m[3] ? `${m[1]}-${p(m[2])}-${p(m[3])}` : `${m[1]}-${p(m[2])}`;
}

// 来源类型 → 报告模板的配色类（监管/披露/媒体/研究/社区）。
// 先看链接文字里的体裁词，再看域名：文字比域名准（同一个新浪域名下既有转载公告
// 也有普通报道），域名只做兜底。
const REG_HOSTS = /(?:sse\.com\.cn|szse\.cn|csrc\.gov\.cn|neeq\.com\.cn|\.gov\.cn|samr|mofcom)/i;
const DISC_HOSTS = /(?:cninfo\.com\.cn|静态|irm\.cninfo|hkexnews|static\.sse)/i;
const COMM_HOSTS = /(?:xueqiu\.com|zhihu\.com|weibo\.com|tieba|guba)/i;
const RESEARCH_HOSTS = /(?:10jqka\.com\.cn\/\d+\/worth|research|gelonghui)/i;

export function classifySource(text, url) {
  const t = String(text);
  if (/问询函|监管|交易所|证监会|处罚|立案|函件/.test(t)) return "监管";
  if (/公告|招股|年度报告|半年度报告|季度报告|业绩预告|披露|权益变动|减持|回购/.test(t)) return "披露";
  if (/研报|研究报告|评级|盈利预测|一致预期|券商|证券研究/.test(t)) return "研究";
  if (REG_HOSTS.test(url)) return "监管";
  if (DISC_HOSTS.test(url)) return "披露";
  if (COMM_HOSTS.test(url)) return "社区";
  if (RESEARCH_HOSTS.test(url)) return "研究";
  return "媒体";
}

export const SRC_CLASS = {
  监管: "src-reg", 披露: "src-disc", 媒体: "src-media", 研究: "src-research", 社区: "src-comm",
};

// 名词小抄：固定词表 ∩ 报告里真出现过的词。
// 不做"自动从正文里认术语"——那会把「中报」「毛利率」以外的普通词也收进来，
// 小抄一长就没人看。词表按「这行外的人第一眼会卡住」挑的。
export const GLOSSARY = [
  ["PE(TTM)", "市盈率（滚动十二个月）。股价 ÷ 每股盈利，衡量「买一元利润要付多少钱」；亏损公司此项无意义。"],
  ["PB", "市净率。股价 ÷ 每股净资产，重资产行业常用它替代 PE。"],
  ["PS", "市销率。市值 ÷ 营业收入，用于还没稳定盈利的成长股。"],
  ["ROE", "净资产收益率。净利润 ÷ 净资产，衡量自有资本的赚钱效率。"],
  ["毛利率", "（营收 − 营业成本）÷ 营收。反映产品本身赚不赚钱，不含期间费用。"],
  ["净利率", "净利润 ÷ 营收。毛利率扣掉销售、管理、研发、财务费用与税之后剩下的比例。"],
  ["扣非净利", "扣除非经常性损益后的净利润。剔除卖资产、政府补助、公允价值变动等一次性项目，更接近主业真实盈利。"],
  ["非经常性损益", "与主营业务无关、偶发的收益或损失，如处置资产、政府补助、金融资产公允价值变动。"],
  ["资产负债率", "总负债 ÷ 总资产。衡量杠杆水平。"],
  ["经营现金流", "经营活动产生的现金流量净额。利润是账面数，这个是真金白银进出。"],
  ["商誉", "收购时溢价支付的部分记在账上的资产。被收购方业绩不达预期时要计提减值、直接冲减利润。"],
  ["分位", "把历史数值从小到大排序后当前值所处的位置。「PB 处 90% 分位」= 历史上九成时间比现在便宜。"],
  ["换手率", "当日成交股数 ÷ 流通股本。衡量交易活跃度与筹码换手速度。"],
  ["融资余额", "投资者借钱买股尚未偿还的金额。上升代表杠杆资金在加仓，也意味着回撤时的被动抛压更大。"],
  ["筹码", "不同价位上持股的分布。「获利盘」指当前价高于其成本的那部分持股。"],
  ["主力资金", "按单笔成交金额划分出的大单与特大单净流入流出，用来观察大资金动向（口径由数据商定义，非官方数据）。"],
  ["限售解禁", "首发或定增取得的股份锁定期届满、可以上市流通。解禁本身不等于减持，但增加了潜在供给。"],
  ["业绩预告", "上市公司在正式财报前发布的盈利区间预告，达到规定变动幅度时强制披露。"],
  ["中报", "半年度报告。法定披露截止日为 8 月 31 日。"],
  ["三季报", "第三季度报告。法定披露截止日为 10 月 31 日。"],
  ["BLUF", "Bottom Line Up Front，结论先行——把最重要的判断放在最前面。"],
  ["置信度", "本报告对每条结论标注的把握程度，由证据的数量、独立性与时效决定，不是概率保证。"],
  ["一致预期", "多家券商盈利预测的平均值。是别人的观点，不是事实。"],
  ["A+H", "同一家公司同时在 A 股与港股上市，两地股价常年存在折溢价。"],
  ["产业链", "从上游原材料到下游终端的完整链条。判断议价能力要看公司卡在链条的哪一环。"],
];

export function pickGlossary(text) {
  const s = String(text);
  return GLOSSARY.filter(([term]) => s.includes(term));
}
