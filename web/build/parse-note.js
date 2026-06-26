import matter from "gray-matter";

// 把一句话结论里的 markdown 噪声洗成纯文本（卡片是纸感展示层，不渲染 markdown）
export function cleanInline(s) {
  return String(s)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [文字](url) → 文字
    .replace(/\[\[([^\]]+)\]\]/g, "$1")       // [[双链]] → 双链
    .replace(/\*\*([^*]+)\*\*/g, "$1")        // **加粗** → 加粗
    .replace(/`([^`]+)`/g, "$1")              // `代码` → 代码
    .replace(/<[^>]+>/g, "")                  // 漏进的 HTML 标签（如 <strong>）→ 去掉，卡片是纯文本展示层
    .replace(/\s+/g, " ")
    .trim();
}

// 导语（卡片 lead）抽取：优先 markdown `>` 引用块；没有则回退到「## 一句话」/「## TL;DR」
// 标题下的首段（股票等报告用标题段落而非引用块写结论，否则卡片导语会空）。
function extractTldr(content) {
  const bq = content.match(/^>\s?(.+(?:\n>.*)*)/m);
  if (bq) return cleanInline(bq[1].replace(/\n>\s?/g, " "));
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^#{1,6}\s+.*(?:一句话|TL;?DR)/i.test(lines[i])) continue;
    const para = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*$/.test(lines[j])) { if (para.length) break; else continue; }
      if (/^#{1,6}\s/.test(lines[j])) break;   // 撞到下一个标题就停
      para.push(lines[j]);
    }
    if (para.length) return cleanInline(para.join(" "));
  }
  return "";
}

export function parseNote(raw, dir) {
  const { data, content } = matter(raw);
  const titleMatch = content.match(/^#\s+(.+)$/m);

  // 标题也走 cleanInline：H1 里若带 **加粗** / [[双链]] / `代码`，卡片是纯文本展示层，不该漏出字面记号。
  const title = titleMatch ? cleanInline(titleMatch[1]) : dir.slice(11);
  const tldr = extractTldr(content);
  // related / tags 都可能被人工写成 YAML 标量（如 `related: 算力`）而非数组——统一归一化成数组，
  // 否则 .map 抛 TypeError，一条格式写偏的 note 会击穿整站构建（而非只丢这一张卡片）。
  const toList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const boards = toList(data.related).map((s) => String(s).replace(/\[\[|\]\]/g, "").trim());

  return {
    dir,
    date: dir.slice(0, 10),
    created: data.created || "",   // 精确生成时间（ISO8601 北京时间），用于同日排序；缺则退化为 date
    slug: dir.slice(11),
    type: data.type || "",
    title,
    tldr,
    tags: toList(data.tags),
    boards,
    sourceCount: data.source_count || 0,
    href: `r/${dir}/`,
  };
}
