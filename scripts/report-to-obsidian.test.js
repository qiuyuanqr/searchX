import { test, expect, describe } from "bun:test";
import {
  parseHtml,
  renderInline,
  renderBlocks,
  extractReport,
  buildObsidianNote,
  collectWikilinks,
  splitFrontmatter,
  sanitizeFilename,
  decodeEntities,
} from "./report-to-obsidian.js";

describe("parseHtml", () => {
  test("嵌套行内标签建成树，void 标签不入栈", () => {
    const nodes = parseHtml('<p>a<strong>b<a href="u">c</a></strong>d<br>e</p>');
    const p = nodes[0];
    expect(p.tag).toBe("p");
    const strong = p.children.find((n) => n.tag === "strong");
    expect(strong.children.find((n) => n.tag === "a").attrs.href).toBe("u");
    // br 是 void：其后的 e 是 p 的兄弟文本，不被 br 吞进去
    expect(p.children.some((n) => n.tag === "br")).toBe(true);
    expect(renderInline(p.children)).toBe("a**b[c](u)**d\ne");
  });

  test("错配的闭标签被宽松忽略，不崩", () => {
    expect(() => parseHtml("<p>hi</span></p>")).not.toThrow();
  });
});

describe("decodeEntities", () => {
  test("命名与数字实体", () => {
    expect(decodeEntities("A &amp; B &lt;x&gt; &#39;q&#39; &#x2F;")).toBe("A & B <x> 'q' /");
  });
});

describe("renderInline", () => {
  test("strong/em/code/a/链接文本回退到 href", () => {
    expect(renderInline(parseHtml("<strong>粗</strong>"))).toBe("**粗**");
    expect(renderInline(parseHtml("<em>斜</em>"))).toBe("*斜*");
    expect(renderInline(parseHtml("<code>x</code>"))).toBe("`x`");
    expect(renderInline(parseHtml('<a href="h">t</a>'))).toBe("[t](h)");
    expect(renderInline(parseHtml('<a href="h"></a>'))).toBe("[h](h)");
    // href 里的 &amp; 要解码成字面 & （否则链接指向错误目标）
    expect(renderInline(parseHtml('<a href="u?a=1&amp;b=2">t</a>'))).toBe("[t](u?a=1&b=2)");
  });

  test("small.src-note 拆包保留文字；span 拆包", () => {
    expect(renderInline(parseHtml('数<small class="src-note">（注）</small>'))).toBe("数（注）");
    expect(renderInline(parseHtml("<span>y</span>"))).toBe("y");
  });

  test("表格单元格内 <br> 保留为 <br>，正文内 <br> 变换行", () => {
    expect(renderInline(parseHtml("a<br>b"), { inCell: true })).toBe("a<br>b");
    expect(renderInline(parseHtml("a<br>b"))).toBe("a\nb");
  });
});

describe("renderBlocks", () => {
  test("标题/段落/有序无序列表", () => {
    const md = renderBlocks(parseHtml("<h2>标题</h2><p>段</p><ul><li>甲</li><li>乙</li></ul><ol><li>一</li><li>二</li></ol>"));
    expect(md).toContain("## 标题");
    expect(md).toContain("段");
    expect(md).toContain("- 甲\n- 乙");
    expect(md).toContain("1. 一\n2. 二");
  });

  test("表格：thead + tbody → GFM，单元格 br 保留、竖线转义", () => {
    const md = renderBlocks(
      parseHtml("<table><thead><tr><th>字段</th><th>值</th></tr></thead><tbody><tr><td>a<br>b</td><td>x|y</td></tr></tbody></table>")
    );
    expect(md).toContain("| 字段 | 值 |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| a<br>b | x\\|y |");
  });

  test("无 thead 的表格用首行当表头", () => {
    const md = renderBlocks(parseHtml("<table><tr><td>h1</td><td>h2</td></tr><tr><td>v1</td><td>v2</td></tr></table>"));
    expect(md).toContain("| h1 | h2 |");
    expect(md).toContain("| v1 | v2 |");
  });

  test("div.case/callout/limitation → Obsidian callout，内部块被引用前缀", () => {
    expect(renderBlocks(parseHtml('<div class="case"><p>案例正文</p></div>'))).toBe("> [!example] 案例\n> 案例正文");
    expect(renderBlocks(parseHtml('<div class="callout"><p>提示</p></div>'))).toBe("> [!note]\n> 提示");
    expect(renderBlocks(parseHtml('<div class="limitation">局限</div>'))).toBe("> [!warning] 数据局限\n> 局限");
  });
});

// —— 端到端：一个迷你 report.html + notes.md ——

