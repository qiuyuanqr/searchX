// 股票卡标题清洗：从笔记 H1 拆出「公司名 + 规范化代码」，代码之后的副题/套话一律不进卡片。
// 背景：存量 27 个股票标题的后缀有十几种写法（「— 未来约 13 周走势判断」「· 深度投研」…），
// 全是零信息套话，手机端会把标题挤到只剩「国瓷材料（300285.SZ）— 未…」。展示层在此统一收口，
// 笔记 H1 本身不动（reports.json / 查重仍用原始标题）。
//
// 解析不出代码时返回 null，调用方原样展示标题——宁可保守也不误伤。

// 单个代码：A 股 6 位数字（可带 .SZ/.SH/.BJ）、港股 4-5 位数字.HK、或「交易所: 代码」（如 NYSE: VRT）
const ONE_CODE = /(?:[A-Z]{2,8}\s*[:：]\s*[A-Z0-9.]{1,8}|\d{4,6}(?:\.[A-Z]{2})?)/;
// 代码串：单个代码，或「/」分隔的多市场代码（如 300476.SZ / 02476.HK）
const CODES = new RegExp(`${ONE_CODE.source}(?:\\s*/\\s*${ONE_CODE.source})*`);

// A 股裸代码补交易所后缀：6 开头沪市、0/3 开头深市、4/8 开头北交所；已带后缀或非 A 股格式原样。
function normalizeOne(code) {
  const c = code.replace(/\s*[:：]\s*/, ": ").trim();
  if (/^\d{6}$/.test(c)) {
    if (c[0] === "6") return `${c}.SH`;
    if (c[0] === "0" || c[0] === "3") return `${c}.SZ`;
    if (c[0] === "4" || c[0] === "8") return `${c}.BJ`;
  }
  return c;
}

export function cleanStockTitle(title) {
  const t = String(title).trim();
  // 优先找括号里的代码串（全角/半角），再退到裸代码（如「巨轮智能 002031」）
  let m = new RegExp(`[（(]\\s*(${CODES.source})\\s*[)）]`).exec(t);
  if (!m) m = new RegExp(`\\s(${CODES.source})(?=\\s|·|—|-|$)`).exec(t);
  if (!m) return null;
  const name = t.slice(0, m.index).replace(/[（(]\s*$/, "").trim();
  if (!name) return null; // 只有代码没有名称的标题不清洗
  const codes = m[1].split(/\s*\/\s*/).map(normalizeOne).join(" / ");
  return { name, codes };
}
