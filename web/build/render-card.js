import { cleanStockTitle } from "./clean-title.js";
import { extractDirection, stripLeadBoilerplate } from "./extract-direction.js";

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 高密度卡片（2026-07-14 改版）：两行结构——标题行（标题 + 右侧 月·日 · N 源）+ 导语（方向标记 + 两行截断）。
// 类型标注策略：股票是 27/39 的默认态、不再逐行挂徽章（规范化代码即身份），少数派类型（概念/板块/方法论…）
// 用标题前缀小字标注；月份分隔行已给出年份，卡内日期只需 月·日。
export function renderCard(e) {
  const [, mo, d] = e.date.split("-");
  const dateSide = `${mo}·${d}` + (e.sourceCount ? ` · ${escapeHtml(e.sourceCount)} 源` : "");

  const isStock = e.type === "股票";
  const parsed = isStock ? cleanStockTitle(e.title) : null;
  // 股票卡以代码为身份标注；解析不出代码的股票卡与非股票卡一样，回退到类型前缀 + 原始标题
  const titleHtml = parsed
    ? `${escapeHtml(parsed.name)} <span class="code">${escapeHtml(parsed.codes)}</span>`
    : (e.type ? `<span class="tprefix">${escapeHtml(e.type)} · </span>` : "") + escapeHtml(e.title);

  const dir = isStock ? extractDirection(e.tldr) : null;
  const dirHtml = dir ? `<span class="dir ${dir.cls}">${dir.arrow} ${escapeHtml(dir.label)}</span>` : "";
  // 提到方向标记后导语剥掉开头套话句，从差异化内容讲起；非股票只剥「一句话：」引子
  const leadText = isStock
    ? (dir ? stripLeadBoilerplate(e.tldr) : String(e.tldr || ""))
    : String(e.tldr || "").replace(/^一句话[：:]\s*/, "");
  const lead = (dirHtml || leadText) ? `<p class="lead">${dirHtml}${escapeHtml(leadText)}</p>` : "";

  return `<li class="article-card" data-type="${escapeHtml(e.type)}">
  <a class="card-link" href="${escapeHtml(e.href)}">
    <div class="card-body">
      <div class="title-row">
        <h2 class="card-title">${titleHtml}</h2>
        <span class="date-side">${dateSide}</span>
      </div>
      ${lead}
    </div>
  </a>
</li>`;
}
