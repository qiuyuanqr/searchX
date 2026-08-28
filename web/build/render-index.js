import { renderCard, escapeHtml } from "./render-card.js";

// 简报式首页（2026-08-26 晚改版）：一天一张卡，卡头是「YYYY 年 M 月 D 日 + N 篇调研 · M 个来源」，
// 卡内按当天顺序列条目（renderCard）。条目编号由 CSS 计数器画，类型筛选后自动重排、不留空号。
function dayLabel(date) {
  const [y, m, d] = String(date).split("-");
  return `${y} 年 ${parseInt(m, 10)} 月 ${parseInt(d, 10)} 日`;
}

function renderDay(date, dayEntries) {
  // 旧报告（已有更新版）不再出条目（renderCard 返回空串），计数也只算真正展示的；
  // 一天全是旧篇时整卡不出——否则会出现「N 篇调研」的空卡。
  const shown = dayEntries.filter((e) => !(e.series && e.series.newerHref));
  if (!shown.length) return "";
  const n = shown.length;
  // sourceCount 可能缺失或是脏数据（上游已有转义守卫）：只把能解析成正数的记入合计
  const src = shown.reduce((s, e) => {
    const v = Number(e.sourceCount);
    return s + (Number.isFinite(v) && v > 0 ? v : 0);
  }, 0);
  const meta = `${n} 篇调研` + (src > 0 ? ` · ${src} 个来源` : "");
  return `<li class="day-card" data-date="${escapeHtml(date)}">
  <div class="day-head"><span class="day-date">${dayLabel(date)}</span><span class="day-meta">${meta}</span></div>
  <div class="day-entries">
${shown.map(renderCard).join("\n")}
  </div>
</li>`;
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

// entries 已按新→旧排序（见 scan.compareByNewest）。按 date 分组成天卡，组内保持原顺序。
export function renderIndex(entries, template) {
  const days = [];                     // [{ date, entries: [...] }]，保持首现顺序
  const byDate = new Map();
  for (const e of entries) {
    let day = byDate.get(e.date);
    if (!day) { day = { date: e.date, entries: [] }; byDate.set(e.date, day); days.push(day); }
    day.entries.push(e);
  }
  const parts = days.map((d) => renderDay(d.date, d.entries));
  // chips 计数按真正展示的条目算（旧报告不再出条目），否则「股票 103」会把隐藏的旧篇也数进去
  const shownEntries = entries.filter((e) => !(e.series && e.series.newerHref));
  // 函数形式替换：字符串形式会解释替换值里的 $ 模式（$'、$& 等），标题/导语里出现这类
  // 序列（财经文本写美元符时常见）会静默复制模板尾部、损坏首页结构。
  return template
    .replace("<!-- CHIPS -->", () => renderChips(shownEntries))
    .replace("<!-- CARDS -->", () => parts.join("\n"));
}
