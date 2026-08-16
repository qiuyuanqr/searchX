// Stocks 报告 → searchX 公开站的「系统参数过滤器」。
//
// Stocks 项目的调研全文是给**自己人**看的：正文里到处是取数函数名（financials_recent）、
// 库表与字段（daily_basic / pe_ttm）、SQL 与执行计划、机器名（Mac mini）、源码路径
// （lib/stock_research.py:346-353），以及「某函数跑了 45 分钟没返回」这类运行时故障叙述。
// 这些东西搬到公开站上，① 读者读不懂也不需要懂；② 等于把内部系统的结构、库规模、
// 甚至主机名一起对外摊开。所以入库前必须过一道过滤。
//
// 三条处理路线，顺序不能反：
//   ① **术语映射**：把取数函数 / 字段名换成中文口径名（financials_recent → 库内财务）。
//      **不是删掉**——这些标记承担着「这个数字是从哪来的」的溯源作用，删了报告就不可核了。
//   ② **整句剔除**：换完之后仍在讲系统内部机理的句子（索引、执行计划、主机、源码路径、
//      「跑了 N 分钟没返回」），整句删。必须排在①之后：①会把函数名变成中文，
//      否则②的「库内」类判据根本匹配不到。
//   ③ **收尾清理**：把①②必然留下的空括号、只剩标记的空列表项、落单的 ** 收干净。
//
// 一条不许破的线：**只删系统内部叙述，绝不动分析结论与数字**。数据完整性是 CLAUDE.md
// 的硬约定——过滤器宁可漏掉一句实现细节，也不能把「毛利率 32.29%」这种事实误删。
// 所以整句剔除的判据一律要求出现**明确的系统内部词**，不做「看着像技术话」的模糊判断。
// 判据的松紧是拿 25 篇存量真跑标定出来的，两类误伤都是实测抓到后才收窄的：
//   - 裸 `CPU` 曾把海光信息（一家做 CPU 的公司）整段业务描述删掉；
//   - 裸「未返回 / 不可用」曾把「库内事件日历未返回任何解禁项」这类**真实数据缺口**、
//     以及「这些公司的财务数据本次未查，不对其基本面作任何陈述」这类**免责声明**删掉。
// 所以「故障词」必须与「时长 / 被终止」同现才算运行时故障叙述。

// 行内代码被判定为「该删」时先落这个哨兵，等标点收敛完再抹掉。
// 用可见字符串而不是私用区码点：后者在编辑器与 diff 里是隐形的，改坏了看不出来。
const HOLE = "@@HOLE@@";

// ========== ① 术语映射 ==========

// 取数函数 / 视图 → 中文口径名。键是函数名本体，调用形式（带参数、带 .字段）在下面统一归一。
// 值刻意都以「库内」开头：读者一眼知道这是"本地行情库里的数据"，与「联网」来源区分开，
// 而这正是原报告里那些函数名唯一真正承担的信息。
export const FUNC_MAP = {
  company_snapshot: "库内公司档案",
  quote_brief: "库内行情",
  valuation_brief: "库内估值",
  financials_recent: "库内财务",
  stock_financials: "库内财务",
  industry_peers: "库内同业对比",
  recent_news: "库内新闻",
  upcoming_events: "库内事件日历",
  events_calendar: "库内事件日历",
  broker_view: "库内研报",
  funds_chips_view: "库内资金筹码",
  funds_chips: "库内资金筹码",
  zt_history: "库内涨停记录",
  concepts_of: "库内概念标签",
  ah_view: "库内 A/H 对照",
  business_scope: "库内经营范围",
  lookup_stock: "库内基础资料",
  irm: "库内投资者关系问答",
  anns: "库内公告",
};

