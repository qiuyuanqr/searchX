// web/build/render-archive.js — 标的「判断档案」页（2026-09-23 用户选定：走势图 + 判断表 + 时间线混搭）。
//
// 同一只票调研过两次以上，就在 /s/<6 位代码>/ 出一页：历次调研日期、当时的方向判断、
// 调研日收盘价、到下一次调研之间股价实际走了多少，以及每篇的一句话结论。
// 读者最想知道的是「之前的判断后来怎么样了」，信息流里那行日期回答不了这个问题。
//
// 行情数据：research/_series/prices.json，由 Mac mini 上的 stocks-import 每个 tick 从 Stocks 库
// daily_kline 写入（**唯一写入方**，见 services/stocks-import/src/series-prices.js）。站点在 CI 构建、
// 摸不到 Stocks 库，所以只能读仓库里这份快照。文件缺失 / 这只票不在里面时照样出页，
// 只是不画图、不列价格——判断本身不依赖行情。
//
// 口径（页脚照写给读者看）：未复权收盘价；调研日不是交易日取前一交易日；涨跌 = 两次调研日收盘之比，
// 最新一篇算到数据截止日。**只做回看、不打分**：「震荡」判断配 +24% 算对还是错，没有无争议的判法，
// 硬打分就是替读者下结论（CLAUDE.md：数据直接说话，不武断）。

import { escapeHtml } from "./render-card.js";
import { cleanStockTitle } from "./clean-title.js";
import { extractDirection, stripLeadBoilerplate } from "./extract-direction.js";

const YMD_RE = /^\d{8}$/;

// "2026-09-09" → "20260909"；格式不对返回 ""。
function toYmd(date) {
  const s = String(date || "").replace(/-/g, "");
  return YMD_RE.test(s) ? s : "";
}

