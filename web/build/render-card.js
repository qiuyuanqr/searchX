export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderCard(e) {
  const dateDisp = e.date.replace(/-/g, " · ");
  const srcs = e.sourceCount ? `${e.sourceCount} 来源` : "";
  // 板块标签只在「股票」类报告显示（非股票项目不显示板块）；data-boards 始终保留供筛选
  const boardTag =
    e.type === "股票" && e.boards.length
      ? `<span class="boards">${escapeHtml(e.boards.join(" · "))}</span>`
      : "";
  return `<li class="article-card" data-type="${escapeHtml(e.type)}" data-boards="${escapeHtml(e.boards.join(","))}">
  <a class="card-link" href="${escapeHtml(e.href)}">
    <div class="card-top"><span class="ctype">${escapeHtml(e.type)}</span><span class="cdate">${escapeHtml(dateDisp)}</span></div>
    <h2 class="card-title">${escapeHtml(e.title)}</h2>
    <p class="lead">${escapeHtml(e.tldr)}</p>
    <div class="card-foot">${boardTag}<span class="srcs">${escapeHtml(srcs)}</span></div>
  </a>
</li>`;
}
