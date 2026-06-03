import matter from "gray-matter";

export function parseNote(raw, dir) {
  const { data, content } = matter(raw);
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const tldrMatch = content.match(/^>\s?(.+(?:\n>.*)*)/m);

  const title = titleMatch ? titleMatch[1].trim() : dir.slice(11);
  const tldr = tldrMatch ? tldrMatch[1].replace(/\n>\s?/g, " ").trim() : "";
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