// "20260909" → "2026-09-09"
function fmtYmd(ymd) {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

// 取「调研日当天或之前最近一个交易日」的收盘。points 升序 [[yyyymmdd, close], …]。
// 调研日早于行情起点 → null（不拿之后的价格冒充当天）。
export function closeOnOrBefore(points, date) {
  const ymd = toYmd(date);
  if (!ymd || !Array.isArray(points)) return null;
  let found = null;
  for (const p of points) {
    if (!Array.isArray(p) || !YMD_RE.test(String(p[0])) || !Number.isFinite(p[1])) continue;
    if (p[0] <= ymd) found = p;
    else break;
  }
  return found ? { date: found[0], close: found[1] } : null;
}

const CONF_RE = /置信度[：:]?\s*([高中低])/;

// 一句话结论：剥掉方向套话（方向已单独显示），取第一句；太长截断。
function leadOf(tldr, hasDir) {
  let t = hasDir ? stripLeadBoilerplate(tldr) : String(tldr || "").replace(/^一句话[：:]\s*/, "");
  t = t.trim();
  const stop = t.indexOf("。");
  if (stop > -1) t = t.slice(0, stop + 1);
  return t.length > 150 ? t.slice(0, 148) + "…" : t;
}

// 历次调研 → 行（旧→新）。points 为这只票的收盘序列（可为空）。
// change：本次调研日收盘 → 下一次调研日收盘（最新一篇 → 数据截止日收盘）的涨跌，小数。
// 两端取到的是同一个交易日（例如两篇同一周末写、或最新一篇晚于数据截止日）→ null，不显示 0%。
export function archiveRows(entries, points = []) {
  const ordered = [...entries].sort(
    (a, b) => String(a.date).localeCompare(String(b.date)) || String(a.href).localeCompare(String(b.href)),
  );
  const last = Array.isArray(points) && points.length ? points[points.length - 1] : null;
  const rows = ordered.map((e, i) => {
    const dir = extractDirection(e.tldr);
    const conf = (String(e.tldr || "").match(CONF_RE) || [])[1] || null;
    return {
      n: i + 1,
      date: String(e.date || ""),
      href: e.href,
      dir,
      conf,
      lead: leadOf(e.tldr, !!dir),
      close: closeOnOrBefore(points, e.date),
    };
  });
  rows.forEach((r, i) => {
    const nextClose = i < rows.length - 1
      ? rows[i + 1].close
      : (last && YMD_RE.test(String(last[0])) && Number.isFinite(last[1]) ? { date: last[0], close: last[1] } : null);
    r.toLatest = i === rows.length - 1;
    r.change = r.close && nextClose && nextClose.date > r.close.date && r.close.close > 0
      ? nextClose.close / r.close.close - 1
      : null;
  });
  return rows;
}

function fmtPct(x) {
  if (x == null || !Number.isFinite(x)) return "—";
  const v = Math.round(x * 1000) / 10;
  if (v === 0) return "0.0%";
  return (v > 0 ? "+" : "−") + Math.abs(v).toFixed(1) + "%";
}

function pctCls(x) {
  if (x == null || !Number.isFinite(x) || Math.round(x * 1000) === 0) return "";
  return x > 0 ? "up" : "down";
}

// 走势图（纯 SVG、零脚本：档案页 CSP 不放行任何脚本）。
// x 轴按交易日序号排（周末不留空档），每次调研在当日收盘处打一个带序号的点，最新一次用主色。
export function chartSvg(points, rows) {
  const pts = (Array.isArray(points) ? points : [])
    .filter((p) => Array.isArray(p) && YMD_RE.test(String(p[0])) && Number.isFinite(p[1]));
  if (pts.length < 2) return "";
  const W = 640, H = 220, padL = 52, padR = 16, padT = 16, padB = 30;
  const closes = pts.map((p) => p[1]);
  let lo = Math.min(...closes), hi = Math.max(...closes);
  const span = hi - lo || hi || 1;
  lo -= span * 0.06; hi += span * 0.06;
  const x = (i) => padL + (i * (W - padL - padR)) / (pts.length - 1);
  const y = (c) => padT + ((hi - c) / (hi - lo)) * (H - padT - padB);
  const r1 = (v) => Math.round(v * 10) / 10;
  const line = pts.map((p, i) => `${r1(x(i))},${r1(y(p[1]))}`).join(" ");
  const idx = new Map(pts.map((p, i) => [p[0], i]));
  const marks = rows
    .filter((r) => r.close && idx.has(r.close.date))
    .map((r, k, arr) => {
      const i = idx.get(r.close.date);
      const latest = k === arr.length - 1 && r === rows[rows.length - 1];
      const cls = latest ? "latest" : (r.dir ? r.dir.cls : "flat");
      return `<g class="arch-mk ${cls}"><circle cx="${r1(x(i))}" cy="${r1(y(r.close.close))}" r="${latest ? 9 : 8}"/>`
        + `<text x="${r1(x(i))}" y="${r1(y(r.close.close))}" dy=".35em" text-anchor="middle">${r.n}</text></g>`;
    })
    .join("");
  const fmtC = (c) => (Math.round(c * 100) / 100).toFixed(2);
  const first = pts[0], lastP = pts[pts.length - 1];
  const label = `收盘价走势 ${fmtYmd(first[0])} 至 ${fmtYmd(lastP[0])}，区间最低 ${fmtC(Math.min(...closes))}、最高 ${fmtC(Math.max(...closes))}，圆点为历次调研日`;
  return `<svg class="arch-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(label)}">`
    + `<line class="arch-axis" x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}"/>`
    + `<text class="arch-tick y" x="${padL - 8}" y="${r1(y(Math.max(...closes)) + 4)}" text-anchor="end">${fmtC(Math.max(...closes))}</text>`
    + `<text class="arch-tick y" x="${padL - 8}" y="${r1(y(Math.min(...closes)) + 4)}" text-anchor="end">${fmtC(Math.min(...closes))}</text>`
    + `<text class="arch-tick" x="${padL}" y="${H - 10}" text-anchor="start">${fmtYmd(first[0])}</text>`
    + `<text class="arch-tick" x="${W - padR}" y="${H - 10}" text-anchor="end">${fmtYmd(lastP[0])}</text>`
    + `<polyline class="arch-line" points="${line}"/>`
    + `<circle class="arch-now" cx="${r1(x(pts.length - 1))}" cy="${r1(y(lastP[1]))}" r="3"/>`
    + marks
    + `</svg>`;
}

function dirHtml(dir) {
  return dir ? `<span class="dir ${escapeHtml(dir.cls)}">${dir.arrow} ${escapeHtml(dir.label)}</span>` : `<span class="arch-muted">—</span>`;
}

function diffText(prev, cur) {
  if (!prev) return "";
  const parts = [];
  if (prev.dir && cur.dir) {
    parts.push(prev.dir.label === cur.dir.label ? "方向不变" : `方向由「${prev.dir.label}」转为「${cur.dir.label}」`);
  }
  if (prev.conf && cur.conf && prev.conf !== cur.conf) parts.push(`置信度由${prev.conf}转为${cur.conf}`);
  return parts.length ? `较上次：${parts.join("，")}` : "";
}

// 整页。group = 同一系列的 entries（顺序不限）；prices = prices.json 解析结果（可为 null）。
export function renderArchivePage({ code, entries, prices = null }) {
  const points = prices && prices.codes && Array.isArray(prices.codes[code]) ? prices.codes[code] : [];
  const rows = archiveRows(entries, points);
  const latest = rows[rows.length - 1];
  const latestEntry = entries.find((e) => e.href === latest.href) || entries[0];
  const parsed = cleanStockTitle(latestEntry.title);
  const name = parsed ? parsed.name : String(latestEntry.title || code);
  const codes = parsed ? parsed.codes : code;
  const hasPrices = rows.some((r) => r.close);
  const asOf = prices && YMD_RE.test(String(prices.asOf)) ? fmtYmd(String(prices.asOf)) : "";
  const sameYear = rows.every((r) => r.date.slice(0, 4) === rows[0].date.slice(0, 4));
  const shortDate = (d) => (sameYear ? d.slice(5) : d);

  const dirCount = new Map();
  for (const r of rows) if (r.dir) dirCount.set(r.dir.label, (dirCount.get(r.dir.label) || 0) + 1);
  const dirSum = [...dirCount].map(([k, v]) => `${k} ×${v}`).join(" · ");

  const table = `<table class="arch-table">
<thead><tr><th>调研</th><th>当时判断</th>${hasPrices ? "<th>调研日收盘</th><th>之后到下一次</th>" : ""}</tr></thead>
<tbody>${[...rows].reverse().map((r) => `<tr${r === latest ? ' class="latest"' : ""}>
<td><a href="../../${escapeHtml(r.href)}"><span class="arch-n">${r.n}</span><span class="mono">${escapeHtml(shortDate(r.date))}</span></a></td>
<td>${dirHtml(r.dir)}${r.conf ? `<span class="arch-conf">置信度${escapeHtml(r.conf)}</span>` : ""}</td>
${hasPrices ? `<td class="mono">${r.close ? (Math.round(r.close.close * 100) / 100).toFixed(2) + (toYmd(r.date) !== r.close.date ? `<span class="arch-cd">${escapeHtml(fmtYmd(r.close.date).slice(5))}</span>` : "") : "—"}</td>
<td class="mono ${pctCls(r.change)}">${fmtPct(r.change)}${r.toLatest && r.close ? `<span class="arch-cd">${r.change != null ? "至今" : "尚无后续行情"}</span>` : ""}</td>` : ""}
</tr>`).join("")}</tbody>
</table>`;

  const timeline = `<ol class="arch-tl">${[...rows].reverse().map((r, k, arr) => {
    const prev = arr[k + 1] || null;
    const diff = diffText(prev, r);
    return `<li class="arch-tl-item${r === latest ? " latest" : ""}">
<div class="arch-tl-meta"><a class="mono" href="../../${escapeHtml(r.href)}">${escapeHtml(r.date)}</a><span class="arch-n-text">第 ${r.n} 次</span>${dirHtml(r.dir)}${r.conf ? `<span class="arch-conf">置信度${escapeHtml(r.conf)}</span>` : ""}</div>
${r.lead ? `<p class="arch-tl-lead">${escapeHtml(r.lead)}</p>` : ""}${diff ? `<p class="arch-tl-diff">${escapeHtml(diff)}</p>` : ""}
</li>`;
  }).join("")}</ol>`;

  const chart = hasPrices ? chartSvg(points, rows) : "";
  const foot = hasPrices
    ? `收盘价取自 Stocks 行情库（未复权），数据截至 ${escapeHtml(asOf)}。调研日不是交易日时取前一个交易日收盘（表中小字为实际取价日）。「之后到下一次」是相邻两次调研日收盘价之比，最新一篇算到数据截止日；区间内若有分红送转会有偏差。只作回看，不构成买卖建议。`
    : `暂无这只票的行情数据，只列历次判断。只作回看，不构成买卖建议。`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(name)} ${escapeHtml(codes)} · 判断档案 · SearchX</title>
<link rel="icon" type="image/png" href="../../assets/favicon.png">
<link rel="apple-touch-icon" href="../../assets/apple-touch-icon.png">
<link rel="stylesheet" href="../../assets/feed.css">
</head>
<body data-pagefind-ignore>
  <header class="topbar">
    <div class="topbar-in">
      <a class="brand-name" href="../../index.html">SearchX 调研档案</a>
      <nav class="topnav"><a class="nav-link" href="../../index.html">返回首页</a></nav>
    </div>
  </header>
  <div class="wrap arch">
    <div class="arch-head">
      <h1 class="arch-title">${escapeHtml(name)} <span class="code">${escapeHtml(codes)}</span></h1>
      <p class="arch-sub">判断档案 · ${rows.length} 次调研 · ${escapeHtml(rows[0].date)} 至 ${escapeHtml(latest.date)}${dirSum ? ` · 方向：${escapeHtml(dirSum)}` : ""}</p>
    </div>
${chart ? `    <section class="arch-card">${chart}<p class="arch-cap">圆点里的数字是第几次调研，最新一次用主色标出；灰线为每日收盘。</p></section>\n` : ""}    <section class="arch-card">
      <h2 class="arch-h">历次判断与之后的走势</h2>
      ${table}
    </section>
    <section class="arch-card">
      <h2 class="arch-h">每次说了什么</h2>
      ${timeline}
    </section>
    <p class="arch-foot">${foot}</p>
  </div>
</body>
</html>
`;
}
