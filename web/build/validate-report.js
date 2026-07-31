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

  // 2) 非法的来源标签配色类（写成 src-disclosure / src-typo 会渲染成无样式标签）。
  //    引号不限双/单：class='src-tag src-typo' 这种单引号写法也要认，否则悄悄漏检。
  for (const m of s.match(/class=["']src-tag src-([a-z]+)["']/g) || []) {
    const cls = m.match(/src-tag src-([a-z]+)/)[1];
    if (!SRC_TAG_CLASSES.has(cls)) {
      defects.push(`未知来源标签配色类 src-${cls}（合法：reg/disc/media/research/comm）`);
    }
  }

  // 3) 脚本类内容（防存储型 XSS）。report.html 由全权限 headless Claude 生成、原样上线
  //    公开站主域，模板和真实报告都只有内联 <style> + 外部 <a>，绝不该出现脚本。命中任一即拦下，
  //    配合 inject-report-nav 注入的 CSP（只放行注入脚本的哈希）形成双重防护。
  if (/<script\b/i.test(s)) {
    defects.push("出现 <script>（报告不应含脚本，疑似注入）");
  }
  // 内联事件处理器：限定在开标签内、且 on<词> 前有空白（属性分隔），避免误伤正文里的
  // content= 等以 on 结尾的属性名 / 文字。
  // 先剥掉引号内的内容（保留引号本身）：否则 <img alt="a>b" onerror=alert(1)> 这类值里带 >
  // 的属性，会让 [^>]* 在真正标签结束前就被这个内部 > 截断，onerror= 落在检测范围外、零缺陷。
  const noQuotedContent = s.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
  // on<词> 前允许的属性分隔符不止空白：`<svg/onload=1>` 用 / 分隔、`<img alt="x"onerror=1>`
  // 剥掉引号内容后留下的 `""` 残壳同样是合法边界。只认 \s 的话这两种写法都能绕过检测。
  const onM = noQuotedContent.match(/<[^>]*[\s/"']on([a-z]+)\s*=/i);
  if (onM) {
    defects.push(`出现内联事件处理器 on${onM[1]}=（报告不应含事件处理器，疑似注入）`);
  }
  // 只在属性位置（href/src/action…）算缺陷。正文里出现「javascript:」这个词是完全正常的
  // ——报告聊前端、聊 XSS 时就会写到它，而老实现的裸 /javascript:/i 会让整次站点构建抛错、
  // 全站停止发布。真正危险的是它出现在链接/资源地址里。
  // 注意用原文 s 而不是 noQuotedContent：属性值已被后者清空，得在原文里看。
  if (/\b(?:href|src|action|formaction|xlink:href)\s*=\s*["']?\s*javascript:/i.test(s)) {
    defects.push("出现 javascript: 协议链接（报告不应含脚本式链接，疑似注入）");
  }
  // meta refresh 整页跳转：CSP 没有对应指令能挡（frame-src/script-src 都管不到它），
  // 报告被单独打开/分享时会把读者直接送到外站，是这道校验独有的价值所在。
  if (/<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(s)) {
    defects.push("出现 <meta http-equiv=refresh>（报告不应整页跳转，疑似注入）");
  }
  const frameM = s.match(/<(iframe|object|embed)\b/i);
  if (frameM) {
    defects.push(`出现 <${frameM[1].toLowerCase()}>（报告不应嵌入外部内容，疑似注入）`);
  }

  return defects;
}