// 库表 / 字段 → 中文。字段名单独出现时（「pe_ttm = 41」）换成通用财务术语，
// 读者不需要知道库里这一列叫什么。
export const FIELD_MAP = {
  pe_ttm: "PE(TTM)",
  pb: "PB",
  dv_ratio: "股息率",
  turnover_rate: "换手率",
  gross_margin: "毛利率",
  net_margin: "净利率",
  net_profit: "归母净利",
  net_profit_yi: "归母净利（亿元）",
  revenue: "营收",
  revenue_yi: "营收（亿元）",
  revenue_yoy: "营收同比",
  profit_yoy: "净利同比",
  eps: "EPS",
  debt_to_assets: "资产负债率",
  total_mv_yi: "总市值（亿元）",
  industry_pe_median: "行业 PE 中位数",
  industry_peer_count: "同行数量",
  pe_rank_in_industry: "行业内 PE 排名",
  main_business: "主营业务",
  introduction: "公司简介",
  industry: "行业归属",
  list_status: "上市状态",
  list_date: "上市日期",
  employees: "员工人数",
  reg_capital_wan: "注册资本（万元）",
  close: "收盘价",
  as_of: "数据时点",
  trade_date: "交易日",
  ann_date: "公告日",
  end_date: "报告期",
  prev_end_date: "上一报告期",
  moneyflow: "资金流",
  chips: "筹码分布",
  cyq_perf: "筹码分布",
  holders: "股东户数",
  cost_85pct: "85% 分位筹码成本",
  winner_rate: "获利盘比例",
  elg_net_sum_yi: "特大单净额（亿元）",
  up_stat: "涨停统计",
  lianban: "连板",
  open_times: "开板次数",
  titles: "研报标题",
  forecasts: "盈利预测",
  sentiment: "情绪标签",
  theme: "概念主题",
  related_themes: "关联概念",
  np_wan: "净利润（万元）",
  hk_close: "港股收盘价",
};

// 库表名给中文读法，**不删**：删掉会把句子读断——实测「与 `stock_basic` 的「汽车配件」
// 不一致」被删成了「与的「汽车配件」不一致」。真正在讲库表机理的句子由②整句剔除处理，
// 这里只负责让**没被整句删掉的**那些句子仍然读得通。
const TABLE_MAP = {
  daily_basic: "行情库",
  stock_basic: "库内基础资料",
  theme_stock: "概念标签表",
  news_event: "新闻事件表",
};

// 纯内部标识：对读者零信息、且删掉也不影响句子结构的那些（参数名、内部 id、枚举值）。
const INTERNAL_TOKEN_RE =
  /^(?:matched_aliases|match_reason|severity_category|event_category|event_id|ts_code|source|prev_num|n|days|L)\b/;

// 一眼可判的「这是代码/SQL/路径」，整块抹掉。
const CODE_LIKE_RE =
  /(?:^|[^A-Za-z])(?:SELECT|FROM|WHERE|GROUP\s+BY|ORDER\s+BY|MAX|EXPLAIN|SCAN|PRAGMA)\b|lib[./]|scripts\/|\.py\b|--mode=/i;

// 归一化一个行内代码片段：剥参数、剥 .字段、剥引号，拿到"本体名"。
// industry_peers("603009", n=3) → industry_peers；broker_view.titles → broker_view
function baseName(token) {
  const m = String(token).trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  return m ? m[1] : "";
}

// 取数调用的**取数窗口**是有信息的，丢了会出洋相：`recent_news(days=60)` 与
// `recent_news(days=180)` 都映射成「库内新闻」后，原句「两者均返回空」会变成
// 「库内新闻与库内新闻均返回空」。把窗口参数翻成中文后缀保住这个区别。
// 票代码之类的位置参数一律不要——正文里那只票是谁本来就说清楚了。
function windowSuffix(base, raw) {
  const days = raw.match(/days\s*=\s*(\d+)/);
  if (days) return `（近 ${days[1]} 日）`;
  const n = raw.match(/\bn\s*=\s*(\d+)/);
  if (!n) return "";
  if (base === "financials_recent" || base === "stock_financials") return `（近 ${n[1]} 期）`;
  if (base === "industry_peers") return `（取 ${n[1]} 家）`;
  return `（取 ${n[1]} 条）`;
}

