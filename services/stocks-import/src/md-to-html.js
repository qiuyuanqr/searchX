// Markdown → HTML，**只覆盖 Stocks 报告真实用到的那一小撮语法**。
//
// 为什么不引一个 markdown 库：对 25 篇存量做过构造普查，全部正文只有
// 标题(h1–h3) / 引用块 / 有序无序列表(含嵌套) / 围栏代码块 / 分隔线 / 段落，
// 行内只有 **加粗**、[文字](链接)。**零表格、零图片、零内嵌 HTML**。
// 为这点语法拉一个依赖，换来的是构建期多一个供应链面——而报告 HTML 是原样上线
// 公开站主域的，validate-report.js 明文拦 <script>/on*= 就是冲着这个来的。
// 自己写反而能保证「输出里不可能出现标签注入」：所有文本先 escapeHtml，
// 标签只由本文件自己拼。
//
// 有意不支持的：行内 `代码`（sanitize 已把行内代码全部换成中文口径名或删掉，
// 正文里不会再有反引号）、行内 *斜体*（存量零使用，且与「**」的边界判定容易打架）。

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 只放行 http/https 外链。其余（javascript: / data: / 相对路径）一律降级成纯文本——
// validate-report.js 会在构建期硬拦 javascript: 协议链接，这里提前一步不让它生成。
function safeHref(url) {
  return /^https?:\/\//i.test(String(url).trim()) ? String(url).trim() : null;
}

// 行内：先整体转义，再把 **加粗** 与 [文字](链接) 还原成标签。
// 顺序不能反——先转义保证链接文字里的尖括号不会变成标签。
export function inline(md) {
  let s = escapeHtml(md);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, text, url) => {
    const href = safeHref(url.replace(/&amp;/g, "&"));
    if (!href) return text;
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return s;
}

const H_RE = /^(#{1,6})\s+(.+?)\s*#*$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE_RE = /^\s{0,3}```/;
const BQ_RE = /^\s*>\s?(.*)$/;
// 列表项：缩进决定层级（Stocks 报告用 2 或 3 空格缩进一层）
const LI_RE = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;

// 一个列表层级的状态
function openList(ordered) {
  return { ordered, tag: ordered ? "ol" : "ul", items: [] };
}

// 把 Stocks 报告的 markdown 正文渲染成报告模板 {{BODY}} 需要的 HTML 片段。
// baseHeading=2 表示 md 里的 `##` 渲染成 <h2>（模板正文从 h2 起）。
export function mdToHtml(md) {
  const lines = String(md).split("\n");
  const out = [];
  let para = [];
  let quote = null;         // 收集中的引用块行
  let fence = null;         // 收集中的代码块行
  const stack = [];         // 列表层级栈：[{indent, list}]

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${inline(para.join(" ").trim())}</p>`);
    para = [];
  };
  const renderList = (entry) => {
    const inner = entry.list.items.map((h) => `<li>${h}</li>`).join("\n");
    return `<${entry.list.tag}>\n${inner}\n</${entry.list.tag}>`;
  };
  // 收栈到 depth 层。收下来的子列表挂到上一层最后一个 <li> 里。
  const closeLists = (depth = 0) => {
    while (stack.length > depth) {
      const entry = stack.pop();
      const html = renderList(entry);
      if (stack.length) {
        const parent = stack[stack.length - 1].list.items;
        parent[parent.length - 1] += `\n${html}`;
      } else {
        out.push(html);
      }
    }
  };
  const flushQuote = () => {
    if (quote === null) return;
    const body = quote.filter((l) => l.trim() !== "");
    if (body.length) out.push(`<div class="callout">${inline(body.join(" "))}</div>`);
    quote = null;
  };

  for (const raw of lines) {
    // 围栏代码块：整块原样进 <pre>，只做转义
    if (FENCE_RE.test(raw)) {
      if (fence === null) { flushPara(); flushQuote(); closeLists(); fence = []; }
      else { out.push(`<pre>${escapeHtml(fence.join("\n"))}</pre>`); fence = null; }
      continue;
    }
    if (fence !== null) { fence.push(raw); continue; }

    if (raw.trim() === "") { flushPara(); flushQuote(); closeLists(); continue; }

    const bq = raw.match(BQ_RE);
    if (bq) {
      flushPara(); closeLists();
      if (quote === null) quote = [];
      quote.push(bq[1]);
      continue;
    }
    flushQuote();

    if (HR_RE.test(raw)) { flushPara(); closeLists(); continue; }  // 分隔线：模板的 h2 自带上边框，不重复画线

    const h = raw.match(H_RE);
    if (h) {
      flushPara(); closeLists();
      const level = Math.min(Math.max(h[1].length, 2), 3);   // h1 在正文里不出现（做标题用了）
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }

    const li = raw.match(LI_RE);
    if (li) {
      flushPara();
      const indent = li[1].replace(/\t/g, "  ").length;
      const ordered = li[2] === undefined;
      // 收掉比当前更深的层级
      while (stack.length && stack[stack.length - 1].indent > indent) closeLists(stack.length - 1);
      const top = stack[stack.length - 1];
      if (!top || top.indent < indent) {
        stack.push({ indent, list: openList(ordered) });
      } else if (top.list.ordered !== ordered) {
        // 同级但换了列表类型：收掉旧的、开新的
        closeLists(stack.length - 1);
        stack.push({ indent, list: openList(ordered) });
      }
      stack[stack.length - 1].list.items.push(inline(li[4]));
      continue;
    }

    // 列表项的续行（缩进的普通文本）：并进上一个 li，而不是另起段落
    if (stack.length && /^\s{2,}\S/.test(raw)) {
      const items = stack[stack.length - 1].list.items;
      items[items.length - 1] += " " + inline(raw.trim());
      continue;
    }

    closeLists();
    para.push(raw.trim());
  }

  if (fence !== null) out.push(`<pre>${escapeHtml(fence.join("\n"))}</pre>`);
  flushPara();
  flushQuote();
  closeLists();
  return out.join("\n");
}
