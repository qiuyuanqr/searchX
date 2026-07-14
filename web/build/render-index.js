import { renderCard, escapeHtml } from "./render-card.js";

const CN_MONTH = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];

function monthLabel(date) {
  const [y, m] = date.split("-");
  return `${y} · ${CN_MONTH[parseInt(m, 10) - 1]}月`;
}

// 筛选 chips 按实际数据生成（带条数、按条数降序），空类型不出现——模板写死的年代
// 「人物」「事件」是 0 条的空 chip（点了空屏）、2 条的「板块」却没有 chip 可筛。
// data-filter / role / aria 结构与 feed.js 的绑定约定一致，不能改。
function renderChips(entries) {
  const counts = new Map();
  for (const e of entries) {
    if (!e.type) continue;
    counts.set(e.type, (counts.get(e.type) || 0) + 1);
  }
  const chip = (filter, label, n, on) =>
    `<span class="chip${on ? " on" : ""}" data-filter="${escapeHtml(filter)}" role="button" tabindex="0" aria-pressed="${on}">${escapeHtml(label)} <span class="n">${n}</span></span>`;
  const parts = [chip("all", "全部", entries.length, true)];
  for (const [type, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    parts.push(chip(`type:${type}`, type, n, false));
  }
  return parts.join("\n        ");
}

// entries 已按新→旧排序（见 scan.compareByNewest）。跨月边界插一行月分隔。
export function renderIndex(entries, template) {
  let lastMonth = "";
  const parts = [];
  for (const e of entries) {
    const ym = e.date.slice(0, 7); // YYYY-MM
    if (ym !== lastMonth) {
      lastMonth = ym;
      parts.push(`<li class="month-sep" data-month="${ym}">${monthLabel(e.date)}</li>`);
    }
    parts.push(renderCard(e));
  }
  // 函数形式替换：字符串形式会解释替换值里的 $ 模式（$'、$& 等），标题/导语里出现这类
  // 序列（财经文本写美元符时常见）会静默复制模板尾部、损坏首页结构。
  return template
    .replace("<!-- CHIPS -->", () => renderChips(entries))
    .replace("<!-- CARDS -->", () => parts.join("\n"));
}
