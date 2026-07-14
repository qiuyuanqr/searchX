export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderCard(e) {
  const dateDisp = e.date.replace(/-/g, "·"); // 2026-06-03 → 2026·06·03
  const srcMeta = e.sourceCount ? ` · ${escapeHtml(e.sourceCount)} 来源` : "";
  const lead = e.tldr ? `<p class="lead">${escapeHtml(e.tldr)}</p>` : "";
  return `<li class="article-card" data-type="${escapeHtml(e.type)}">
  <a class="card-link" href="${escapeHtml(e.href)}">
    <span class="ctype">${escapeHtml(e.type)}</span>
    <div class="card-body">
      <h2 class="card-title">${escapeHtml(e.title)}</h2>
      ${lead}
      <div class="card-meta">${escapeHtml(dateDisp)}${srcMeta}</div>
    </div>
  </a>
</li>`;
}
