import { renderCard } from "./render-card.js";

const CN_MONTH = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];

function monthLabel(date) {
  const [y, m] = date.split("-");
  return `${y} · ${CN_MONTH[parseInt(m, 10) - 1]}月`;
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
  return template.replace("<!-- CARDS -->", () => parts.join("\n"));
}