// 把一个行内代码片段换成公开可读的写法。返回 null 表示「整块删掉」。
export function mapCodeSpan(inner) {
  const raw = String(inner).trim();
  if (!raw) return null;
  // 取数模块本身有中文读法，必须排在「像路径就删」之前——否则
  // 「要么来自 `lib.stock_research` 的返回值」会被删成「要么来自的返回值」。
  if (/^lib[./]stock_research\b(?!\.py)/.test(raw)) return "库内取数";
  if (CODE_LIKE_RE.test(raw)) return null;

  const base = baseName(raw);
  // `[]`、`(trade_date, ts_code)` 这类：不是标识符，一律删
  if (!base) return null;
  if (FUNC_MAP[base]) return FUNC_MAP[base] + windowSuffix(base, raw);
  if (TABLE_MAP[base]) return TABLE_MAP[base];
  if (INTERNAL_TOKEN_RE.test(raw)) return null;
  if (FIELD_MAP[base]) {
    // 「字段=值」：值有信息，保留成「报告期 20260331」
    const rest = raw.slice(base.length).replace(/^\s*[:=]\s*/, "").trim();
    if (!rest || rest === "null" || /^\(/.test(rest)) return FIELD_MAP[base];
    return `${FIELD_MAP[base]} ${rest}`;
  }
  // 剩下的：纯 ASCII 下划线标识符一律当内部符号删；其余（中文、混排）保留成普通文本
  if (/^[A-Za-z_][A-Za-z0-9_.]*(?:\(.*\))?$/.test(raw)) return null;
  return raw;
}

// 裸标识符兜底：并非每处函数名 / 字段名都被写在反引号里。存量实测漏网的有
// `cost_85pct = 70.20 元`（国瓷）、`trade_date`（蓝思）、`up_stat`（格林美）等十余种。
// 只认**已知**的名字（下面两张表的键 + 少数内部表名），未知的 snake_case 一律不动——
// 正文里没有它，URL 里却全是（t20250611_2594306 / content_2182438），乱动就把链接改坏了。
const BARE_EXTRA = {
  match_reason: "匹配依据",
  event_type: "事件类型",
  event_category: "事件类别",
  severity_category: "重要性分级",
  matched_aliases: "命中别名",
};
const BARE_MAP = { ...FUNC_MAP, ...FIELD_MAP, ...TABLE_MAP, ...BARE_EXTRA };
// 长名在前：先换 financials_recent，再轮到 revenue，否则前者会被拆成半截。
const BARE_KEYS = Object.keys(BARE_MAP).sort((a, b) => b.length - a.length);
const BARE_RE = new RegExp(`(?<![A-Za-z0-9_])(?:${BARE_KEYS.join("|")})(?![A-Za-z0-9_])`, "g");

// 链接目标先摘出来存好，替换完再放回去——URL 里带下划线标识符是常态，绝不能动。
export function mapBareIdentifiers(line) {
  const urls = [];
  const masked = String(line).replace(/\]\((?:[^)\s]+)\)/g, (m) => {
    urls.push(m);
    return `@@U${urls.length - 1}@@`;
  });
  const done = masked.replace(BARE_RE, (m) => BARE_MAP[m]);
  return done.replace(/@@U(\d+)@@/g, (_, i) => urls[Number(i)]);
}

// 替换出来的中文标签有时会和原文里已有的同义词撞成叠词：
// 「`quote_brief` 数据时点 `as_of=16:29`」→「库内行情 数据时点 数据时点 16:29」。
// 只对**本模块产出的那些标签**做叠词收敛，不做通用的「重复词合并」——后者会误伤
// 「一步一步」这类正常表达。
const LABEL_VALUES = [...new Set([
  ...Object.values(FUNC_MAP), ...Object.values(FIELD_MAP), ...Object.values(TABLE_MAP),
])].filter((v) => /^[\u4e00-\u9fff]{2,8}$/.test(v)).sort((a, b) => b.length - a.length);
const DUP_LABEL_RE = new RegExp(`(${LABEL_VALUES.join("|")})\\s*\\1`, "g");

