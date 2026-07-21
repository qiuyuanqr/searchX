// report.html（research/stock skill 的全文成品）→ 完整 Obsidian Markdown 笔记。
//
// 为什么要它：Obsidian 一侧长期只同步了精简版 notes.md（概要）。用户要的是「全文 + 中文名」。
// 全文只存在于 report.html（模板产物，无 markdown 源），所以这里把 report.html 转成干净的
// Obsidian markdown，frontmatter/双链沿用同目录的 notes.md（保住图谱），文件名另由 INDEX 的中文对象名给。
//
// 设计要点：
// - 无第三方依赖（CI 用 --frozen-lockfile，且不想引 pandoc 这种系统二进制）。report.html 是固定模板产物，
//   标签集有界、块级不嵌套（列表不套列表，仅 div.case/callout/limitation 内含 p/ul/table），
//   用一个小型、宽松的 DOM 解析 + 渲染器足矣。
// - 纯函数（parseHtml / renderInline / renderBlocks / extractReport / buildObsidianNote …）与文件 IO 分离，
//   便于 bun test hermetic 覆盖；CLI 只在 import.meta.main 时执行。

const VOID_TAGS = new Set(["br", "img", "hr", "meta", "input", "col", "wbr"]);

// —— HTML 解析（宽松、面向机器生成的良构 HTML）——

function parseAttrs(s) {
  const attrs = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let m;
  // 属性值里的实体要解码：href 里 `&amp;` 是 URL 里字面 `&` 的 HTML 编码，
  // 不解码会让 markdown 链接指向 `…&amp;…`（错误目标）。
  while ((m = re.exec(s))) attrs[m[1].toLowerCase()] = decodeEntities(m[2]);
  return attrs;
}

function tokenize(html) {
  const out = [];
  // 注释 | 起止标签。属性值里不含 '>'（模板如此），故 [^>]* 够用。
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(html))) {
    if (m.index > last) out.push({ type: "text", value: html.slice(last, m.index) });
    last = re.lastIndex;
    if (m[0].startsWith("<!--")) continue;
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    if (closing) out.push({ type: "close", name });
    else out.push({ type: "open", name, attrs: parseAttrs(m[3]), selfClose: m[4] === "/" });
  }
  if (last < html.length) out.push({ type: "text", value: html.slice(last) });
  return out;
}

export function parseHtml(html) {
  const root = { tag: "#root", children: [] };
  const stack = [root];
  for (const t of tokenize(html)) {
    const top = stack[stack.length - 1];
    if (t.type === "text") {
      if (t.value) top.children.push({ tag: "#text", value: t.value });
    } else if (t.type === "open") {
      const node = { tag: t.name, attrs: t.attrs, children: [] };
      top.children.push(node);
      if (!t.selfClose && !VOID_TAGS.has(t.name)) stack.push(node);
    } else if (t.type === "close") {
      // 从栈顶往下找同名开标签闭合；找不到就忽略（宽松，不因个别错配崩掉）。
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === t.name) {
          stack.length = i;
          break;
        }
      }
    }
  }
  return root.children;
}

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, n) => NAMED_ENTITIES[n]);
}

