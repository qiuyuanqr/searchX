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

// 「## 一句话XXX」/「## TL;DR」类标题下的首个引用块或首段（列表不算首段）。
// 标题必须以"一句话"/"TL;DR"开头才算数——像"## 公司一句话定位"这种"一句话"
// 只是标题中部修饰词的，不是真正的 TL;DR 段落，不应误命中。
function quoteOrParaAfter(lines, startIdx) {
  let i = startIdx;
  while (i < lines.length && /^\s*$/.test(lines[i])) i++;
  if (i >= lines.length || /^#{1,6}\s/.test(lines[i])) return "";
  if (/^>\s?/.test(lines[i])) {
    const block = [];
    while (i < lines.length && /^>\s?/.test(lines[i])) {
      block.push(lines[i].replace(/^>\s?/, ""));
      i++;
    }
    return cleanInline(block.join(" "));
  }
  if (/^\s*([-*+]|\d+\.)\s/.test(lines[i])) return "";
  const para = [];
  for (; i < lines.length; i++) {
    if (/^\s*$/.test(lines[i])) break;
    if (/^#{1,6}\s/.test(lines[i])) break;
    if (/^\s*([-*+]|\d+\.)\s/.test(lines[i])) break;
    para.push(lines[i]);
  }
  return cleanInline(para.join(" "));
}

// 导语（卡片 lead）抽取，优先级：
// ① 「## 一句话XXX」/「## TL;DR」标题下的首个引用块或首段——报告作者已明确标注这是结论段落；
// ①' 「## 一屏结论」/「## 核心结论」/「## 结论先行」类标题下的首个引用块或首段——同为作者标注的
//    结论位置，但措辞更泛，只能排在①之后（同一篇笔记两类标题都有时，一句话结论更接近卡片导语的体裁）。
//    没有这一档时，用这些标题的 10 篇存量笔记全部跌落到②③，抓到的是「本笔记是精简版」「信息截止」
//    这类免责声明（2026-07-14 实测：套话 7 篇 + 空白 3 篇）。允许「A 核心结论」这种带节号前缀的写法。
// ② 第一个 `##` 标题之前出现的引用块（导语位置——H1 下紧跟的开场引用，多数报告的写法）；
// ③ 全文第一个引用块（向后兼容兜底，防止走到这里仍拿不到内容）。
// 优先级①在②之前，是因为①是作者显式标注的结论位置；把②放在①之前会让"标题下才是真结论、
// 标题前只是免责声明/基准数据"的笔记（如 TBEA）永远拿不到正确导语。
function extractTldr(content) {
  const lines = content.split("\n");
  const headingPasses = [
    /^#{1,6}\s+(?:一句话|TL;?DR)/i,
    /^#{1,6}\s+(?:[A-Za-z0-9]{1,3}[.、·\s]\s*)?(?:一屏结论|核心结论|结论先行)/,
  ];
  for (const pat of headingPasses) {
    for (let i = 0; i < lines.length; i++) {
      if (!pat.test(lines[i])) continue;
      const t = quoteOrParaAfter(lines, i + 1);
      if (t) return t;
    }
  }
  let firstHeadingIdx = lines.findIndex((l) => /^#{1,6}\s/.test(l));
  if (firstHeadingIdx === -1) firstHeadingIdx = lines.length;
  const lead = lines.slice(0, firstHeadingIdx).join("\n");
  const leadBq = lead.match(/^>\s?(.+(?:\n>.*)*)/m);
  if (leadBq) return cleanInline(leadBq[1].replace(/\n>\s?/g, " "));
  const bq = content.match(/^>\s?(.+(?:\n>.*)*)/m);
  if (bq) return cleanInline(bq[1].replace(/\n>\s?/g, " "));
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
    // 强转数字：frontmatter 写成字符串会原样直通到首页 HTML（渲染层虽也转义，这里是第一道闸），
    // 非数字一律归 0（渲染层对 0 不显示"来源"块）。
    sourceCount: Number(data.source_count) || 0,
    href: `r/${dir}/`,
  };
}
