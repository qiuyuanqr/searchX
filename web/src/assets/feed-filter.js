// 首页信息流的可见性 + 计数纯函数。DOM 层（feed.js）只做映射与套用，逻辑全在此处便于单测。
// items：有序数组，元素 { kind:'card'|'sep', type? }。
// filters：{ type:'all'|<类型> }。
// 返回 { visible:boolean[], count:number }，visible 与 items 一一对应；count 为可见卡片数。
export function computeFeedView(items, { type = "all" } = {}) {
  const visible = new Array(items.length).fill(false);
  let count = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== "card") continue;
    visible[i] = type === "all" || it.type === type;
    if (visible[i]) count++;
  }

  // 月分隔：本段（到下一个 sep 之前）有任一可见卡片才显示。
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind !== "sep") continue;
    let any = false;
    for (let j = i + 1; j < items.length && items[j].kind !== "sep"; j++) {
      if (visible[j]) { any = true; break; }
    }
    visible[i] = any;
  }

  return { visible, count };
}

// ── 站内清单直配 ─────────────────────────────────────────────────────
// 为什么要有这一层：首页搜索本来只走 Pagefind，而 Pagefind 的中文分词会把查询切成词、
// 再按 AND 匹配。「江丰电子」被切成「江丰」+「电子」，而「江丰」并不是索引里的词——
// 整条查询直接落空。实测搜「江丰电子」「润泽科技」都返回 0 条，可站上明明有这两篇报告
// （搜「电子」或「300666」反而找得到）。股票名恰恰最容易踩这个坑，所以拿 reports.json
// 清单做一次确定性的子串匹配兜底：标题、标签（股票名与代码都在里面）、slug 全覆盖。

const normalize = (v) => String(v == null ? "" : v).trim().toLowerCase();

const HAS_WORD = /[\p{L}\p{N}]/u;      // 至少要有一个字母/数字/汉字，纯标点不查
const HAS_CJK = /[一-鿿]/;

// 子串匹配的准入门槛：slug 里到处是 'a'、'-'，标题里到处是 '.'（代码后缀 .SZ/.SH），
// 单个拉丁字符做子串匹配会命中一大片、把 Pagefind 的相关结果整个挤出前 20。
// 汉字不受此限——中文单字（「芯」「铜」）本身就是有意义的查询。
const allowsFuzzy = (q) => q.length >= 2 || HAS_CJK.test(q);

// 返回清单里匹配 query 的条目，按匹配强度降序（同强度按日期新→旧）。
export function matchReportsLocally(query, entries, limit = 20) {
  const q = normalize(query);
  if (!q || !Array.isArray(entries) || !HAS_WORD.test(q)) return [];
  const fuzzy = allowsFuzzy(q);

  const scored = [];
  for (const e of entries) {
    if (!e || !e.href) continue;                      // 脏条目直接跳过，别渲染出死链
    const title = normalize(e.title);
    const slug = normalize(e.slug);
    const tags = (Array.isArray(e.tags) ? e.tags : []).map(normalize);

    let score = 0;
    // 精确命中不受长度门槛限制
    if (title === q) score = 100;                     // 标题完全相同
    else if (tags.includes(q)) score = 90;            // 标签精确——股票名与 6 位代码都在标签里
    else if (!fuzzy) continue;                        // 以下都是子串匹配，短查询到此为止
    else if (title.startsWith(q)) score = 80;         // 「江丰电子」→「江丰电子（300666.SZ）」
    else if (title.includes(q)) score = 70;
    else if (tags.some((t) => t.includes(q))) score = 60;
    else if (slug.includes(q)) score = 50;            // 拼音 slug，如「hongjing」
    if (score) scored.push({ e, score });
  }

  scored.sort((a, b) => b.score - a.score || String(b.e.date || "").localeCompare(String(a.e.date || "")));
  return scored.slice(0, limit).map((s) => s.e);
}

// 清单条目 → Pagefind 同形状的结果项，好让渲染层一视同仁。
// 摘要用标签兜底：直配命中没有正文摘录，留空会渲染出一张空卡片。
function entryToItem(e) {
  const tags = (Array.isArray(e.tags) ? e.tags : [])
    .map((t) => String(t))
    .filter((t) => t && t !== "research");
  return { url: e.href, meta: { title: e.title || "" }, excerpt: tags.join(" · ") };
}

// 同一篇报告可能既被直配命中、又出现在 Pagefind 结果里，按归档目录去重。
// Pagefind 给的是绝对路径（/r/<folder>/），清单给的是相对路径（r/<folder>/）——只比目录名。
const folderOf = (url) => {
  const u = String(url || "").split(/[?#]/)[0].replace(/index\.html$/, "").replace(/\/+$/, "");
  return u.slice(u.lastIndexOf("/") + 1);
};

// 最终展示顺序：清单直配的排前面（用户搜的就是这个标的），其余 Pagefind 全文命中接在后面。
export function buildSearchItems(query, entries, pagefindItems, limit = 20) {
  const pf = Array.isArray(pagefindItems) ? pagefindItems : [];
  const local = matchReportsLocally(query, entries, limit);
  if (!local.length) return pf.slice(0, limit);

  const seen = new Set(local.map((e) => folderOf(e.href)));
  return [...local.map(entryToItem), ...pf.filter((it) => !seen.has(folderOf(it.url)))].slice(0, limit);
}
