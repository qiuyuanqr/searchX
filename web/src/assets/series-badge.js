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

// 标题行里的行内角标：只有第 2 次及以后才出——单篇不出，系列里最早那篇也不出
//（它的身份由「已有更新版」那行表达，再挂个「第 1 次」是噪声）。
// 「X 天后」单独包一层：`.card-title` 是 nowrap + 省略号，角标若并进标题里，窄屏会被直接截掉
// （改了等于没改）。所以角标在标题行里是独立的 flex:none 项，且这半截在窄屏由 CSS 收起，
// 保证「第 N 次」这个关键信号在任何宽度都看得见。
export function seriesBadgeHtml(series) {
  if (!series || !(series.index > 1)) return "";
  const gap = Number.isFinite(series.daysSincePrev) && series.daysSincePrev >= 0
    ? `<span class="series-gap"> · ${esc(series.daysSincePrev)} 天后</span>`
    : "";                                   // 间隔未知就只说第几次，不编造天数
  return `<span class="series-badge">第 ${esc(series.index)} 次${gap}</span>`;
}

// 卡片底部那行「已有更新版 →」，链到紧邻的下一篇。最新那篇没有 newerHref、不出这行。
export function seriesNewerLinkHtml(series) {
  if (!series || !series.newerHref) return "";
  return `<a class="series-newer" href="${esc(series.newerHref)}">已有更新版 →</a>`;
}
