// scripts/research-qc.js
// 交付前机器质检：把「对抗审查」里**机械可判**的那部分落成确定性代码，在 push 前跑。
//
// ## 为什么加这一层（本项目已有 Step 5.5 LLM 对抗核验，为什么还要它）
//
// 借鉴自 Stocks 项目 2026-08-15 的实证（`lib/research_qc.py`）：拿两份真报告把每个数字
// 逐个对回库内真值，**事实层零编造**——「再找个 LLM 通读挑错」最想抓的毛病本来就不发生；
// 而真正漏掉的两类缺陷，**通读一遍的审查者恰恰都抓不到**：
//   1. **证据压根没去拿**——data/ 里拉了一份数据，正文一次没用上。只读报告的核验员
//      手上没有那份数据，看不出「取回来的东西里还有什么被漏了」；
//   2. **规则没在跑**——「不给目标价」「无买卖评级」这类红线，靠写作者自己数是抽查，
//      靠正则查是 100% 准 + 秒级。
//
// ⚠️ **但本项目不照搬 Stocks 的结论**。Stocks 的数字全部来自自家行情库，所以零编造；
// searchX 的事实主要来自 WebSearch，2026-08-15 智谱那篇 16 条硬错的根因正是「搜索摘要
// ≠ 所引链接的内容」——那类错只有回到一手来源重抓才抓得到。所以 **Step 5.5 的 LLM
// 对抗核验必须保留**，本模块是**加一层**，不是替代它。
//
// ## 与既有代码的分工（不重复造）
//
// - `web/build/validate-report.js` 已管**模板占位符残留 + 注入类**（构建期硬失败）——本模块不碰；
// - `scripts/check-sources.js` 已管 **sources.md ⊇ report.html**——本模块不碰；
// - `web/build/parse-note.js` 的 `parseNote` 是首页卡片的**真实**抽取器——导语检查直接调它，
//   不另写一套正则（口径分家 = 这里绿、线上空白）。
//
// ## 一条不许破的线
//
// **质检自己绝不能弄死报告**。一份报告烧了几十分钟，绝不能因为质检函数抛异常就整份泡汤——
// 所有入口 fail-open，出错记下来、当作「没测」，绝不把「没测」说成「测过了」。
//
//   bun run scripts/research-qc.js --dir <归档目录名>   # 单篇（收尾自查用）
//   bun run scripts/research-qc.js --all                # 全部存量
//   bun run scripts/research-qc.js --dir <x> --strict    # 有硬红线即非零退出（push 前闸）
//   bun run scripts/research-qc.js --dir <x> --challenge # 输出喂给 Step 5.5 核验子 agent 的质证清单

import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join, extname } from "path";
import { parseNote } from "../web/build/parse-note.js";

const ARCHIVE = "research";
const DIR_RE = /^\d{4}-\d{2}-\d{2}_/;

// ========== 文本提取 ==========

