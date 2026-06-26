import { boardsOf } from "./boards.js";

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderCard(e) {
  const dateDisp = e.date.replace(/-/g, "·"); // 2026-06-03 → 2026·06·03
  const boards = boardsOf(e.boards);
  const srcMeta = e.sourceCount ? ` · ${e.sourceCount} 来源` : "";
  const boardMeta = boards.length ? ` · ${escapeHtml(boards.join(" · "))}` : "";
  const lead = e.tldr ? `<p class="lead">${escapeHtml(e.tldr)}</p>` : "";
  // data-boards 仍写入全部原始 boards：筛选 chip 只匹配 5 大板块名，多余值无害且保留向后兼容。
  return `<li class="article-card" data-type="${escapeHtml(e.type)}" data-boards="${escapeHtml((e.boards || []).join(","))}">
  <a class="card-link" href="${escapeHtml(e.href)}">
    <span class="ctype">${escapeHtml(e.type)}</span>
    <div class="card-body">
      <h2 class="card-title">${escapeHtml(e.title)}</h2>
      ${lead}
      <div class="card-meta">${escapeHtml(dateDisp)}${srcMeta}${boardMeta}</div>
    </div>
  </a>
</li>`;
}
