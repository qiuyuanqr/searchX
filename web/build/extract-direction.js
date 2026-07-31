// 股票卡方向标记：/stock 的 BLUF 格式让每条导语都以「未来约 13 周方向偏X、置信度中」开头，
// 两行截断后满屏卡片长得一样。此处把方向短语提炼成一枚可扫读的标记（↗ 偏涨 / ↘ 偏跌 / ↔ 震荡），
// 导语正文再把开头的套话方向句剥掉、从差异化内容讲起。
// 提取不到方向就返回 null、导语原样保留——不硬凑。

// 方向短语按「长的在前」排列，避免「震荡偏弱」被短的「震荡」截胡。
// 覆盖 2026-07-14 存量 27 篇股票笔记出现过的全部写法。
const DIR_RE = /(高位震荡转跌|高位震荡偏空|震荡偏中性|震荡偏[强弱涨跌]|偏震荡偏[强弱]|偏[涨跌](?:但波动放大)?|震荡（[^）]{1,12}）|偏震荡|偏[强弱]|震荡)/;

// 涨/强/多 → up；跌/弱/空 → down；其余 → flat
function classify(phrase) {
  if (/[跌弱空]/.test(phrase)) return "down";
  if (/[涨强多]/.test(phrase)) return "up";
  return "flat";
}

const ARROW = { up: "↗", down: "↘", flat: "↔" };

// 强方向短语（第二、三句备选用）：必须带「偏X/转跌」明确倾向或「震荡（带括号倾向）」，
// 裸「震荡」不算——非首句已是正文地界，「近期股价震荡走弱」这类行情描述不能误当结论。
const STRONG_DIR_RE = /(高位震荡转跌|高位震荡偏空|震荡偏[强弱涨跌]|偏震荡偏[强弱]|偏[涨跌](?:但波动放大)?|震荡（[^）]{1,12}）)/;

// 首句里挑方向短语。不能用「非震荡优先」这种全局偏好：首句写成
// 「未来 13 周方向震荡，若中报超预期则偏涨」时，基准判断是震荡、偏涨只是条件分支，
// 优先取非震荡会把徽章标成与结论相反的 ↗。
// 正确做法是锚定「方向/判断/基准」这些声明词——紧跟其后的那个才是结论；
// 锚不到再退回最左匹配（此时若最左是描述行情的裸「震荡」，才用非震荡兜底）。
const DIR_ANCHOR_RE = new RegExp(`(?:方向|判断|基准)(?:判断)?\\s*[:：]?\\s*[^，。；]{0,6}?(${DIR_RE.source.slice(1, -1)})`);

function pickFirstSentenceDir(s) {
  const anchored = DIR_ANCHOR_RE.exec(s);
  if (anchored) return [anchored[1], anchored[1]];
  const all = [...s.matchAll(new RegExp(DIR_RE.source, "g"))];
  if (!all.length) return null;
  return all.find((x) => x[1] !== "震荡") || all[0];
}

// 只认导语开头的方向（BLUF 格式方向在第一句；个别笔记先给一两句定性、方向落在第二/三句——
// 该句须以「未来/方向」引导且是强方向短语才算，扫更靠后会把正文行情描述误当结论）。
export function extractDirection(tldr) {
  const sentences = String(tldr || "").split(/[。；]/);
  const firstSentence = (sentences[0] || "").slice(0, 60);
  let m = pickFirstSentenceDir(firstSentence);
  for (let i = 1; !m && i <= 2; i++) {
    const s = (sentences[i] || "").slice(0, 60);
    if (/未来|方向/.test(s)) m = STRONG_DIR_RE.exec(s);
  }
  if (!m) return null;
  // 「震荡（略偏弱）」类带括号写法：标记里展示为「震荡·略偏弱」，括号在小徽章里太碎
  const label = m[1].replace(/（([^）]+)）/, "·$1");
  const cls = classify(label);
  return { cls, label, arrow: ARROW[cls] };
}