function codePoint(n) {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

// —— 树查找工具 ——

function walk(nodes, cb) {
  for (const n of nodes) {
    cb(n);
    if (n.children) walk(n.children, cb);
  }
}

function findFirst(nodes, pred) {
  let found = null;
  walk(nodes, (n) => {
    if (!found && pred(n)) found = n;
  });
  return found;
}

function hasClass(n, cls) {
  return !!n.attrs && (n.attrs.class || "").split(/\s+/).includes(cls);
}

function el(tag, cls) {
  return (n) => n.tag === tag && (cls ? hasClass(n, cls) : true);
}

// —— 行内渲染 ——

export function renderInline(nodes, opt = {}) {
  let out = "";
  for (const n of nodes) {
    if (n.tag === "#text") {
      out += decodeEntities(n.value).replace(/\s+/g, " ");
    } else if (n.tag === "br") {
      out += opt.inCell ? "<br>" : "\n";
    } else if (n.tag === "strong" || n.tag === "b") {
      const inner = renderInline(n.children, opt).trim();
      out += inner ? `**${inner}**` : "";
    } else if (n.tag === "em" || n.tag === "i") {
      const inner = renderInline(n.children, opt).trim();
      out += inner ? `*${inner}*` : "";
    } else if (n.tag === "code") {
      out += "`" + renderInline(n.children, opt).trim() + "`";
    } else if (n.tag === "a") {
      const href = (n.attrs && n.attrs.href) || "";
      const text = renderInline(n.children, opt).trim();
      out += href ? `[${text || href}](${href})` : text;
    } else {
      // small.src-note / span / 其它行内容器：拆掉包裹、保留文字
      out += renderInline(n.children || [], opt);
    }
  }
  return out;
}

// —— 块级渲染 ——

export function renderBlocks(nodes) {
  const blocks = [];
  for (const n of nodes) {
    if (n.tag === "#text") {
      const t = decodeEntities(n.value).replace(/\s+/g, " ").trim();
      if (t) blocks.push(t);
    } else if (/^h[1-6]$/.test(n.tag)) {
      const level = Number(n.tag[1]);
      blocks.push("#".repeat(level) + " " + renderInline(n.children).trim());
    } else if (n.tag === "p") {
      const t = renderInline(n.children).trim();
      if (t) blocks.push(t);
    } else if (n.tag === "ul") {
      blocks.push(renderList(n, false));
    } else if (n.tag === "ol") {
      blocks.push(renderList(n, true));
    } else if (n.tag === "table") {
      blocks.push(renderTable(n));
    } else if (n.tag === "div") {
      blocks.push(renderCallout(n));
    } else if (n.tag === "blockquote") {
      const inner = renderBlocks(n.children).trim();
      blocks.push(inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
    } else {
      const inner = renderBlocks(n.children || []);
      if (inner) blocks.push(inner);
    }
  }
  return blocks.filter((b) => b && b.trim()).join("\n\n");
}

function renderList(node, ordered) {
  const items = node.children.filter((c) => c.tag === "li");
  return items
    .map((li, i) => {
      const marker = ordered ? `${i + 1}.` : "-";
      const content = renderInline(li.children).replace(/\s*\n\s*/g, " ").trim();
      return `${marker} ${content}`;
    })
    .join("\n");
}

function renderTable(node) {
  let caption = "";
  const headRows = [];
  const bodyRows = [];
  const collectRows = (container, target) => {
    for (const c of container.children) if (c.tag === "tr") target.push(c);
  };
  for (const c of node.children) {
    if (c.tag === "caption") caption = renderInline(c.children).trim();
    else if (c.tag === "thead") collectRows(c, headRows);
    else if (c.tag === "tbody") collectRows(c, bodyRows);
    else if (c.tag === "tr") bodyRows.push(c);
  }
  const cellText = (cell) =>
    renderInline(cell.children, { inCell: true }).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  const rowCells = (tr) => tr.children.filter((c) => c.tag === "th" || c.tag === "td").map(cellText);

  let header = headRows.length ? rowCells(headRows[0]) : null;
  const rest = [...bodyRows];
  if (!header && rest.length) header = rowCells(rest.shift()); // 无 thead：拿首行当表头

  const lines = [];
  if (caption) lines.push(`**${caption}**`, "");
  if (header && header.length) {
    lines.push("| " + header.join(" | ") + " |");
    lines.push("| " + header.map(() => "---").join(" | ") + " |");
  }
  for (const tr of rest) lines.push("| " + rowCells(tr).join(" | ") + " |");
  return lines.join("\n");
}

function renderCallout(div) {
  const cls = (div.attrs && div.attrs.class) || "";
  let admon = null;
  let title = "";
  if (/\bcase\b/.test(cls)) {
    admon = "example";
    title = "案例";
  } else if (/\bcallout\b/.test(cls)) {
    admon = "note";
  } else if (/\blimitation\b/.test(cls)) {
    admon = "warning";
    title = "数据局限";
  }
  const inner = renderBlocks(div.children).trim();
  if (!admon) return inner; // 未知 div：只保留内部块
  const head = title ? `> [!${admon}] ${title}` : `> [!${admon}]`;
  const body = inner
    .split("\n")
    .map((l) => (l.length ? `> ${l}` : ">"))
    .join("\n");
  return `${head}\n${body}`;
}

// —— 从 report.html 抽取各区块 ——

function sliceBody(html) {
  const i = html.indexOf("<body>");
  const j = html.indexOf("</body>");
  return i >= 0 && j > i ? html.slice(i + "<body>".length, j) : html;
}

function stripLabel(children) {
  return children.filter((c) => !(c.tag === "span" && hasClass(c, "lbl")));
}

function liTexts(container) {
  if (!container) return [];
  const ul = findFirst(container.children, (n) => n.tag === "ul" || n.tag === "ol");
  if (!ul) return [];
  return ul.children.filter((c) => c.tag === "li").map((li) => renderInline(li.children).replace(/\s*\n\s*/g, " ").trim());
}

function extractGlossary(sec) {
  const dl = findFirst(sec.children, el("dl"));
  if (!dl) return [];
  const out = [];
  let term = null;
  for (const c of dl.children) {
    if (c.tag === "dt") term = renderInline(c.children).trim();
    else if (c.tag === "dd") {
      out.push({ term: term || "", def: renderInline(c.children).replace(/\s+/g, " ").trim() });
      term = null;
    }
  }
  return out;
}

function extractSources(sec) {
  const ol = findFirst(sec.children, (n) => n.tag === "ol" || n.tag === "ul");
  if (!ol) return [];
  return ol.children
    .filter((c) => c.tag === "li")
    .map((li) => {
      let type = "";
      let title = "";
      let href = "";
      let date = "";
      let summary = "";
      for (const c of li.children) {
        if (c.tag === "span" && (c.attrs.class || "").includes("src-tag")) type = renderInline(c.children).trim();
        else if (c.tag === "a") {
          title = renderInline(c.children).trim();
          href = (c.attrs && c.attrs.href) || "";
        } else if (c.tag === "em") date = renderInline(c.children).trim();
        else summary += c.tag === "#text" ? decodeEntities(c.value) : renderInline([c]);
      }
      summary = summary.replace(/\s+/g, " ").replace(/^[\s—–-]+/, "").trim();
      return { type, title, href, date, summary };
    });
}

export function extractReport(reportHtml) {
  const nodes = parseHtml(sliceBody(reportHtml));
  const h1 = findFirst(nodes, el("h1"));
  const plainDiv = findFirst(nodes, el("div", "plain"));
  const tldrDiv = findFirst(nodes, el("div", "tldr"));
  const findingsDiv = findFirst(nodes, el("div", "findings"));
  const main = findFirst(nodes, el("main"));
  const risksSec = findFirst(nodes, el("section", "risks"));
  const glossSec = findFirst(nodes, el("section", "glossary"));
  const srcSec = findFirst(nodes, el("section", "sources"));

  return {
    title: h1 ? renderInline(h1.children).trim() : "",
    plain: plainDiv ? renderInline(stripLabel(plainDiv.children)).replace(/\s+/g, " ").trim() : "",
    tldr: tldrDiv ? renderInline(stripLabel(tldrDiv.children)).replace(/\s+/g, " ").trim() : "",
    findings: liTexts(findingsDiv),
    bodyMd: main ? renderBlocks(main.children) : "",
    glossary: glossSec ? extractGlossary(glossSec) : [],
    risks: liTexts(risksSec),
    sources: srcSec ? extractSources(srcSec) : [],
  };
}

// —— frontmatter / 双链 ——

export function splitFrontmatter(md) {
  const m = String(md).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { frontmatter: "", body: String(md) };
  return { frontmatter: m[1], body: String(md).slice(m[0].length) };
}

export function collectWikilinks(md) {
  const set = new Set();
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(String(md)))) set.add(m[1].split("|")[0].trim());
  return [...set];
}

