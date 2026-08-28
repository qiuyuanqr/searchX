// 同一标的多份报告的角标。构建端（web/build/render-card.js 渲染信息流卡片）与
// 浏览器端（assets/submit.js 渲染搜索结果卡片）共用这一份，避免两处各写一套后慢慢漂移。
// 零依赖、浏览器可直接 import；assets/ 整个目录会被构建拷进 dist。
//
// 卡片外层本身就是 <a>，所以「已有更新版 →」不能塞进标题行——<a> 套 <a> 是非法 HTML，
// 浏览器会把它拆开、链接失效。它单独作为卡片内、链接之外的一行。

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 行内角标：只有第 2 次及以后才出——单篇不出，系列里最早那篇也不出
//（它的身份由「已有更新版」那行表达，再挂个「第 1 次」是噪声）。
// 2026-08-26 改版后角标落在卡片的元信息行（card-meta），不再与标题同排；
// 「X 天后」仍单独包一层，窄屏由 CSS 收起，保证「第 N 次」这个关键信号在任何宽度都看得见。
export function seriesBadgeHtml(series) {
  if (!series || !(series.index > 1)) return "";
  const gap = Number.isFinite(series.daysSincePrev) && series.daysSincePrev >= 0
    ? `<span class="series-gap"> · ${esc(series.daysSincePrev)} 天后</span>`
    : "";                                   // 间隔未知就只说第几次，不编造天数
  return `<span class="series-badge">第 ${esc(series.index)} 次${gap}</span>`;
}

// 最新条目下的「历史调研」行（2026-08-28 起替代旧篇单独展示）：旧篇不再出现在首页与
// 搜索里，历史入口收进这一行，日期新→旧、各自链到当次报告。单篇 / 旧篇不出。
export function seriesHistoryHtml(series) {
  if (!series || !Array.isArray(series.history) || !series.history.length) return "";
  const links = series.history
    .map((h) => `<a href="${esc(h.href)}">${esc(h.date)}</a>`)
    .join('<span class="series-history-dot"> · </span>');
  return `<div class="series-history">历史调研：${links}</div>`;
}