// 泛称也是系统语，换成读者能懂的说法。放在行内代码替换之后：它们本身不带反引号。
const PHRASE_MAP = [
  // 中英之间的空格此刻还在（tidyLine 才收），所以 `\s*` 不能省：
  // 「`lib.stock_research` 函数返回值」→「库内取数 函数返回值」，不带 \s* 就漏了。
  [/库内取数\s*函数|取数函数|库函数|官方函数/g, "库内取数"],
  [/库内\s*(?=库内)/g, ""],   // 「库内 `financials_recent`」→「库内 库内财务」，收掉重复前缀
  [DUP_LABEL_RE, "$1"],
];

// 行内代码 → 中文口径名 / 删除。同时收敛替换后必然出现的空括号与孤立标点。
// ⚠️ 只对**非围栏**行调用：正文里的 ``` 会被这里的成对反引号规则拆掉（实测踩过）。
export function mapTerms(line) {
  let out = String(line).replace(/`([^`\n]*)`/g, (_, inner) => {
    const mapped = mapCodeSpan(inner);
    return mapped === null ? HOLE : mapped;
  });
  const h = HOLE;
  out = out
    .replace(new RegExp(`[（(]\\s*${h}\\s*[）)]`, "g"), "")               // （空洞）
    .replace(new RegExp(`[（(]\\s*${h}\\s*[，,、；;]\\s*`, "g"), "（")     // （空洞，其它…
    .replace(new RegExp(`[，,、；;]\\s*${h}\\s*(?=[）)])`, "g"), "")       // …，空洞）
    .replace(new RegExp(`([与和及自])\\s*${h}\\s*的`, "g"), "$1")   // 「与 ␥ 的 X」→「与 X」
    .replace(new RegExp(`${h}\\s*[，,、]\\s*`, "g"), "")
    .replace(new RegExp(`\\s*[，,、]\\s*${h}`, "g"), "")
    .replace(new RegExp(h, "g"), "");
  for (const [re, to] of PHRASE_MAP) out = out.replace(re, to);
  return out;
}

// ========== ② 整句剔除 ==========

// 只讲系统内部机理、对读者零价值的句子。判据必须"硬"——出现明确的内部词才算。
// 每条都对得上 25 篇存量里的真实句子。
const INTERNAL_SENTENCE_RES = [
  // 数据库实现细节。「索引 / 子查询」按裸词判——中文财经语境里不会用到这两个词
  //（指数是「指数」不是「索引」），所以不会误伤正文。
  /索引|子查询|全表扫描|嵌套扫描|执行计划|查询计划|窗口函数|慢查询|平方级|总代价|skip-?scan|autoindex/i,
  /EXPLAIN|GROUP BY|SELECT |MAX\(trade_date\)|SCAN |PRIMARY KEY/i,
  /主键(?:是|为|顺序)|表(?:已达|有)\s*[\d,]+\s*行|\d{1,3}(?:,\d{3}){2,}\s*行|\d[\d.]*\s*万行/,
  // 工程侧自述：改代码、修函数、登记工具缺陷——都是写给维护者的，不是给读者的
  /改写(?:该)?(?:函数|查询|子)|重构该查询|修复该函数|该函数性能|函数级性能|性能缺陷|工程缺陷|工程问题|工程性能|工具层|工具缺陷|待修项/,
  /终止(?:该)?(?:调用|查询|进程|函数)|实测(?:运行|单进程)?\s*\d+\s*分钟/,
  // 「查询写法不同所以能秒回」这类对照说明同样是实现细节；「我把根因查清了写在这里」
  // 是引出一段马上要被删掉的内容，留着就是一句悬空的承诺。
  /查询写法|逐票取最新一行|能秒回|根因查清|原因是技术性的/,
  // 内部表/键的命名细节
  /打标表|打分表|裸码|同步链路|连接键/,
  // 主机 / 部署 / 源码
  // ⚠️「本机」要挡住「切换成本机理」这种跨词误命中（实测在拓荆那篇把一整条护城河
  //   结论删掉了）；「本库」则**不能**列进来——它在报告里是「库内」的同义写法，
  //   「本库无产量字段」「本库近 60 日无此条」都是真实的数据缺口陈述。
  /Mac ?mini|qiuyuanmacmini|数据主机|外置盘|只读副本|(?<!成)本机(?![理制])|生产库|真库|数据链任务窗口|GitHub：up to date|research-daemon/,
  /lib[./]stock_research|scripts\/|\.py\b|fail-open|100%\s*CPU|CPU\s*(?:满载|占用|持续)/,
  // 运行时故障叙述：必须**同时**出现取数对象 + 故障词 + 时长/终止标记。
  // 三者缺一就会误伤真实的数据缺口陈述与免责声明（实测标定，见文件头）。
  /(?=.*(?:库内|函数|调用|查询|接口))(?=.*(?:超时|未返回|未出结果|未产出|无结果|无输出|跑不出来|跑不动|不可用|无法(?:在合理时间|在可用时间)))(?=.*(?:\d+\s*分钟|终止|已停|放弃))/,
];

// 句子切分：中文句末标点 + 保留标点，便于原样拼回。
export function splitSentences(text) {
  const out = [];
  let buf = "";
  for (const ch of String(text)) {
    buf += ch;
    if ("。！？；".includes(ch)) { out.push(buf); buf = ""; }
  }
  if (buf) out.push(buf);
  return out;
}

export function isInternalSentence(s) {
  return INTERNAL_SENTENCE_RES.some((re) => re.test(s));
}

// 逐句过滤一行文本。返回 {text, dropped[]}。
export function filterLine(line) {
  const dropped = [];
  const kept = splitSentences(line).filter((s) => {
    if (!isInternalSentence(s)) return true;
    dropped.push(s.trim());
    return false;
  });
  return { text: kept.join(""), dropped };
}

// ========== ③ 收尾清理 ==========

// 整句删完后会留下的残骸：只剩标记的列表项（「- **补法**：」）、空括号、连续空行。
// 标签词允许带前后缀（「根因已定位：」「已定位根因：」「⚠️ 方法说明：」都要认），
// 但整行必须**只剩**这个标签——正文里「三情景推演如下：」这类引出下文的句子不在此列，
// 它们后面的内容没被删。
const ORPHAN_LABEL_RE =
  /^\s*(?:[-*+]|\d+[.、)]|[①-⑳])?\s*[^\p{L}\p{N}]*(?:\*\*)?[^：:\n]{0,8}?(?:补法|根因|影响|方法说明|方法论披露|原因|说明|现象|经诊断|对照组)[^：:\n]{0,8}?(?:\*\*)?\s*[:：]?\s*$/u;

// 落单的 **：整句被删后常留下半边加粗记号，原样渲染出来就是一串星号。
function balanceBold(line) {
  const n = (line.match(/\*\*/g) || []).length;
  if (n % 2 === 0) return line;
  return line.replace(/\*\*(?![\s\S]*\*\*)/, "");
}

export function tidyLine(line) {
  let s = line
    .replace(/[（(]\s*[）)]/g, "")
    .replace(/【\s*】/g, "")
    .replace(/「\s*」/g, "")
    // 两侧都算「中日韩字符」时才收空格：既要含汉字，也要含全角标点——
    // 替换后常见的形态是「…（近 60 日） 与…」，空格前面是全角右括号而不是汉字。
    .replace(/(?<=[　-〿一-鿿！-･])[ \t]+(?=[　-〿一-鿿！-･])/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s*[，、]\s*(?=[。；！？])/g, "")
    .replace(/^(\s*(?:[-*+]|\d+[.、)])\s*)[，、；。]+\s*/, "$1")
    .replace(/[ \t]+$/, "");
  return balanceBold(s);
}

// ========== 入口 ==========

// 整节剔除：8 月起 Stocks 会把自家的**机器质检输出**原样贴在报告末尾（「### ⚙️ 交付前
// 机器质检」——格式检查、数字对账、判别力、逐条截断引文）。那是给作者看的流水线自检，
// 不是报告内容；它还会把正文里的函数名以截断形式再泄一遍（`financials_r…`），
// 逐句过滤根本收不干净。整节连标题一起去掉。
const DROP_SECTION_RE = /交付前机器质检|机器质检|质检报告|自检清单/;

// 剥掉正文开始前的「跑批自述」——Stocks 那边多数报告的第一段是引擎对作者说的话
// （"数据齐了。12 个取数函数全部调通…"、"本机：qiuyuanmacmini…"），既不是报告内容，
// 也是系统参数泄漏最集中的一处。正文从第一个标题开始。
export function stripPreamble(md) {
  const lines = String(md).split("\n");
  const i = lines.findIndex((l) => /^#{1,2}\s/.test(l));
  return i < 0 ? String(md) : lines.slice(i).join("\n");
}

// 完整过滤：剥自述 → 逐行（术语映射 → 整句剔除 → 行内清理）→ 压空行。
// 围栏代码块（产业链示意图）整块原样保留：里面是靠空格对齐的 ASCII 图，
// 逐句切分与空格收敛都会把它切碎，而它本来也不含系统参数。
// 返回 {md, dropped[]}——dropped 会被导入器打到终端，供人抽查"删掉的都是什么"。
export function sanitize(rawMd) {
  const dropped = [];
  const out = [];
  let inFence = false;
  let skipLevel = 0;       // >0 表示正在跳过一个整节，值是该节标题的层级
  let afterHeading = false;  // 上一条有内容的行是不是标题（用来收拾开头的悬空承接词）
  for (const raw of stripPreamble(rawMd).split("\n")) {
    if (/^\s{0,3}```/.test(raw)) {
      inFence = !inFence;
      if (!skipLevel) out.push(raw);
      continue;
    }
    if (inFence) {
      // 围栏里只做标识符替换，不做逐句过滤、不动空格——那是靠空格对齐的产业链示意图。
      // 但里面照样会出现取数函数名（药石那张图上就有），所以映射不能跳过。
      if (!skipLevel) out.push(mapBareIdentifiers(mapTerms(raw)));
      continue;
    }
    const head = raw.match(/^(#{1,6})\s+(.*)$/);
    if (head) {
      const level = head[1].length;
      if (skipLevel && level <= skipLevel) skipLevel = 0;
      if (!skipLevel && DROP_SECTION_RE.test(head[2])) {
        skipLevel = level;
        dropped.push(`【整节剔除】${head[2].trim()}`);
        continue;
      }
    }
    if (skipLevel) continue;
    const r = filterLine(mapBareIdentifiers(mapTerms(raw)));
    dropped.push(...r.dropped);
    let line = tidyLine(r.text);
    // 被删掉的常常正是「所以…」的那个「所以」。承接词紧跟标题时读起来是断的，
    // 去掉它就还原成一句正常的开头（只在**紧接标题**时动手，正文中间的承接词不碰）。
    if (afterHeading) line = line.replace(/^(\s*(?:[-*+]|\d+[.、)])?\s*(?:\*\*)?)(?:因此|所以|于是|为此)[，,]?/, "$1");
    if (/^\s*(?:[-*+]|\d+[.、)])\s*$/.test(line)) continue;
    if (/^\s*(?:[-*+]|\d+[.、)])?\s*\*\*\s*\*\*\s*[:：]?\s*$/.test(line)) continue;
    if (ORPHAN_LABEL_RE.test(line)) continue;
    // 标题行自己不算「有内容的正文行」——它正是要把标志置起来的那一行。
    if (line.trim()) afterHeading = Boolean(head);
    out.push(line);
  }
  return { md: out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n", dropped };
}
