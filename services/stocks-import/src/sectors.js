// 申万行业归属与同花顺概念标签——从 Stocks 库读，给报告页多两个客观维度，
// 并为「五大常关注板块」提供推荐（只提示，不自动写入 mapping.js）。
//
// 两张表都在 stock SKILL §2.3 的白名单内（`stock_industry` / `theme` + `theme_stock`），
// 读它们不触碰库里的私人持仓与自选表。
//
// **ts_code 两格式陷阱**：`research_report` 与 `stock_basic` 存 6 位裸码（`688635`），
// 而 `stock_industry` / `theme_stock` 存**带后缀**（`688635.SH`）。查询前必须拼后缀，
// 否则 JOIN 会**静默查空**、表现成「这只票没有行业也没有概念」。白名单里专门列了这条。
//
// **申万只能取到二级**：库里 `industry_sw` 有 L1(31) 与 L2(134)，但 L2 的 `parent_code`
// 用 `110000` 这套编码、L1 的 `industry_code` 是 `801010.SI`——134 个 L2 里 0 个能连上 L1
// （2026-08-17 实测）。所以拿不到「电子 → 通信设备」这种路径，只展示二级名。
// 二级名本身比一级更具体（「通信设备」比「电子」信息量大），够用。
//
// **覆盖率不是 100%**：`stock_industry` 有 5441 条、`stock_basic` 有 5882 条（92.5%）。
// 新上市的票常常还没更新行业（长进光子 688635 就缺）。缺就不展示，**不编造、不猜**。

// ========== 概念标签的噪音过滤 ==========
//
// 同花顺概念一只票挂 7–68 个，其中大量与「这家公司做什么」无关。
// 判据只剔除**与公司业务无关的类别**，不做「看着不重要」的模糊判断。
//
// 为什么不能只靠成分股数量当阈值（2026-08-17 实测标定）：
//   沪深300样本股 319 只、新股与次新股 167 只 —— 纯噪音，但数量小，阈值拦不住；
//   人工智能 1085 只 —— 数量大，却是真业务概念，阈值会错杀。
// 所以必须先按类别剔除，剩下的再按成分股数量升序排（越少越特异：光纤概念 112
// 比人工智能 1085 更能说明这家公司干什么），泛概念自然沉到后面被截断。
const NON_BUSINESS = [
  /^(融资融券|转融通|深股通|沪股通|港股通|深港通|沪港通)$/,     // 交易机制
  /(成份股|成分股|样本股)$/,                                    // 指数成分
  /^(MSCI|富时|标普|道琼斯)/,                                   // 境外指数
  // 资讯商自制榜单（新质50 / 中特估100 / 中国AI 50）。用 `.*` 而不是 `\S*`：
  // 「中国AI 50」名字里带空格，`\S*` 匹配不到，实测漏网过一轮。
  /^(同花顺|中国).*\d{2,3}$/,
  /指数$/,                                                      // 中概股指数 / 全球金融科技指数 / 同花顺果指数
  /持股$/,                                                      // 持股方而非业务（证金持股 / 国家大基金持股 / 巴菲特持股）
  /次新股|^新股与|^注册制/,                                     // 上市状态
  /^(回购增持|股权转让|举牌|高送转|破净|定向增发|再融资|减持)/,  // 资本行为
  /并购重组/,
  /(预增|预减|预亏|预盈|扭亏)/,                                 // 财报事件
  /^人民币/,                                                    // 汇率联动
  /(国企改革|央企国企)/,                                        // 股权性质
  /^专精特新$/,                                                 // 政策名录
  // 注册地 / 区域规划：描述的是公司在哪，不是公司做什么
  /^(一带一路|西部大开发|粤港澳大湾区|乡村振兴|海峡两岸|长江经济带|京津冀|东北振兴|自由贸易|雄安新区|海南自贸|成渝|中部崛起)/,
];

// 这个概念名是否描述「公司做什么」。
export function isBusinessConcept(name) {
  const s = String(name || "").trim();
  if (!s) return false;
  return !NON_BUSINESS.some((re) => re.test(s));
}

