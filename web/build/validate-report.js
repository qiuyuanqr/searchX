// web/build/validate-report.js
// 构建期校验：report.html 是 research/stock skill 的「提示词程序」产物，没有任何环节保证它被正确
// 填充。这里在发布前扫一遍，拦住两类会流向公开站的明显缺陷，让构建直接失败（而非静默上线）。

// 报告模板里来源标签的 5 个合法配色类（见 templates/report.html 的 CSS）。
const SRC_TAG_CLASSES = new Set(["reg", "disc", "media", "research", "comm"]);

// 返回缺陷清单（中文）；为空即通过。
export function findReportDefects(html) {
  const s = String(html);
  const defects = [];

  // 1) 残留未替换的模板占位符 {{TOKEN}}（如 {{TITLE}}/{{SOURCES}}/{{GLOSSARY}} 漏填）
  for (const t of [...new Set(s.match(/\{\{[A-Z_]+\}\}/g) || [])]) {
    defects.push(`残留未替换的模板占位符 ${t}`);
  }

  // 2) 非法的来源标签配色类（写成 src-disclosure / src-typo 会渲染成无样式标签）
  for (const m of s.match(/class="src-tag src-([a-z]+)"/g) || []) {
    const cls = m.match(/src-tag src-([a-z]+)/)[1];
    if (!SRC_TAG_CLASSES.has(cls)) {
      defects.push(`未知来源标签配色类 src-${cls}（合法：reg/disc/media/research/comm）`);
    }
  }

  return defects;
}
