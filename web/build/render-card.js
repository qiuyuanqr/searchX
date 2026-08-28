import { cleanStockTitle } from "./clean-title.js";
import { extractDirection, stripLeadBoilerplate } from "./extract-direction.js";
import { seriesBadgeHtml, seriesHistoryHtml } from "../src/assets/series-badge.js";

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 简报式条目（2026-08-26 晚改版）：一天一张卡（render-index.js 负责分组），卡内每篇是一行条目——
// 等宽编号（CSS 计数器画，筛选后自动重排）+ 加粗的「名称：结论短句」+ 补充半句 + 行尾的
// 方向标 / 类型标 + 等宽代码 + 系列角标。参照 ai-digest 的条目句式。
//
// 加粗段取导语的第一个短句（到首个 ，。；： 为止）；太长（>40 字）或切不出来就只加粗名称。
function splitLead(name, lead) {
  const text = String(lead || "");
  const clause = text.split(/[，。；：]/)[0];
  let head, rest;
  if (clause && clause.length <= 40 && clause.length < text.length) {
    head = name ? `${name}：${clause}` : clause;
    rest = text.slice(clause.length);
  } else {
    head = name || "";
    rest = name && text ? `：${text}` : text;
  }
  // 补充段只留到第一个句号：真实导语带完整的「支撑在于…主要风险…」长文，全塞进来会把
  // 行尾的代码 / 系列角标顶出两行截断的可见范围；首页是索引，细节点进报告看。
  const stop = rest.indexOf("。");
  if (stop > -1) rest = rest.slice(0, stop + 1);
  return { head, rest };
}

export function renderCard(e) {
  // 同一标的的旧报告（已有更新版）不再单独出条目（2026-08-28 用户拍板）：
  // 结论已过时，历史入口收进最新条目下的「历史调研」行。
  if (e.series && e.series.newerHref) return "";
  const isStock = e.type === "股票";
  const parsed = isStock ? cleanStockTitle(e.title) : null;

  const dir = isStock ? extractDirection(e.tldr) : null;
  // 提到方向标记后导语剥掉开头套话句，从差异化内容讲起；非股票只剥「一句话：」引子
  const leadText = isStock
    ? (dir ? stripLeadBoilerplate(e.tldr) : String(e.tldr || ""))
    : String(e.tldr || "").replace(/^一句话[：:]\s*/, "");

  const name = parsed ? parsed.name : e.title;
  const { head, rest } = splitLead(name, leadText);

  // 行尾标注（2026-08-26 用户反馈：行首挂标破坏行头一体性）：代码在前、方向标/类型字在后。
  // 放行尾的内容必须短，否则会被两行截断吞掉——导语补充段已截句，装得下。
  const tail = [];
  if (parsed) tail.push(`<span class="code">${escapeHtml(parsed.codes)}</span>`);
  if (dir) tail.push(`<span class="dir ${dir.cls}">${dir.arrow} ${escapeHtml(dir.label)}</span>`);
  else if (!isStock && e.type) tail.push(`<span class="tprefix">${escapeHtml(e.type)}</span>`);

  // 同一标的的多份报告：最新条目行尾挂「第 N 次 · X 天后」，历史各篇收进条目下方的
  // 「历史调研」行。历史行必须在 .entry 这个 <a> 之外——<a> 套 <a> 非法，浏览器会拆开、链接失效。
  const badge = seriesBadgeHtml(e.series);
  const history = seriesHistoryHtml(e.series);

  return `<div class="article-card" data-type="${escapeHtml(e.type)}">
  <a class="entry" href="${escapeHtml(e.href)}">
    <span class="num" aria-hidden="true"></span>
    <span class="eline"><span class="ehead">${escapeHtml(head)}</span>${escapeHtml(rest)}${tail.length ? " " + tail.join(" ") : ""}${badge ? " " + badge : ""}</span>
  </a>${history}
</div>`;
}