// —— 组装完整 Obsidian 笔记 ——

export function buildObsidianNote(reportHtml, notesMd) {
  const { frontmatter, body } = splitFrontmatter(notesMd);
  const r = extractReport(reportHtml);

  const fmLinks = new Set(collectWikilinks(frontmatter)); // frontmatter 的 related 板块双链
  const extraLinks = collectWikilinks(body).filter((l) => !fmLinks.has(l)); // 正文里的其它双链，补进「关联笔记」保住图谱

  const out = [];
  if (frontmatter.trim()) {
    out.push("---");
    out.push(frontmatter); // 原样搬运，不重排、不丢字段
    out.push("---");
    out.push("");
  }
  if (r.title) out.push(`# ${r.title}`);
  if (r.tldr) {
    out.push("");
    out.push(`> **核心结论**　${r.tldr.replace(/\n+/g, " ")}`);
  }
  if (r.plain) {
    out.push("", "## 先说人话", "", r.plain.replace(/\n+/g, " "));
  }
  if (r.findings.length) {
    out.push("", "## 关键发现", "");
    for (const f of r.findings) out.push(`- ${f}`);
  }
  if (r.bodyMd) out.push("", r.bodyMd);
  if (r.glossary.length) {
    out.push("", "## 名词小抄", "");
    for (const g of r.glossary) out.push(`- **${g.term}**：${g.def}`);
  }
  if (r.risks.length) {
    out.push("", "## 风险与争议", "");
    for (const x of r.risks) out.push(`- ${x}`);
  }
  if (r.sources.length) {
    out.push("", "## 来源清单", "");
    r.sources.forEach((s, i) => {
      const tag = s.type ? `[${s.type}] ` : "";
      const link = s.href ? `[${s.title || s.href}](${s.href})` : s.title;
      const dateClean = s.date && !/^[\s—–-]+$/.test(s.date) ? s.date : ""; // 破折号占位（无日期）不渲染
      const date = dateClean ? ` — ${dateClean}` : "";
      const sum = s.summary ? ` — ${s.summary}` : "";
      out.push(`${i + 1}. ${tag}${link}${date}${sum}`);
    });
  }
  if (extraLinks.length) {
    out.push("", "## 关联笔记", "", extraLinks.map((l) => `[[${l}]]`).join(" · "));
  }
  out.push("");
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

// —— 文件名（中文，来自 INDEX「对象」列）——

export function sanitizeFilename(name) {
  return String(name)
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\//g, "／") // 斜杠是路径分隔符，换全角
    .replace(/:/g, "：") // ASCII 冒号在部分文件系统非法，换全角
    .replace(/[\\*?"<>|]/g, "")
    .trim();
}

// —— 读一个归档文件夹，产出笔记内容（IO 与纯函数的边界）——

export async function noteFromFolder(folderPath) {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const reportHtml = await readFile(join(folderPath, "report.html"), "utf8");
  const notesMd = await readFile(join(folderPath, "notes.md"), "utf8");
  return buildObsidianNote(reportHtml, notesMd);
}

// —— CLI：把单个文件夹写进 Obsidian ——
//   bun run scripts/report-to-obsidian.js <folder> --vault <OBSIDIAN_VAULT> --name "<中文名>"
// vault 私有路径一律经参数/环境传入，绝不硬编码进本文件（它入库、公开）。

if (import.meta.main) {
  const args = process.argv.slice(2);
  const positional = [];
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) opts[args[i].slice(2)] = args[++i];
    else positional.push(args[i]);
  }
  const folder = positional[0];
  const vault = opts.vault || process.env.OBSIDIAN_VAULT;
  const name = opts.name;
  if (!folder || !vault || !name) {
    console.error('用法：bun run scripts/report-to-obsidian.js <folder> --vault <OBSIDIAN_VAULT> --name "<中文名>"');
    process.exit(2);
  }
  const { mkdir, writeFile, access } = await import("node:fs/promises");
  const { join } = await import("node:path");
  try {
    await access(vault); // 库根必须存在，否则停手（不猜落点、不写仓库）
  } catch {
    console.error(`✗ OBSIDIAN_VAULT 不存在：${vault}（停手，不猜测落点）`);
    process.exit(1);
  }
  const researchDir = join(vault, "Research");
  await mkdir(researchDir, { recursive: true });
  const content = await noteFromFolder(folder);
  const dest = join(researchDir, `${sanitizeFilename(name)}.md`);
  await writeFile(dest, content, "utf8");
  console.log(`✓ 写入 ${dest}`);
}
