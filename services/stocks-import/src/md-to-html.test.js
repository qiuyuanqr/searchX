import { test, expect } from "bun:test";
import { mdToHtml, inline, escapeHtml } from "./md-to-html.js";

test("行内：先转义再还原标签，正文里的尖括号变不成标签", () => {
  expect(inline("营收 <5 亿元、毛利率 >40%")).toBe("营收 &lt;5 亿元、毛利率 &gt;40%");
  expect(inline("<img src=x onerror=alert(1)>")).not.toContain("<img");
});

test("行内：加粗与链接", () => {
  expect(inline("**要点**见 [来源](https://a.example/x)"))
    .toBe('<strong>要点</strong>见 <a href="https://a.example/x" target="_blank" rel="noopener">来源</a>');
});

test("非 http(s) 链接降级成纯文本（javascript: 绝不能生成出来）", () => {
  expect(inline("[点这里](javascript:alert)")).toBe("点这里");
  expect(inline("[相对路径](/a/b)")).toBe("相对路径");
});

test("链接文字里的实体不会二次转义成坏地址", () => {
  const h = inline("[x](https://a.example/p?a=1&b=2)");
  expect(h).toContain('href="https://a.example/p?a=1&amp;b=2"');
});

test("标题：md 的 ## / ### 落成 h2 / h3；h1 提升为 h2（标题另在报头）", () => {
  expect(mdToHtml("## A. 一屏结论")).toBe("<h2>A. 一屏结论</h2>");
  expect(mdToHtml("### C2. 补充")).toBe("<h3>C2. 补充</h3>");
  expect(mdToHtml("# 标题")).toBe("<h2>标题</h2>");
});

test("无序 / 有序列表与嵌套", () => {
  const html = mdToHtml("- 一\n- 二\n  - 二之一\n\n1. 甲\n2. 乙");
  expect(html).toContain("<ul>");
  expect(html).toContain("<li>二\n<ul>\n<li>二之一</li>\n</ul></li>");
  expect(html).toContain("<ol>");
});

test("列表项的缩进续行并进同一个 li，不另起段落", () => {
  const html = mdToHtml("- 第一行\n  续行内容");
  expect(html).toBe("<ul>\n<li>第一行 续行内容</li>\n</ul>");
});

test("引用块渲染成模板里的 callout（模板没给 blockquote 样式）", () => {
  expect(mdToHtml("> 提示一句")).toBe('<div class="callout">提示一句</div>');
});

test("围栏代码块进 pre 并整体转义，缩进原样保留", () => {
  const html = mdToHtml("```\n上游\n    ↓  <b>不该成标签</b>\n```");
  expect(html).toContain("<pre>");
  expect(html).toContain("    ↓");
  expect(html).toContain("&lt;b&gt;");
});

test("分隔线不画线（模板的 h2 自带上边框）", () => {
  expect(mdToHtml("段落一\n\n---\n\n段落二")).toBe("<p>段落一</p>\n<p>段落二</p>");
});

test("空行分段；连续行并成一段", () => {
  expect(mdToHtml("甲\n乙\n\n丙")).toBe("<p>甲 乙</p>\n<p>丙</p>");
});

test("escapeHtml 覆盖 & < > \" 四个字符", () => {
  expect(escapeHtml('&<>"')).toBe("&amp;&lt;&gt;&quot;");
});