const MINI_REPORT = `<!doctype html><html><head><style>a>b{}</style><title>x</title></head><body>
<div class="wrap">
  <header class="masthead"><div class="kicker"><span class="seal">研</span> 深度调研 · 概念</div>
    <h1>某对象（TEST）</h1><div class="meta"><span><b>生成</b> 2026-07-21</span></div></header>
  <div class="plain"><span class="lbl">先说人话</span>这是给外行的话。</div>
  <div class="tldr"><span class="lbl">核心结论</span>方向<strong>偏跌</strong>，置信度中。</div>
  <div class="findings"><h2>关键发现</h2><ul><li>发现甲</li><li>发现乙</li></ul></div>
  <main>
    <h2>机制</h2><p>正文里引用<a href="http://x">来源</a>。</p>
    <ul><li>要点一</li></ul>
    <div class="case"><p>某公司案例。</p><table><thead><tr><th>年</th><th>值</th></tr></thead><tbody><tr><td>2025</td><td>10</td></tr></tbody></table></div>
    <div class="callout">提示一句。</div>
    <div class="limitation">数据有缺口。</div>
  </main>
  <section class="risks"><h2>风险与争议</h2><ul><li>风险甲</li></ul></section>
  <section class="glossary"><h2>名词小抄</h2><dl><dt>CPU</dt><dd>大脑。</dd><dt>DCU</dt><dd>加速卡。</dd></dl></section>
  <section class="sources"><h2>来源清单</h2><ol>
    <li><span class="src-tag src-disc">披露</span> <a href="http://a">年报</a> <em>2026-04-08</em> — 摘要一。</li>
    <li><span class="src-tag src-research">研究</span> <a href="http://b">科普</a> <em>—</em> — 摘要二。</li>
  </ol></section>
</div></body></html>`;

const MINI_NOTES = `---
date: 2026-07-21
type: 概念
tags: [research, 测试]
related: ["[[算力]]"]
source_count: 1
archive: "2026-07-21_test"
---

# 某对象（TEST）

> 结论段。

正文里提到 [[某公司]] 与 [[算力]]。`;

describe("extractReport", () => {
  const r = extractReport(MINI_REPORT);
  test("标题/先说人话/结论/关键发现", () => {
    expect(r.title).toBe("某对象（TEST）");
    expect(r.plain).toBe("这是给外行的话。");
    expect(r.tldr).toBe("方向**偏跌**，置信度中。");
    expect(r.findings).toEqual(["发现甲", "发现乙"]);
  });
  test("正文含机制标题、链接、案例 callout、表格", () => {
    expect(r.bodyMd).toContain("## 机制");
    expect(r.bodyMd).toContain("[来源](http://x)");
    expect(r.bodyMd).toContain("> [!example] 案例");
    expect(r.bodyMd).toContain("| 年 | 值 |");
    expect(r.bodyMd).toContain("> [!warning] 数据局限");
  });
  test("名词小抄 / 风险 / 来源", () => {
    expect(r.glossary).toEqual([
      { term: "CPU", def: "大脑。" },
      { term: "DCU", def: "加速卡。" },
    ]);
    expect(r.risks).toEqual(["风险甲"]);
    expect(r.sources[0]).toEqual({ type: "披露", title: "年报", href: "http://a", date: "2026-04-08", summary: "摘要一。" });
  });
  test("<style> 里的 a>b 不被误当标签", () => {
    expect(r.bodyMd).not.toContain("a>b");
  });
});

describe("splitFrontmatter / collectWikilinks / sanitizeFilename", () => {
  test("拆 frontmatter", () => {
    const { frontmatter, body } = splitFrontmatter(MINI_NOTES);
    expect(frontmatter).toContain("type: 概念");
    expect(body.trimStart().startsWith("# 某对象")).toBe(true);
  });
  test("收集双链（去别名、去重）", () => {
    expect(collectWikilinks("见 [[算力|算力板块]] 和 [[算力]] 与 [[某公司]]")).toEqual(["算力", "某公司"]);
  });
  test("文件名消毒：斜杠/冒号换全角，非法字符去除", () => {
    expect(sanitizeFilename("CPO / 硅光")).toBe("CPO ／ 硅光");
    expect(sanitizeFilename("维谛技术 Vertiv (NYSE: VRT)")).toBe("维谛技术 Vertiv (NYSE： VRT)");
    expect(sanitizeFilename('a*?"<>|b')).toBe("ab");
    expect(sanitizeFilename("海光信息 688041.SH")).toBe("海光信息 688041.SH");
  });
});

describe("buildObsidianNote", () => {
  const note = buildObsidianNote(MINI_REPORT, MINI_NOTES);
  test("frontmatter 原样保留（related 双链在）", () => {
    expect(note.startsWith("---\ndate: 2026-07-21")).toBe(true);
    expect(note).toContain('related: ["[[算力]]"]');
  });
  test("全文各区块齐全", () => {
    for (const s of ["# 某对象（TEST）", "> **核心结论**", "## 先说人话", "## 关键发现", "## 机制", "## 名词小抄", "## 风险与争议", "## 来源清单"]) {
      expect(note).toContain(s);
    }
  });
  test("正文双链补进「关联笔记」，且不重复 frontmatter 里的算力", () => {
    expect(note).toContain("## 关联笔记");
    expect(note).toContain("[[某公司]]");
    // 关联笔记段里不应再挂已在 frontmatter 的 [[算力]]
    const tail = note.slice(note.indexOf("## 关联笔记"));
    expect(tail).not.toContain("[[算力]]");
  });
  test("不产生 3 连以上空行", () => {
    expect(note).not.toMatch(/\n{3,}/);
  });
  test("来源无日期时不渲染破折号占位（不出现 — — —）", () => {
    expect(note).toContain("[科普](http://b) — 摘要二。");
    expect(note).not.toContain("— — —");
  });
});