// 导语去套话：剥掉开头的「未来（约）13 周 / 3 个月方向…。」整句与行内的「置信度：中」
// 「不给目标价/评级…」碎片。
// 「未来约 13 周方向偏X」这句的开头部分。作者普遍写成两种形态：
//   a) 「…方向偏跌。理由一，理由二。」——整句都是套话，剥到句号
//   b) 「…方向偏跌：估值 26 倍 PB、负债率 89.8%…。」——冒号后是全部差异化理由，只能剥到冒号
// 老实现只有 a) 那条规则（剥到第一个句号/分号为止），碰上 b) 会把冒号后的核心理由整段吞掉：
// 卡片导语要么被掏空、只剩一句操作提示，要么从半截转折句开头，甚至与方向徽章表达相反的观感。
const LEAD_TO_COLON = /^未来\s*[~约]?\s*1?3\s*(?:周|个月)[^。；：:]*[：:]\s*/;
const LEAD_TO_STOP = /^未来\s*[~约]?\s*1?3\s*(?:周|个月)[^。；]*[。；]\s*/;
// 中段形态（定性句在前、方向句在后的笔记）：同样两种冒号角色
const MID_TO_COLON = /(?:^|。)\s*未来\s*[~约]?\s*1?3\s*(?:周|个月)[^。；：:]*[：:]\s*/;
const MID_TO_STOP = /(?:^|。)\s*未来\s*[~约]?\s*1?3\s*(?:周|个月)[^。；]*[。；]\s*/;

// 与方向无关的套话碎片：置信度、免责、信息截止日
function stripFragments(s) {
  return s
    .replace(/(?:整体)?置信度[：:]?\s*(?:仅)?[高中低][。；，]?\s*/g, "")
    .replace(/不给目标价[^。；]*[。；]?\s*/g, "")
    .replace(/信息截止[^。；]*[。；]\s*/g, ""); // 「信息截止 2026-06-04（北京时间）。」类报告纪律行，读者不需要
}

// 冒号有两种角色，必须分清，否则不是吞掉理由就是把方向套话留在首页：
//   「方向偏跌：<理由>」 —— 冒号前已经出现方向短语 → 冒号后是理由，只剥到冒号
//   「方向：<方向短语>…」 —— 冒号前没有方向短语 → 冒号本身还是套话的一部分，照旧剥到句读
function stripLead(text, colonRe, stopRe) {
  const colonHit = colonRe.exec(text);
  // 冒号前已出现方向短语 → 冒号后是理由，用剥得更少的冒号规则；否则用整句规则
  const re = colonHit && DIR_RE.test(colonHit[0]) ? colonRe : stopRe;
  const m = re.exec(text);
  if (!m) return text;
  // 中段形态匹配到的那个句号是上一句的收尾，得留着
  return text.replace(re, m[0].startsWith("。") ? "。" : "");
}

export function stripLeadBoilerplate(tldr) {
  const src = String(tldr || "").trim();
  let t = stripLead(src, LEAD_TO_COLON, LEAD_TO_STOP);
  t = stripFragments(t);
  // 中段悬着的方向句（定性句在前、方向句在后的笔记）也剥——方向已提为标记，不必在导语里重复
  t = stripLead(t, MID_TO_COLON, MID_TO_STOP);
  t = t.replace(/^[，、；\s]+/, "");
  if (t.length >= 15) return t;
  // 剥完太短 = 这条导语基本上就是一句方向句。直接回退原文会把方向套话原样送上首页、
  // 与旁边的方向徽章重复（正是首页改版要根治的形态）。
  // 退一步：只剥到冒号，再把紧跟其后的方向短语本身去掉，往往还能留下一句有信息的尾巴
  //（"未来 ~13 周方向判断：震荡偏中性，上下空间均不对称地大。" → "上下空间均不对称地大。"）。
  let tail = stripFragments(src.replace(LEAD_TO_COLON, ""));
  const dm = DIR_RE.exec(tail);
  if (dm && dm.index === 0) tail = tail.slice(dm[0].length);
  tail = tail.replace(/^[，、；：:\s]+/, "").trim();
  // 尾巴得像一句话才用：以正文字符开头（排除「（基准情景约 50%）。」这种只剩括注的残渣）且够长
  if (tail.length >= 8 && /^[一-龥A-Za-z0-9]/.test(tail)) return tail;
  const light = stripFragments(src).replace(/^[，、；\s]+/, "").trim();
  return light.length ? light : src;
}
