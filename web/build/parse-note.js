import matter from "gray-matter";

// 把一句话结论里的 markdown 噪声洗成纯文本（卡片是纸感展示层，不渲染 markdown）
export function cleanInline(s) {
  return String(s)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [文字](url) → 文字
    .replace(/\[\[([^\]]+)\]\]/g, "$1")       // [[双链]] → 双链
    .replace(/\*\*([^*]+)\*\*/g, "$1")        // **加粗** → 加粗
    .replace(/`([^`]+)`/g, "$1")              // `代码` → 代码
    .replace(/\s+/g, " ")
    .trim();
}

export function parseNote(raw, dir) {
  const { data, content } = matter(raw);
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const tldrMatch = content.match(/^>\s?(.+(?:\n>.*)*)/m);

  const title = titleMatch ? titleMatch[1].trim() : dir.slice(11);
  const tldr = tldrMatch ? cleanInline(tldrMatch[1].replace(/\n>\s?/g, " ")) : "";
  const boards = (data.related || []).map(
    (s) => String(s).replace(/\[\[|\]\]/g, "").trim()
  );

  return {
    dir,
    date: dir.slice(0, 10),
    slug: dir.slice(11),
    type: data.type || "",
    title,
    tldr,
    tags: data.tags || [],
    boards,
    sourceCount: data.source_count || 0,
    href: `r/${dir}/`,
  };
}
