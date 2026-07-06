// web/src/assets/md.js — 事实核查结果的自包含 markdown 渲染器（纯函数，零依赖，可单测）。
// 只覆盖 factcheck 笔记正文用到的子集：## 标题 / 管道表格 / 有无序列表 / 行内链接 / 加粗 /
// 行内代码 / 引用 / [[双链]]（网页无 Obsidian 图谱，降级为纯文本）。
// 安全：全程先转义 HTML，再套我们自己生成的标签；链接仅放行 http(s) 且加 rel。
// check.html 是严格 CSP（script-src 'self'），即便漏了转义也无法执行脚本——此为双保险。

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 行内格式：先转义，再依次处理双链→链接→加粗→行内代码。
function renderInline(raw) {
  let s = escapeHtml(raw);
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_, t) => t);                 // [[X]] → X
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, label, url) => { // [text](url)
    if (!/^https?:\/\//i.test(url)) return label;                 // 非 http(s) 退化为纯文字
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");       // **x**
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");                 // `x`
  return s;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

// 分隔行：形如 |---|:--:|---| （至少含一个 -）
function isTableSep(line) {
  return !!line && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");
}

function renderTable(header, rows) {
  const th = header.map((c) => `<th>${renderInline(c)}</th>`).join("");
  const trs = rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

function isBlockStart(line, next) {
  if (/^#{1,6}\s+/.test(line)) return true;
  if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) return true;
  if (/^\s*>\s?/.test(line)) return true;
  if (/^\s*\|/.test(line) && isTableSep(next)) return true;
  return false;
}

export function renderMarkdown(md) {
  const lines = String(md == null ? "" : md).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }                    // 空行

    const h = /^(#{1,6})\s+(.*)$/.exec(line);                      // 标题
    if (h) { out.push(`<h${h[1].length}>${renderInline(h[2].trim())}</h${h[1].length}>`); i++; continue; }

    if (/^\s*\|/.test(line) && isTableSep(lines[i + 1])) {         // 表格
      const header = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      out.push(renderTable(header, rows));
      continue;
    }

    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {   // 列表
      const ordered = /^\s*\d+\.\s+/.test(line);
      const re = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*]\s+(.*)$/;
      const items = [];
      while (i < lines.length && re.test(lines[i])) { items.push(re.exec(lines[i])[1]); i++; }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((it) => `<li>${renderInline(it.trim())}</li>`).join("")}</${tag}>`);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {                                   // 引用
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      out.push(`<blockquote>${renderInline(quote.join(" ").trim())}</blockquote>`);
      continue;
    }

    const para = [];                                              // 普通段落
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i], lines[i + 1])) { para.push(lines[i]); i++; }
    out.push(`<p>${renderInline(para.join(" ").trim())}</p>`);
  }
  return out.join("\n");
}