// 概念条目 [{name, members}] → 展示用的名字数组。
// 过滤 → 按成分股数升序（越特异越靠前）→ 同数量按名字排序保证结果稳定 → 截断。
export function pickConcepts(rows, limit = 8) {
  return (rows || [])
    .filter((r) => isBusinessConcept(r.name))
    .sort((a, b) => (a.members - b.members) || String(a.name).localeCompare(String(b.name)))
    .slice(0, limit)
    .map((r) => r.name);
}

// ========== 五大常关注板块的推荐 ==========
//
// 概念 → 板块的映射刻意写得**窄**。CLAUDE.md 要求「仅在确有关联时挂，不硬凑」，
// 而同花顺的泛概念会把无关公司大批带进来——实测反例：泓博医药（CRO 医药公司）挂着
// 「AI应用」「人工智能」「ChatGPT概念」「多模态AI」，照抄就会被挂上 AI应用 板块，
// 而它的正确答案是不挂任何板块。所以：
//   - 泛概念（「人工智能」「AI应用」「芯片概念」这类）**不作为判据**，只认强特征词；
//   - 结果永远只是**建议**，打在导入日志里等人确认，不写进 mapping.js。
const BOARD_HINTS = {
  光模块: [/共封装光学|CPO/, /^光纤/, /光模块/, /光通信/, /硅光/, /光器件/, /光芯片/],
  算力: [/东数西算/, /数据中心\(AIDC\)/, /算力/, /液冷/, /^服务器/, /超算|智算/],
  // 「机器人概念」（1221 只票）刻意**不**作判据：拿它做过一版，润泽科技（IDC 公司）
  // 就被建议挂上机器人板块——正是本文件开头警告的那种误挂，只认强特征。
  机器人: [/人形机器人/, /减速器/, /伺服/, /灵巧手/, /谐波/],
  航天: [/商业航天/, /卫星/, /北斗/, /火箭|运载/, /深空|探月/],
  AI应用: [/大模型/, /AIGC/, /AI智能体/, /算力租赁/],
};

// 概念名数组 → 建议的板块数组（去重、按五大板块固定顺序）。
// 传入的应是**已过滤**的业务概念；顺序无关。
export function suggestBoards(conceptNames) {
  const names = (conceptNames || []).map((s) => String(s));
  const out = [];
  for (const [board, res] of Object.entries(BOARD_HINTS)) {
    if (names.some((n) => res.some((re) => re.test(n)))) out.push(board);
  }
  return out;
}

// ========== 查库 SQL ==========
//
// 一条 SQL 查全部票，不做 N+1。codes 是 6 位裸码数组，这里负责拼后缀。
// 概念的成分股数量用 CTE 先聚合一次，避免每行跑一次 COUNT 子查询。
export function buildSectorSql(codes, exchangeOf) {
  const list = (codes || [])
    .map((c) => `'${String(c).padStart(6, "0")}.${exchangeOf(c)}'`)
    .join(",");
  if (!list) return "";
  return `PRAGMA query_only=1;
SELECT json_object('kind','industry','code',substr(s.ts_code,1,6),'name',i.industry_name)
FROM stock_industry s JOIN industry_sw i ON i.industry_code = s.industry_code
WHERE s.ts_code IN (${list});
WITH cnt AS (SELECT theme_id, COUNT(*) n FROM theme_stock GROUP BY theme_id)
SELECT json_object('kind','concept','code',substr(ts.ts_code,1,6),'name',t.name,'members',c.n)
FROM theme_stock ts
JOIN theme t ON t.theme_id = ts.theme_id
JOIN cnt c ON c.theme_id = t.theme_id
WHERE ts.ts_code IN (${list});`;
}

// 查库输出的 JSON 行 → { [code]: {industry, concepts:[{name,members}]} }
export function groupSectorRows(rows) {
  const out = {};
  for (const r of rows || []) {
    const code = String(r.code || "").padStart(6, "0");
    if (!code) continue;
    out[code] ||= { industry: "", concepts: [] };
    if (r.kind === "industry") out[code].industry = String(r.name || "");
    else if (r.kind === "concept") out[code].concepts.push({ name: String(r.name || ""), members: Number(r.members) || 0 });
  }
  return out;
}
