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

// 只认导语开头的方向（BLUF 格式方向在第一句；个别笔记先给一两句定性、方向落在第二/三句——
// 该句须以「未来/方向」引导且是强方向短语才算，扫更靠后会把正文行情描述误当结论）。
export function extractDirection(tldr) {
  const sentences = String(tldr || "").split(/[。；]/);
  const firstSentence = (sentences[0] || "").slice(0, 60);
  let m = DIR_RE.exec(firstSentence);
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
// 「不给目标价/评级…」碎片。剥完剩太短（<15 字）说明导语本身只有方向句，返回原文兜底。
export function stripLeadBoilerplate(tldr) {
  const src = String(tldr || "").trim();
  let t = src;
  // 方向套话句剥到「。或；」即止——[^。]* 会越过分号把真内容一并吃掉
  t = t.replace(/^未来\s*[~约]?\s*1?3\s*(?:周|个月)[^。；]*[。；]\s*/, "");
  t = t.replace(/(?:整体)?置信度[：:]?\s*(?:仅)?[高中低][。；，]?\s*/g, "");
  t = t.replace(/不给目标价[^。；]*[。；]?\s*/g, "");
  t = t.replace(/信息截止[^。；]*[。；]\s*/g, ""); // 「信息截止 2026-06-04（北京时间）。」类报告纪律行，读者不需要
  // 中段悬着的方向句（定性句在前、方向句在后的笔记）也剥——方向已提为标记，不必在导语里重复
  t = t.replace(/(^|。)\s*未来\s*[~约]?\s*1?3\s*(?:周|个月)[^。；]*[。；]\s*/, "$1");
  t = t.replace(/^[，、；\s]+/, "");
  return t.length >= 15 ? t : src;
}