// report.html → 正文纯文本。**必须先剥 style/script 整块**：模板里那段内联 CSS 有几百个
// 数字（字号/颜色/间距），不剥的话数字对账会被它淹没，清单直接失信。
// 再剥标签本身（连带属性），href 里的 URL 数字也就一起没了。
export function htmlToText(html) {
  return String(html || "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

// 取 <h2>/<h3> 标题文本，用于章节齐全检查。
export function headings(html) {
  const out = [];
  for (const m of String(html || "").matchAll(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/gi)) {
    out.push(m[1].replace(/<[^>]+>/g, "").trim());
  }
  return out;
}

// ========== 数字提取与对账 ==========

// 数字：整数或小数，允许千分位逗号。前面不许紧跟字母/数字/点，避免把 `02513.HK` 的
// `2513`、`v4.2` 的 `2` 抠出来。（形态照抄 Stocks 实证过的写法）
// ⚠️ 千分位那支必须自带小数部分 `(?:\.\d+)?`：写成 `\d{1,3}(?:,\d{3})+` 的话
// 「2,646.93」只会匹配到「2,646」，小数被吞。（Stocks 原版有这个隐患，此处修正）
const NUM_RE = /(?<![\w.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;
const URL_RE = /\((?:https?|ftp):\/\/[^)\s]+\)|(?:https?|ftp):\/\/\S+/g;
const TIME_RE = /\d{1,2}:\d{2}/g;
const FENCE_RE = /```[\s\S]*?```/g;

// 对账容差：报告会把 34.4585 写成 34.46、把 2646.93 写成 2,646.93。
// 绝对容差保住小数点后两位的四舍五入，相对容差保住大数的截断写法。
const ABS_TOL = 0.011;
// 0.001 足够覆盖「三位有效数字四舍五入」（111.9 亿写成约 112 亿，相对误差 0.0009）；
// 原来的 0.0015 在 500 量级上给出 ±0.75 的窗口，是真值池被撑密后误命中的帮凶之一。
const REL_TOL = 0.001;

// 从报告正文抽数字 → [{value, raw, context}]。已剔除 URL / 时间 / 代码围栏。
export function reportNumbers(text) {
  const clean = String(text || "")
    .replace(FENCE_RE, " ")
    .replace(URL_RE, " ")
    .replace(TIME_RE, " ");
  const out = [];
  for (const m of clean.matchAll(NUM_RE)) {
    const raw = m[1];
    const val = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(val)) continue;
    // 年份 / 章节号 / 周号 / 百分号基准：不是事实性数字，对账无意义
    if (val === 0 || val === 100) continue;
    if (!raw.includes(".") && val >= 2000 && val <= 2100) continue;
    if (!raw.includes(".") && val <= 13) continue;
    // 证券代码不是事实性数字：`02513.HK` / `600519.SH` / `300476.SZ`。
    // 两条特征——带前导零，或紧跟「.字母」后缀。本项目 A/H/美股代码满篇都是，
    // 不滤掉会在待核清单里堆一层永远对不上的噪声。（Stocks 只处理 6 位裸码，没这问题）
    if (/^0\d/.test(raw)) continue;
    const end = m.index + raw.length;
    // tail = 紧跟其后的几个字，用来判单位（亿 / 万 / %）——对账按单位构造候选值全靠它。
    // 只切这 4 个字、不要切「剩下的全文」再拿正则测开头：后者会在每个数字上复制一份
    // 长字符串，几百个数字乘十万字的正文就是几十 MB 的无谓拷贝。
    const tail = clean.slice(end, end + 4);
    if (/^\.[A-Za-z]/.test(tail)) continue;
    const ctx = clean.slice(Math.max(0, m.index - 40), end + 22).replace(/\s+/g, " ").trim();
    out.push({ value: val, raw, context: ctx, tail });
  }
  return out;
}

// data/ 里出现过的所有数值。**有意放宽**：字符串里的数字也收（`"20260331"`、新闻标题里的
// 「涨超 12%」都算取回来过的值）——本对账的目的是找「取数里根本没有的数字」，宁可放过
// 也别误伤，误报一多这份清单就没人看了。
export function truthValues(text, out = new Set()) {
  for (const m of String(text || "").matchAll(NUM_RE)) {
    const v = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(v)) out.add(v);
  }
  return out;
}

// ⚠️ **绝不把真值池按单位展开**（第一版这么干，2026-08-15 变异验证当场推翻）：
// 每个真值扩成 ×100 / ×10000 / ÷1e8 等 32 个变体后，数字空间被填满——往真实报告里塞
// 300 个凭空捏造的数字，抓到率只有 0%–36%（data 越大漏得越狠），而当时它显示的是
// 「199 个数字 199 个对上」。**看起来最漂亮的那份结果，恰恰是检查失效的样子。**
//
// 正确做法是**反过来**：真值池保持原样，按正文里那个数字**自己的单位**构造候选值去查。
// 一个数字最多带 4 个候选，池子不膨胀，命中就是真命中。
const UNIT_AFTER_RE = /^\s*(亿|万|%|％)/;

// 容差按**正文写出的精度**定：写「262」就是把 261.5–262.5 里的值取整写出来的，
// 写「46.06」只允许 ±0.005。这比拍一个相对容差准得多——2026-08-15 真跑时
// 「262」（库内 262.3）和「46」（库内 46.06）都因为固定相对容差太紧被误报。
export function toleranceOf(raw, val) {
  const dot = String(raw).indexOf(".");
  const dec = dot === -1 ? 0 : String(raw).length - dot - 1;
  const halfUlp = 0.5 * Math.pow(10, -dec);
  return Math.max(halfUlp, ABS_TOL, Math.abs(val) * REL_TOL);
}

// 返回 [{v, tol}]：候选值连同**同倍缩放后的容差**。
// ⚠️ 容差必须跟着倍数一起缩放。原来对 val/1e4 这类缩小后的候选仍用固定的 ABS_TOL
// （0.011），而候选值本身可能只有 0.05——0.011 的绝对容差等于 22% 的相对误差，
// 于是任何小数都能碰上，判别力被这一条压掉一大截。
export function candidates(val, tail, raw = String(val)) {
  const tol = toleranceOf(raw, val);
  const out = [{ v: val, tol }, { v: -val, tol }];
  const push = (k) => out.push({ v: val * k, tol: tol * k });
  const u = (String(tail || "").match(UNIT_AFTER_RE) || [])[1];
  if (u === "亿") { push(1e8); push(1e4); }        // 取数存「元」或「万元」
  else if (u === "万") { push(1e4); push(1e-4); }   // 存「元」或「亿元」
  else if (u === "%" || u === "％") push(1e-2);     // 存小数比率
  else { push(1e-8); push(1e-4); }                  // 报告写裸数、取数存元/万元
  return out;
}

// 候选（带各自容差）逐个在真值池里找。
function anyCandidateHits(cands, pool) {
  for (const { v, tol } of cands) {
    for (const t of pool) if (Math.abs(v - t) <= tol) return true;
  }
  return false;
}

function nearAny(val, pool, tol = Math.max(ABS_TOL, Math.abs(val) * REL_TOL)) {
  for (const t of pool) if (Math.abs(val - t) <= tol) return true;
  return false;
}

// 报告数字逐个与取数对账，返回**对不上的**那些。
//
// 对不上 ≠ 编造。实测绝大多数是三类合法内容：报告自行推算的派生值、联网来的数字
// （政策金额、海外预期——searchX 大量事实本就来自 WebSearch，天然不在 data/ 里）、
// 以及本函数没法归一的写法。所以产出叫**「待核清单」**不是「错误清单」。
//
// ⚠️ **同一个值只报一次**（附带出现次数）：不去重的话同一个数在正文与括号里各出现一遍，
// 几个待核值会渲染成十几行几乎一样的条目，清单立刻没法读。
export function checkNumbers(text, truthPool) {
  const pool = truthPool instanceof Set ? truthPool : new Set(truthPool);
  const seen = new Map();
  for (const { value, raw, context, tail } of reportNumbers(text)) {
    if (anyCandidateHits(candidates(value, tail, raw), pool)) continue;
    if (seen.has(value)) seen.get(value).count += 1;
    else seen.set(value, { value: raw, context, count: 1 });
  }
  return [...seen.values()];
}

// 本次对账的**判别力**：拿一批与正文同量级的凭空数字当对照，看有多少能被判为「对不上」。
//
// 为什么必须有这一条：数字对账的强弱**完全取决于 data/ 的构成**。一份结构化 JSON（几百个
// 数值）判别力尚可；一坨公告全文（几万个数字）会把数字空间填满，此时「0 个未对上」
// 完全说明不了问题。2026-08-15 实测：某篇 542KB 公告文本的存档，捏造数字 100% 漏报，
// 而它当时显示的是「199 个数字全部对上」——**检查失效时反而显示得最漂亮**。
// 所以让它自报家门：判别力低就明说这轮对账不作数，别让读者误以为数字已核过。
//
// 固定种子，结果可复现（不用 Math.random，否则同一篇每次跑出不同结论）。
export function reconciliationPower(nums, truth, samples = 200) {
  if (!nums.length || !truth.size) return null;
  const mags = nums.map((n) => Math.abs(n.value)).filter((v) => v > 0).sort((a, b) => a - b);
  if (!mags.length) return null;
  const med = mags[Math.floor(mags.length / 2)] || 1;
  const tails = nums.map((n) => n.tail || "");
  let s = 987654321;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  let caught = 0;
  for (let i = 0; i < samples; i++) {
    const v = Number((med * (0.2 + rnd() * 3)).toFixed(2));
    const tail = tails[Math.floor(rnd() * tails.length)] || "";
    if (!anyCandidateHits(candidates(v, tail, v.toFixed(2)), truth)) caught += 1;
  }
  return caught / samples;
}

// ========== 取数点覆盖 ==========

// 只认这些扩展名为「取数」。.py/.sh 是抓取脚本本身、.pdf 是二进制（读出来是乱码，
// 数字全是假的），都不参与——测不了就别测，别让清单变成天天喊狼来了的噪声。
const DATA_EXT = new Set([".json", ".csv", ".txt", ".md", ".tsv"]);
const SKIP_EXT = new Set([".pdf", ".py", ".sh", ".png", ".jpg", ".jpeg", ".webp", ".xlsx", ".zip"]);

// 一份取数文件的「探针」：挑**有辨识度**的值（带小数点、或 ≥1000 的整数）。
// 1/2/3 这种值满篇都是，拿它当探针等于恒命中，测了跟没测一样。
export function fileProbes(text, limit = 400) {
  const out = [];
  for (const v of truthValues(text)) {
    if (!Number.isFinite(v)) continue;
    if (Number.isInteger(v) && Math.abs(v) < 1000) continue;
    if (Math.abs(v) >= 1e12) continue; // 时间戳 / 内部 id，不是会被引用的事实
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

// 逐份查「取回来了、正文却一次没露过面」的取数文件。
//
// 这是本模块最有价值的一条：**只有拿着 data/ 才看得出来**，报告本身读不出
// 「取数里还有什么被漏了」。判定用「整份文件零命中」而非逐值命中——一份 K 线 JSON 有
// 几百个值、报告只会引用其中几个，逐值查必然大面积误报。
export function checkCoverage(text, dataFiles) {
  // 正文侧只展开一次，得到一个**有界**的候选池（数字数 ×4）——同样绝不去展开取数侧，
  // 那会把池子撑爆、让每份取数都「看起来被引用过」。
  const pool = [];
  for (const { value, tail, raw } of reportNumbers(text)) {
    for (const c of candidates(value, tail, raw)) pool.push(c);
  }
  const out = [];
  for (const { name, content } of dataFiles) {
    const probes = fileProbes(content);
    if (probes.length < 3) continue; // 探针太少 → 不下判断，别瞎报
    // 探针落在任一候选的容差窗内即算「留下痕迹」
    if (!probes.some((p) => pool.some((c) => Math.abs(c.v - p) <= c.tol))) {
      out.push({ file: name, probes: probes.slice(0, 4).map(String) });
    }
  }
  return out;
}

// ========== 格式合规与红线 ==========

// 股票报告必备章节（A–M）。**按关键词匹配、不按全名**：存量里同一节写法就有三种
// （「AI 与科技方向关联性」/「人工智能方向关联性」/「AI 与科技方向关联」），按全名匹配必然误报。
// G 节（AI 关联）skill 明写「如适用，否则跳过」，故**不列为必备**。
export const STOCK_SECTIONS = [
  { key: "一屏结论", re: /关键发现|一屏结论|核心结论/ },
  { key: "公司快照", re: /公司快照|公司画像/ },
  { key: "财务健康", re: /财务健康|关键财务|财务表现/ },
  { key: "行业地位与护城河", re: /行业地位|护城河/ },
  { key: "政策与宏观", re: /政策|宏观/ },
  { key: "产业链", re: /产业链/ },
  { key: "消息面与预期差", re: /消息面|预期差/ },
  { key: "13 周事件日历", re: /事件日历|关键事件/ },
  { key: "逻辑链推导", re: /逻辑链/ },
  { key: "三情景走势", re: /情景/ },
  { key: "决策与风控", re: /决策|风控/ },
  { key: "逻辑自查", re: /逻辑自查|自查/ },
];

// 价位红线（skill §4.9 第 3 条 / §6）：**自己**给出的具体触发价位。
// 客观披露价（基准日收盘、回购区间、历史高低点）合法，所以必须靠**触发语境**卡，
// 不能见「元」就报——存量里每篇都有「收盘 212.75 元」，那是必含项。
// ⚠️ 触发词表要含**裸「回踩」**：2026-08-15 修存量时发现「回踩 13.5 元区间（前期平台）」
// 只写了「回踩」不写「回踩至」，第一版漏掉了它。同理收进「测试 / 回测」。
// ⚠️ 间隔里**不许跨分句边界**（逗号 / 顿号 / 括号）。跨过逗号，价位就不再是触发词的宾语：
// 「杀跌容易引发被动止损，但也常对应阶段性的成本密集支撑区（78–82 元区间）」——「止损」
// 在描述**市场上其他人的行为**，78–82 属于逗号另一侧的「成本密集支撑区」，不是止损位。
// 收紧**不会**变成漏报，关键在于交给正则自己往后找真正的触发词，而不是在循环里 continue：
// 「…回落至60%以下，或股价收盘跌破筹码成本50%分位251.6元」这句，「回落至」跨了逗号被跳过，
// 引擎接着匹配到紧贴价位的「跌破」，照样拦——若改成 continue，lastIndex 已越过整段，
// 这条真红线就被静默放跑（存量 300620 的真实写法，守卫测试钉着）。
// 2026-08-25 对全部 121 篇标定：76 → 75 条，唯一消失的是上面那条止损误报，
// 300620 的真违规不但仍在，报出的文本还更准（从跨句长串变成「跌破筹码成本50%分位251.6元」）。
const TRIGGER_PRICE_RE =
  /(突破|跌破|失守|站上|站稳|回落至|回落到|下探至|上探至|回踩至|回踩|回调至|回测|测试|止损|止盈)[^。；！？\n，,、（）()]{0,24}?(\d[\d,]*(?:\.\d+)?)\s*(元|港元|美元|港币)/g;

// 预测性价格区间（「30–44 元宽幅震荡」）：K 节三情景的「走势特征」最常见的形态，
// 实质就是给了目标价区间。存量 4 篇都栽在这里，而它不带任何触发动词、靠上面那条抓不到。
const BAND_PRICE_RE =
  /(\d[\d,]*(?:\.\d+)?)\s*[-–—~]\s*(\d[\d,]*(?:\.\d+)?)\s*(元|港元|美元|港币)\s*(区间|宽幅|震荡|附近|支撑|波动)/g;

// 历史 / 现状陈述里的同款措辞**不算**红线：「现在回落到 311 元」是行情回顾，
// 「突破 303.55 元后维持高位震荡」才是前瞻触发。2026-08-15 对 51 篇存量真跑标定出的
// 唯一一类误报（江丰电子那篇），靠时间状语区分。
// ⚠️ **不许把裸「已」放进来**。第一版放了，结果「若**已**持有…跌破 14 元转防御」
// 这条真红线被静默吞掉——「若已持有」是条件不是过去时。这正是「加一层保护先问是不是
// 拆掉了另一层」：为消一条误报而放跑真发现，是最难发现的一类回归（守卫见测试）。
// 窗口取 30 字：「随后两周半一路回落至 7.6 元」的时间状语离动词有点远，12 字够不着。
// 「一路 / 随后 / 此后 / 触及 / 年初」是 2026-08-15 修存量时从真实误报里补进来的。
// ⚠️ 绝不能放**裸「已」**（「若已持有…跌破 X 元」是条件不是过去时）、也不能放裸「后」
// （「跌停反弹后…跌破 X 元转防御」会被误吞）——两条都有守卫钉着。
const PAST_TENSE_NEAR_RE =
  /(现在|目前|当前|已经|截至|收于|收盘|近期|上周|昨日|今年至今|一路|随后|此后|触及|年初|曾|历史上)[^。；\n]{0,20}$/;

// 条件句里的「过去时词」不是过去时——这是上面那条注释里「若**已**持有…跌破 X 元」的同一个坑，
// 只是换了个词：「或股价**收盘**跌破筹码成本 50% 分位 251.6 元，那么观望或减仓」，这里的
// 「收盘」是条件的一部分（收盘价口径），不是「昨日收盘跌破」那种行情回顾。
// 2026-08-25 收紧跨分句匹配后才暴露：匹配起点从「回落至」移到紧贴价位的「跌破」，
// 前 30 字窗口这才罩进「股价收盘」，把存量 300620 那条真红线整条豁免掉了。
// 所以：窗口里出现条件词时，过去时豁免一律不生效（守卫测试钉着）。
const CONDITIONAL_NEAR_RE = /(如果|若|一旦|倘若|假如|除非)[^。；\n]{0,30}$/;
// 比条件词更根本的判据：**句子给出了操作结论，用途就是指导买卖**（§4.9 的「边界是用途」）。
// 真实的触发条件不一定写「如果」——「跌破 42 元则减仓」就没有，于是只要同段提过新闻、
// 或句中有个「曾」字，这条真红线就会被引用/过去时豁免静默放跑（2026-08-26 自审抓到）。
// 在价位**之后**的紧邻窗口里找操作结论，找到就一律不豁免。
const ACTION_AFTER_RE =
  /(则|那么|就|即|后)?\s*[^。；\n]{0,12}(减仓|加仓|回避|试仓|观望|离场|止盈|止损|转防御|降低仓位|加大仓位)/;

// 大宗商品 / 产品售价**不是股价**。「批价跌破 1369 元」（茅台飞天散瓶）、「现货金站稳
// 4,300 美元」（山东黄金）这类句子是行业事实与宏观条件，写进触发条件天经地义，
// 跟「给标的一个目标价」是两回事。2026-08-16 导入 Stocks 存量时实测：不排除它们，
// 茅台与山东黄金两篇会被硬红线整篇挡下，而挡的全是误报。
// 两条独立判据，命中任一即放行：
//   ① 价格主语紧邻在前（批价 / 金价 / 现货金 / 面板价 …）；
//   ② 数值带「每单位」后缀（元/瓶、美元/盎司）。⚠️ 单位表里**绝不能放「股」**——
//      「60 元/股」正是股价，放进去等于把这条红线整条废掉。
// 判据①按**整句**找价格主语（商品价的主语常隔着好几个从句，如「2026-08-06 现货金收
// 4,308 美元、单日 +4.20% 突破 4,300 美元」），但必须配一道守卫：紧挨触发词前 12 字
// 内出现「股」就不放行。否则「金价上行背景下，若股价跌破 14 元转防御」这条真红线
// 会被同句的「金价」遮掉——一句话里商品价与股价同时出现是常态。
// 这正是「加一层保护先问是不是拆了另一层」，守卫见测试。
// ⚠️ 表里**绝不能放裸「均价」**（2026-08-25 从测试里撞出来的漏报）。它看着像商品价主语，
// 实际存量里压倒性地是**股价**：员工持股均价 138.61、筹码加权均价 74.09、减持均价 43.10、
// 回购均价 192.18~210。放进来等于「若跌破回购均价 X 元则减仓」这类真红线被整条放跑——
// 而漏报比误报危险得多。商品侧的均价另有两条判据兜着，不靠它：主语（金价均价、出口均价
// 那句的「金价」）与每单位后缀（68.75 美元/kg、4506.29 美元/盎司）。
const COMMODITY_SUBJ_RE =
  /批价|出厂价|零售价|售价|单价|吨价|报价|金价|银价|铜价|油价|煤价|电价|气价|面板价|材料价|原料价|现货金|现货黄金|现货白银|期货|价格指数/;

const COMMODITY_UNIT_RE =
  /(?:元|港元|美元|港币)\s*\/\s*(?:瓶|吨|克|盎司|千克|公斤|升|桶|片|只|个|支|件|平方米|立方米|磅|平米|台)/;

// 回购 / 增持 / 减持的**已披露成交价**是客观披露，SKILL §4.9 括号里点名回购可保留；
// 增减持成交均价同理——都是公告里已发生的事实价，不是对未来的位置指引
// （存量原话："35.05–36.09 元与减持均价 43.10 元均为公司公告披露"）。
// 判据必须窄：不能用「整句里有回购」——「公司已完成回购，悲观情景下股价在 150–170 元
// 区间震荡」同句也有回购，那条是真红线。所以要求窗口以「回购…均价 / 价格 / 区间」**直接
// 收尾**再接数字（"已回购 70.50 万股、均价 192.18~210 元" 命中；"…股价在 150–170 元"
// 收在「在」上，不命中）。同一句 SKILL 还写着「不得作为买卖触发条件」，那半句由
// TRIGGER_PRICE_RE 独立兜底——它不吃这条豁免，两条守卫测试钉着。
// 只作用于 BAND_PRICE_RE 一条（见下方 checkFormat）。
const BUYBACK_DISCLOSURE_RE = /(回购|增持|减持)[^。；\n]{0,14}?(?:均价|价格|区间)\s*$/;

// 「基准日收盘价」是 §4.9 第 5 条的**必含项**，「发行价」是客观披露，两者都不是触发价。
// ⚠️ 只放这两个。别顺手把「历史高点 / 授予价」也加进来——存量里
// 「突破 5 月 19 日历史高点 303.55 元后…」「回踩激励授予价 20.36 元附近」都是**真红线**，
// 加进来会把它们一起放过（客观披露价一旦当触发条件用，就不再是客观披露）。
// ⚠️ 只放这两个 + 现状词。别顺手把「历史高点 / 授予价」也加进来（见上方那条注释）。
// 现状词（当前 / 现价 / 最新）出现在**匹配文本内部**时是行情陈述而非前瞻触发：
// H 节引用别人报道里的价位：「新闻标题『茅台股价再次站上 1300 元』」「跌破 1000 元关口
// （来源：东方财富，发稿时点 14:05）」——那是在陈述别人报道了什么，不是给读者的买卖指令，
// §4.9 的边界是**用途**。标记词可能落在价位之后（「来源：」常跟在后面），所以前后都要看。
// 守卫靠「条件句优先」：同段提过新闻不豁免后面真正的触发条件（守卫测试钉着）。
// 「情感 +0.7」是 H 节事件表每行必带的字段，「新闻」覆盖正文引述库内新闻标题的写法。
const QUOTE_SOURCE_RE = /新闻标题|发稿时点|来源：|（来源|报道称|旧快照|库内新闻|新闻里|情感\s*[+-]/;

// 筹码套牢带 / 密集成交区的价位区间：与回购区间同类，是客观筹码分布披露而非情景预测。
// **只看价位之后的紧邻窗口**：写在前面会被「密集套牢带，悲观情景下股价在 150–170 元区间」
// 这种同段情景区间蹭到豁免（守卫测试钉着这一条）。
const CHIP_BAND_RE = /^\s*(是|为)?\s*(密集)?(套牢带|成交密集区|筹码密集区|密集成交区|套牢区)/;

// 「股价从年内高点 65.55 元回落至当前 30.48 元」——PAST_TENSE_NEAR_RE 只看动词前面，
// 这种"时间状语落在动词后面"的写法它够不着（2026-08-16 导入山东黄金那篇时标定）。
const BASELINE_PRICE_RE = /基准日|发行价|当前|现价|最新价/;

// 每股**盈利**指标（EPS / 每股收益）单位恰好也是元，但它是利润表指标、不是股价。
// 「2026 全年 EPS 预测中枢跌破 1.00 元 → 回避」是基本面触发条件，正是 §4.9 想要的那种
// 「不给具体价位位置」的写法（2026-08-31 中航沈飞 600760 被误挡，全量存量里首次出现）。
// ⚠️ 表里**绝不能放「每股净资产」**：「若股价跌破每股净资产 5.20 元则加仓」这类破净写法里
// 它就是**股价的锚点**，放进来等于把真红线整条放跑——同「均价」那个坑（2026-08-25）。
// 同理别放「每股分红 / 每股股利」：没有真实误报撑着的豁免只会扩大漏报面。
const EPS_METRIC_RE = /EPS|每股收益|每股净利|每股盈利|每股亏损/i;

// 守卫：EPS 豁免只看**紧邻**窗口（不像商品那样按整句），且窗口里出现「股价」就不放行——
// 「若 EPS 中枢上修，但股价跌破 14 元则转防御」一句里两者同时出现是常态。
// ⚠️ 这道守卫不能照抄商品那条的裸「股」判据：「每股收益」自己就带「股」字，
// 那样写等于豁免永远不生效（写死在守卫测试里）。
const EPS_GUARD_RE = /股价/;

// 券商目标价：**不是**违规，是〔卖方预期〕模板里「别人的观点」。单列一档「需判断」，
// 措辞不许写「请删除」——照搬 Stocks 8-15 的教训：一律命令删除，会让模型把券商评级
// 也删掉，那是丢信息不是合规。
const BROKER_TARGET_RE = /目标价[^。；\n]{0,20}?(\d[\d,]*(?:\.\d+)?)\s*(元|港元|美元|港币)/g;

// 禁词（skill §6「不给买卖评级」）。「减仓」「回避」是允许的，只看这两个。
export const FORBIDDEN_WORDS = ["买入", "卖出"];

// 禁词的合法复合词：资金流 / 盘面口径术语，H 节必然出现，与「买卖评级」无关。
// 不滤掉的话每份报告都会因为一句「融资净买入 8.85 亿元」被报违规。
const FORBIDDEN_OK = [
  "净买入", "净卖出", "融资买入", "融资卖出", "买入额", "卖出额",
  "买入量", "卖出量", "买入方", "卖出方", "买入盘", "卖出盘", "买入信号",
];

function ctxAround(s, idx, len, before = 30, after = 20) {
  return s.slice(Math.max(0, idx - before), idx + len + after).replace(/\s+/g, " ").trim();
}

// 隐私红线（CLAUDE.md 绝对红线 · Step 6 第 2 项，此前只靠肉眼扫）。
// 模式必须**紧扣「个人的」**：报告正文合法地大量出现「机构持仓」「北向持仓」「股东户数」，
// 泛匹配「持仓」会把每篇都报一遍。
// ⚠️ 后面必须跟上负向前瞻：人物类调研写「他公开自己的**持仓理念**」是在讲被研究对象的
// 作风，不是用户私人信息（2026-08-15 对 51 篇存量真跑，这是隐私检查唯一一条误报）。
const PRIVACY_RES = [
  { name: "个人持仓/账户", re: /(?:我|本人|自己|用户)的?(?:持仓|仓位|账户|持股|成本价|盈亏|浮盈|浮亏)(?!\s*(?:理念|风格|思路|方法|原则|逻辑|哲学|习惯|纪律))/g },
  { name: "持仓规模", re: /(?:持仓|仓位)(?:规模|市值|金额)\s*(?:约|为|是)?\s*\d/g },
  { name: "个人负债/还款", re: /(?:我|本人|自己)的?(?:负债|贷款|还款|房贷)/g },
];

// 「不含 / 不涉及 / 无任何 …用户持仓」这类**否定式免责**不是泄露。窗口取 14 字：
// 「本报告不含任何用户持仓」里否定词与命中之间隔着「任何」。
// ⚠️ 别把裸「没有」放进来：它太常见，「这只票没有大涨，按我的持仓成本价…」会被它吞掉
// （守卫见测试）。只收明确指向"本文不写这类信息"的措辞。
const PRIVACY_NEGATION_RE =
  /(?:不含|未含|不包含|不涉及|不写入|不记录|绝不|无任何|不得出现|不会出现|不披露)[^。；\n]{0,14}$/;

// 返回 {blocking, review}：blocking = 硬红线（--strict 下挡 push）；
// review = 需人判断的，列出来但不阻断（避免清单失信——Stocks 的核心误报治理经验）。
export function checkFormat({ reportHtml, notesMd, type, dir }) {
  const blocking = [];
  const review = [];
  const html = String(reportHtml || "");
  const text = htmlToText(html);
  const isStock = String(type || "") === "股票";

  // 1) 章节齐全（仅股票——概念/人物/板块类没有 A–M 框架）
  if (isStock) {
    const hs = headings(html).join(" ｜ ");
    const missing = STOCK_SECTIONS.filter((s) => !s.re.test(hs)).map((s) => s.key);
    if (missing.length) {
      blocking.push(`缺章节：${missing.join(" / ")}（A–M 框架应齐全，G 节 AI 关联除外）`);
    }
  }

  // 2–4) 价位红线 / 禁词 / 隐私——**report.html 与 notes.md 都要扫**。
  // notes.md 同样是公开产物（进公开仓库、还驱动首页卡片与 Obsidian 笔记），
  // 只扫报告会漏：2026-08-15 修那 5 篇存量时，价位在 notes.md 里原封不动地留着。
  for (const [label, scanned] of [["报告正文", text], ["notes.md", String(notesMd || "")]]) {
    if (!scanned) continue;
    const at = (m) => `…${ctxAround(scanned, m.index, m[0].length)}…`;

    if (isStock) {
      // 商品价语境：整句里有价格主语（金价/批价…）且触发词前 12 字没有「股」，
      // 或数值直接带每单位后缀（元/盎司）。
      const sentenceAt = (i) => {
        let start = 0;
        for (const p of ["。", "；", "\n"]) start = Math.max(start, scanned.lastIndexOf(p, i) + 1);
        let end = scanned.length;
        for (const p of ["。", "；", "\n"]) {
          const j = scanned.indexOf(p, i);
          if (j !== -1 && j < end) end = j;
        }
        return scanned.slice(start, end);
      };
      const isCommodity = (m) =>
        COMMODITY_UNIT_RE.test(scanned.slice(m.index, m.index + m[0].length + 6)) ||
        (COMMODITY_SUBJ_RE.test(sentenceAt(m.index)) &&
          !scanned.slice(Math.max(0, m.index - 12), m.index).includes("股"));

      for (const m of scanned.matchAll(TRIGGER_PRICE_RE)) {
        const before = scanned.slice(Math.max(0, m.index - 30), m.index);
        // 条件句优先：「若…股价收盘跌破 X 元」里的「收盘」是条件不是回顾，不吃过去时豁免。
        const around = scanned.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
        // 条件句优先：「若…股价收盘跌破 X 元」里的「收盘」是条件不是回顾，不吃过去时豁免；
        // 引用豁免同理——同段提过新闻，不等于后面那个真触发条件也能跟着放行。
        const after = scanned.slice(m.index + m[0].length, m.index + m[0].length + 30);
        if (!CONDITIONAL_NEAR_RE.test(before) && !ACTION_AFTER_RE.test(after)) {
          if (PAST_TENSE_NEAR_RE.test(before)) continue;
          if (QUOTE_SOURCE_RE.test(around)) continue;
        }
        if (BASELINE_PRICE_RE.test(m[0])) continue;
        if (isCommodity(m)) continue;
        if (EPS_METRIC_RE.test(before.slice(-20)) && !EPS_GUARD_RE.test(before.slice(-20))) continue;
        blocking.push(`【${label}】具体触发价位「${m[0].trim()}」（§4.9 价位红线：操作触发条件不得用具体价位，改写成相对/条件表述）——上下文：${at(m)}`);
      }
      for (const m of scanned.matchAll(BAND_PRICE_RE)) {
        if (isCommodity(m)) continue;
        if (BUYBACK_DISCLOSURE_RE.test(scanned.slice(Math.max(0, m.index - 20), m.index))) continue;
        if (CHIP_BAND_RE.test(scanned.slice(m.index + m[0].length, m.index + m[0].length + 12))) continue;
        blocking.push(`【${label}】预测性价格区间「${m[0].trim()}」（§4.9 价位红线：三情景走势不得给具体价位区间，等于给了目标价）——上下文：${at(m)}`);
      }
      const targets = [...scanned.matchAll(BROKER_TARGET_RE)];
      if (targets.length) {
        review.push(`【${label}】出现「目标价」${targets.length} 处——判断后再动：若是**引用券商**的目标价（属〔卖方预期〕模板里别人的观点）**保留原样**；若是你自己给出的，必须删掉。首处：${at(targets[0])}`);
      }

      // 禁词：一律**带上下文**报出，不报成光秃秃的「出现禁词：买入」。报告里可能既有
      // 合法引用（券商评级「买入 → 中性」、自我声明「全文无买入/卖出表述」）又有真违规
      // （「建议买入」）。给两处而非一处，免得真违规被首处的合法引用藏起来。
      for (const word of FORBIDDEN_WORDS) {
        const ctxs = [];
        let i = scanned.indexOf(word);
        while (i !== -1) {
          const around = scanned.slice(Math.max(0, i - 3), i + word.length + 3);
          if (!FORBIDDEN_OK.some((ok) => around.includes(ok))) ctxs.push(ctxAround(scanned, i, word.length));
          i = scanned.indexOf(word, i + word.length);
        }
        if (!ctxs.length) continue;
        const head = ctxs.slice(0, 2).map((c) => `…${c}…`).join("；");
        const more = ctxs.length > 2 ? `（全文 ${ctxs.length} 处）` : "";
        review.push(`【${label}】出现「${word}」${more}——判断后再动：若是**你自己**给出的买卖倾向，改写掉；若只是引用券商评级、或资金流口径术语，保留原样。上下文：${head}`);
      }
    }

    for (const { name, re } of PRIVACY_RES) {
      for (const m of scanned.matchAll(re)) {
        // 「本报告**不含**任何用户持仓 / 自选 / 账户信息」——这是**声明没有**，不是泄露。
        // 存量里几乎每篇股票报告都写了这句免责，不排除的话它会把每一篇都点亮成红线，
        // 清单一失信，真正的泄露就会淹在里面（2026-08-16 导入时标定）。
        if (PRIVACY_NEGATION_RE.test(scanned.slice(Math.max(0, m.index - 14), m.index))) continue;
        blocking.push(`【${label}】疑似用户私人信息（${name}）：${at(m)}（CLAUDE.md 绝对红线）`);
      }
    }
  }

  // 5) 首页导语——**调 parse-note 的真实抽取器**，不另写正则。
  //    这里绿、线上空白，是本项目 2026-07-31 抓到过的高危形态。
  if (notesMd != null) {
    try {
      const note = parseNote(notesMd, dir || "0000-00-00_x");
      if (!note.tldr || !note.tldr.trim()) {
        blocking.push("notes.md 抽不出首页导语（parse-note 返回空）——H1 之下须有 `## 一句话结论` 小节且内容为**完整段落**（列表/表格会被抽取器跳过）");
      } else if (note.tldr.trim().length < 40) {
        review.push(`首页导语只有 ${note.tldr.trim().length} 字（「${note.tldr.trim()}」）——首页会剥掉方向套话句，只写一句方向的段落上了首页就是空话`);
      }
      if (isStock && !/[（(]\s*\d{5,6}|[（(]\s*(?:NYSE|NASDAQ|HKEX)/i.test(note.title || "")) {
        review.push(`notes.md H1「${note.title}」未见「名称（代码.交易所）」格式——首页卡片直接吃这处`);
      }
    } catch (e) {
      review.push(`notes.md 解析失败（${e.message}）——首页卡片会受影响`);
    }
  }

  return { blocking, review };
}

// ========== 汇总 ==========

function readDataFiles(dirPath) {
  const dataDir = join(dirPath, "data");
  if (!existsSync(dataDir)) return { files: [], present: false, skipped: [] };
  const files = [];
  const skipped = [];
  for (const name of readdirSync(dataDir)) {
    const p = join(dataDir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const ext = extname(name).toLowerCase();
    if (SKIP_EXT.has(ext) || !DATA_EXT.has(ext)) {
      skipped.push(name);
      continue;
    }
    if (st.size > 8 * 1024 * 1024) {
      skipped.push(`${name}（>8MB，跳过）`);
      continue;
    }
    try {
      files.push({ name, content: readFileSync(p, "utf8") });
    } catch {
      skipped.push(`${name}（读取失败）`);
    }
  }
  return { files, present: true, skipped };
}

// 跑全部检查。**任何异常都吞掉**——质检绝不能弄死一份跑了几十分钟的报告。
export function runQc(dirName, root = ARCHIVE) {
  const dirPath = join(root, dirName);
  const base = {
    dir: dirName, ok: false, blocking: [], review: [],
    coverage: [], numbersTotal: 0, numbersUnmatched: [],
    dataPresent: false, dataSkipped: [], type: "",
  };
  try {
    const reportPath = join(dirPath, "report.html");
    const notesPath = join(dirPath, "notes.md");
    // 报告不存在就是「没得测」，必须 ok=false——否则会渲染成「✅ 未见红线」，
    // 把「没测」说成「测过了」，正是本模块最不该犯的错。
    if (!existsSync(reportPath)) {
      // 已丢弃的报告（stocks-import 判定不值得上线，目录里只留 `.dropped`、正文删掉）
      // 不是「没得测」——它压根不该上线。**只认这个标记**：目录空着照旧按未测处理，
      // 否则 --all 每次都点亮一片假红线，真问题反而被淹掉。
      if (existsSync(join(dirPath, ".dropped"))) {
        return { ...base, ok: true, dropped: true, type: "已丢弃" };
      }
      return { ...base, error: `${join(dirName, "report.html")} 不存在` };
    }
    const reportHtml = readFileSync(reportPath, "utf8");
    const notesMd = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : null;
    const type = (String(notesMd || "").match(/^type:\s*(.+)$/m) || [, ""])[1].trim();
    const text = htmlToText(reportHtml);
    const { files, present, skipped } = readDataFiles(dirPath);

    const fmt = checkFormat({ reportHtml, notesMd, type, dir: dirName });
    const nums = reportNumbers(text);

    // 数字对账 / 取数点覆盖**只在 data/ 就位时才跑**。没有 data/ 就如实写「未跑」——
    // 绝不把「没测」渲染成「测过了」。（data/ 是 gitignore 的，只在跑调研那台机器上有）
    let coverage = [];
    let unmatched = [];
    let power = null;
    let truthSize = 0;
    if (present && files.length) {
      const truth = new Set();
      // 顺带记下每份取数各贡献多少真值：判别力弱时要能点名**是哪份在稀释**，
      // 否则只说「太密了」读者不知道该动什么。实测：Stocks 库「只存引用行」的取数
      // 判别力 89%，同样查库但存 90 天全历史掉到 35%，公告全文式存档 0%。
      for (const f of files) {
        const before = truth.size;
        truthValues(f.content, truth);
        f.added = truth.size - before;
      }
      truthSize = truth.size;
      base.dataFiles = files.map((f) => ({ name: f.name, added: f.added }));
      unmatched = checkNumbers(text, truth);
      coverage = checkCoverage(text, files);
      power = reconciliationPower(nums, truth);
    }
    return {
      ...base, ok: true, type,
      blocking: fmt.blocking, review: fmt.review,
      coverage, numbersTotal: nums.length, numbersUnmatched: unmatched,
      dataPresent: present && files.length > 0, dataSkipped: skipped,
      power, truthSize, dataFiles: base.dataFiles || [],
    };
  } catch (e) {
    return { ...base, error: e.message };
  }
}

export function hasBlocking(qc) {
  return Boolean(qc && qc.ok && qc.blocking && qc.blocking.length);
}

// 终端清单。质检没跑成 → 明说「未跑完」，不写「一切正常」。
export function renderReport(qc) {
  const L = [];
  L.push(`⚙️  交付前机器质检 · ${qc.dir}${qc.type ? `（${qc.type}）` : ""}`);
  if (!qc.ok) {
    L.push(`  ⛔ 质检未跑完（${qc.error || "未知原因"}）——按「未测」对待，别当通过`);
    return L.join("\n");
  }
  if (qc.dropped) {
    L.push("  ○ 已丢弃（目录里只剩 .dropped 标记），不上线也不必质检");
    return L.join("\n");
  }
  if (!qc.blocking.length) L.push("  ✅ 硬红线：未见缺章节 / 具体触发价位 / 私人信息 / 导语抽空");
  for (const p of qc.blocking) L.push(`  ⛔ ${p}`);
  for (const p of qc.review) L.push(`  ⚠️  需判断：${p}`);

  if (!qc.dataPresent) {
    L.push("  ○ 数字对账 / 取数点覆盖：**未跑**（本篇无 data/ 取数留档——data/ 已 gitignore，只有跑调研那台机器上有）");
  } else {
    if (!qc.coverage.length) L.push("  ✅ 取数点覆盖：各取数文件均在正文留下引用痕迹");
    for (const c of qc.coverage) {
      // 措辞只说「未见引用痕迹」，不说「漏用」——本检查看不出报告有没有在「信息缺口」
      // 里写明为何不用（那要判语义），把判断留给读者。
      L.push(`  ⚠️  取数点覆盖：**data/${c.file}** 取回来了（如 ${c.probes.join("、")}），但正文未见引用痕迹——请确认是有意略过（并已写进信息缺口）还是漏用`);
    }
    const matched = Math.max(0, qc.numbersTotal - qc.numbersUnmatched.length);
    L.push(`  · 数字对账：正文 ${qc.numbersTotal} 个数字，${matched} 个能对回 data/，${qc.numbersUnmatched.length} 个未对上（联网数字与自行推算的派生值本就对不上，逐条列出供核）`);
    if (qc.power != null) {
      const pct = Math.round(qc.power * 100);
      if (qc.power < 0.4) {
        const top = [...(qc.dataFiles || [])].sort((a, b) => b.added - a.added)[0];
        const who = top ? `，其中 data/${top.name} 一份就贡献 ${top.added} 个` : "";
        L.push(`    ⚠️ **本轮对账判别力弱（${pct}%）**：data/ 里有 ${qc.truthSize} 个数字${who}，数字空间太密、随便一个数都能碰上。「${matched} 个对上」基本说明不了问题——**别把它当作数字已核对过**，该核的照旧回一手来源核。`);
      } else if (qc.power < 0.8) {
        L.push(`    · 本轮对账判别力中等（${pct}%，真值 ${qc.truthSize} 个）：能抓住大部分凭空数字，但漏网仍有，不能替代人工核对。`);
      } else {
        L.push(`    · 本轮对账判别力 ${pct}%（真值 ${qc.truthSize} 个）：凭空数字基本跑不掉。`);
      }
    }
    for (const it of qc.numbersUnmatched.slice(0, 12)) {
      const times = it.count > 1 ? `（全文 ${it.count} 处）` : "";
      L.push(`      - ${it.value}${times} — …${it.context}…`);
    }
    if (qc.numbersUnmatched.length > 12) {
      L.push(`      - （另有 ${qc.numbersUnmatched.length - 12} 条，同类从略）`);
    }
  }
  if (qc.dataSkipped.length) L.push(`  ○ 未参与对账的取数文件（非文本格式）：${qc.dataSkipped.join("、")}`);
  return L.join("\n");
}

// 喂给 Step 5.5 核验子 agent 的定向质证清单——把「对不上的数字 + 没用上的取数点」
// 交到核验员手上，核验从「凭印象通读」升级成「拿着证据清单逐条质证」，零新增轮次。
// 无发现 → 空串（没问题就别硬造质证点，那只会诱导为了「有所交代」去改本来对的地方）。
export function renderChallenge(qc) {
  if (!qc || !qc.ok) return "";
  const L = [];
  for (const p of qc.blocking) L.push(`- 硬红线：${p} —— 请就地修正。`);
  for (const p of qc.review) L.push(`- 需判断：${p}`);
  for (const c of qc.coverage) {
    L.push(`- 取数点「data/${c.file}」**取回来了**（如 ${c.probes.join("、")}），但正文没用上。请回到该数据把它写进对应章节；若判断确实不该用，就在「逻辑自查/信息缺口」里写明理由。`);
  }
  const un = qc.numbersUnmatched;
  if (un.length) {
    L.push(`- 下列 ${un.length} 个数字在 data/ 取数里找不到对应值。逐个确认：是取数里的值（那就改成取数的写法）、是自行推算的派生值（写明推算方式）、还是带来源与日期的联网结论（补上来源与日期）？三者都不是的，删掉或改写成「信息缺口」——绝不许补编。`);
    for (const it of un.slice(0, 20)) L.push(`  · ${it.value}　（上下文：${it.context}）`);
  }
  if (!L.length) return "";
  return ["【机器质检发现（请逐条处理，不要辩解）】", ...L].join("\n");
}

// ========== CLI ==========

function main() {
  const argv = process.argv.slice(2);
  const strict = argv.includes("--strict");
  const challenge = argv.includes("--challenge");
  const di = argv.indexOf("--dir");
  const one = di !== -1 ? argv[di + 1] : null;

  let dirs;
  if (one) {
    dirs = [one.replace(/\/+$/, "").replace(/^research\//, "")];
  } else {
    dirs = readdirSync(ARCHIVE)
      .filter((d) => DIR_RE.test(d) && existsSync(join(ARCHIVE, d, "notes.md")))
      .sort();
  }

  let blocked = 0;
  for (const d of dirs) {
    const qc = runQc(d);
    if (challenge) {
      const c = renderChallenge(qc);
      if (c) console.log(`\n===== ${d} =====\n${c}`);
    } else {
      console.log(renderReport(qc));
      console.log("");
    }
    if (hasBlocking(qc)) blocked += 1;
  }
  if (dirs.length > 1) console.log(`—— 共 ${dirs.length} 篇，${blocked} 篇有硬红线`);
  if (strict && blocked) process.exit(1);
}

if (import.meta.main) main();
