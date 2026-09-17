import { test, expect } from "bun:test";
import { renderMarkdown } from "./md.js";

test("标题渲染为 <h2>", () => {
  expect(renderMarkdown("## 真相直述")).toContain("<h2>真相直述</h2>");
});
test("加粗 **x** → <strong>", () => {
  expect(renderMarkdown("这是**重点**内容")).toContain("<strong>重点</strong>");
});
test("http 链接渲染为带 rel 的 <a>、新窗口打开", () => {
  const h = renderMarkdown("见 [新华社](https://x.com/a)");
  expect(h).toContain('<a href="https://x.com/a" target="_blank" rel="noopener noreferrer">新华社</a>');
});
test("非 http(s) 链接退化为纯文字（防 javascript: 注入）", () => {
  const h = renderMarkdown("[点我](javascript:alert(1))");
  expect(h).not.toContain("<a ");
  expect(h).toContain("点我");
});
test("Obsidian 双链 [[X]] 降级为纯文本", () => {
  const h = renderMarkdown("关联 [[算力]] 板块");
  expect(h).not.toContain("[[");
  expect(h).toContain("算力");
});
test("HTML 特殊字符被转义（防注入）", () => {
  const h = renderMarkdown("危险 <script>alert(1)</script>");
  expect(h).not.toContain("<script>");
  expect(h).toContain("&lt;script&gt;");
});
test("无序列表", () => {
  expect(renderMarkdown("- 一\n- 二")).toContain("<ul><li>一</li><li>二</li></ul>");
});
test("有序列表", () => {
  expect(renderMarkdown("1. 甲\n2. 乙")).toContain("<ol><li>甲</li><li>乙</li></ol>");
});
test("管道表格渲染为 <table> 含表头与单元格", () => {
  const md = "| # | 说法 | 裁定 |\n|---|---|---|\n| 1 | 天是蓝的 | ✅ 属实 |";
  const h = renderMarkdown(md);
  expect(h).toContain('<table data-cols="3">');
  expect(h).toContain("<th>#</th>");
  // td 带 data-label=表头文字（窄屏堆成卡片时当小标题）
  expect(h).toContain('<td data-label="说法">天是蓝的</td>');
  expect(h).toContain('<td data-label="裁定">✅ 属实</td>');
});
test("表格 data-label：表头里的加粗记号剥掉、HTML 转义；多出的单元格 label 为空", () => {
  const h = renderMarkdown('| **裁定** | a<b |\n|---|---|\n| x | y | z |');
  expect(h).toContain('<td data-label="裁定">x</td>');
  expect(h).toContain('<td data-label="a&lt;b">y</td>');
  expect(h).toContain('<td data-label="">z</td>');
});
test("段落合并连续文本行、空行分段", () => {
  const h = renderMarkdown("第一行\n第二行\n\n第三段");
  expect(h).toContain("<p>第一行 第二行</p>");
  expect(h).toContain("<p>第三段</p>");
});
test("表格单元格内的链接也被渲染", () => {
  const md = "| 来源 |\n|---|\n| [新华社](https://x.com/a) |";
  expect(renderMarkdown(md)).toContain('<a href="https://x.com/a"');
});
