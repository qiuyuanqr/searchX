import { createHash } from "node:crypto";

// 构建时给报告副本（web/dist/r/<dir>/index.html）注入站点导航与 2026-08-26 改版的排版换装：
// 「返回档案首页」+「回到顶部」浮动按钮、迷你横条目录（桌面鼠标鱼眼 / 手机手指滑选）、
// 阅读进度条、正文区块滚动淡入、A–M 节题拆出等宽字母编号、核心结论上移为居中导读。
// 注意：只注入到 dist 副本，原始 research/<dir>/report.html（归档/Obsidian 用）保持纯净。

// 导航交互脚本。单独抽出来：CSP 要按它的内容算 sha256 白名单，
// 只有这段脚本被放行，报告正文里任何其它内联脚本都会被浏览器挡下（见下方 buildCsp）。
const NAV_SCRIPT = `
(function(){
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var top = document.querySelector(".sx-top");
  var bar = document.querySelector(".sx-progress > i");

  // 外部来源链接一律新标签页打开：点来源不离开报告页（手机上尤其容易丢阅读位置）
  document.querySelectorAll('a[href^="http"]').forEach(function(a){ a.target = "_blank"; a.rel = "noopener"; });

  // ── 排版换装（2026-08-26 晚）：把存量报告的正文调整成简报式版面 ──
  // 核心结论上移到报头之下、作居中导读（新旧报告的 DOM 顺序都是 plain→tldr，统一搬）
  var tldrEl = document.querySelector(".tldr"), plainEl = document.querySelector(".plain");
  if (tldrEl && plainEl && plainEl.parentNode) plainEl.parentNode.insertBefore(tldrEl, plainEl);

  // 自动目录：固定区块 + 正文 h2，按（搬动后的）文档顺序
  var secs = [];
  function add(el, label){ if (!el) return; if (!el.id) el.id = "sx-sec-" + secs.length; secs.push({ id: el.id, label: label }); }
  add(tldrEl, "核心结论");
  add(plainEl, "先说人话");
  add(document.querySelector(".findings"), "关键发现");
  document.querySelectorAll("main h2").forEach(function(h){ add(h, h.textContent.trim()); });
  add(document.querySelector("section.risks"), "风险与争议");
  add(document.querySelector(".glossary"), "名词小抄");
  add(document.querySelector("section.sources"), "来源清单");

  function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

  // 「A. 一屏结论」式节题拆出等宽字母编号（目录 label 已在上面取好原文，这里改不影响）。
  // 只动纯文本的 h2——带行内标记的不碰，避免把正文结构改坏。
  document.querySelectorAll("main h2").forEach(function(h){
    if (h.childNodes.length === 1 && h.firstChild.nodeType === 3){
      var m = h.textContent.match(/^([A-Z])[.、．]\\s*(.+)$/);
      if (m){ h.innerHTML = '<span class="sx-sec-letter">' + m[1] + '</span>' + esc(m[2]); h.classList.add("sx-lettered"); }
    }
  });

  // 迷你横条目录（参照 Codex 的长内容导航）：每节一根等长小横条，标题存 data-label。
  function railHtml(){ return secs.map(function(s){ return '<a href="#" data-id="' + esc(s.id) + '" data-label="' + esc(s.label) + '"><i></i></a>'; }).join(""); }
  var aside = document.querySelector(".sx-toc");
  var deskNav = document.querySelector(".sx-toc nav");
  if (secs.length){
    deskNav.insertAdjacentHTML("beforeend", railHtml());
    bindRail();
  } else {
    aside.style.display = "none";   // 没有可索引区块：藏掉目录
  }

  // 鱼眼放大：常态每条等长；指点（鼠标移动或手指按住滑动）时离光标越近的条越长、
  // 线性衰减成阶梯；只有最近那条弹出标题气泡。手指松开跳到最近那节；键盘聚焦等效指着它。
  function bindRail(){
    var links = [].slice.call(deskNav.querySelectorAll("a"));
    if (!links.length) return;
    var tip = document.createElement("span");
    tip.className = "sx-rail-tip";
    aside.appendChild(tip);
    var BASE = 12, EXTRA = 22, RANGE = 90;   // 基础长 / 最大增量 / 影响半径(px)
    var best = null;
    function setW(a, w){ var i = a.querySelector("i"); if (i) i.style.width = w + "px"; }
    function onPoint(clientY){
      var bd = Infinity; best = null;
      links.forEach(function(a){
        var r = a.getBoundingClientRect(), c = r.top + r.height / 2;
        var d = Math.abs(clientY - c);
        setW(a, BASE + EXTRA * Math.max(0, 1 - d / RANGE));
        if (d < bd){ bd = d; best = a; }
      });
      links.forEach(function(a){ a.classList.toggle("near", a === best); });
      if (best){
        // aside 是 top:0 的 fixed 定位，视口 Y 即容器内 Y，气泡直接用 clientY 系坐标
        var r = best.getBoundingClientRect();
        tip.textContent = best.dataset.label || "";
        tip.style.top = (r.top + r.height / 2) + "px";
        tip.classList.add("show");
      }
    }
    function reset(){
      best = null;
      links.forEach(function(a){ setW(a, BASE); a.classList.remove("near"); });
      tip.classList.remove("show");
    }
    deskNav.addEventListener("mousemove", function(e){ onPoint(e.clientY); });
    deskNav.addEventListener("mouseleave", reset);
    // 触屏：按住滑动选段（CSS touch-action:none 挡掉页面跟滚），松手跳到最近那节
    deskNav.addEventListener("touchstart", function(e){ if (e.touches[0]) onPoint(e.touches[0].clientY); }, { passive:true });
    deskNav.addEventListener("touchmove", function(e){ if (e.touches[0]) onPoint(e.touches[0].clientY); }, { passive:true });
    deskNav.addEventListener("touchend", function(){ if (best) jump(best.dataset.id); reset(); });
    deskNav.addEventListener("touchcancel", reset);
    links.forEach(function(a){
      a.addEventListener("focus", function(){ var r = a.getBoundingClientRect(); onPoint(r.top + r.height / 2); });
      a.addEventListener("blur", reset);
      a.addEventListener("click", function(e){ e.preventDefault(); jump(a.dataset.id); });
    });
    reset();
  }
  function jump(id){ var t = document.getElementById(id); if (t) t.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }); }

  // 正文区块滚动淡入（与首页 bindReveal 同一套约束）：隐藏态只在 JS 启动后才加，
  // 脚本被挡 / 未加载时内容永远直接可见；「减少动态」用户不启用。
  if (!reduce && "IntersectionObserver" in window){
    var blocks = document.querySelectorAll(".tldr, .plain, .findings, main > *, section.risks, .glossary, section.sources");
    if (blocks.length){
      document.body.classList.add("sx-reveal");
      var io = new IntersectionObserver(function(es){ es.forEach(function(x){
        if (x.isIntersecting){ x.target.classList.add("in"); io.unobserve(x.target); }
      }); }, { rootMargin: "0px 0px -6% 0px", threshold: 0.02 });
      blocks.forEach(function(b){ b.classList.add("sx-rv"); io.observe(b); });
    }
  }

  function spy(){
    var y = window.scrollY + 120, cur = secs.length ? secs[0].id : null;
    for (var i = 0; i < secs.length; i++){
      var el = document.getElementById(secs[i].id);
      if (el && el.getBoundingClientRect().top + window.scrollY <= y) cur = secs[i].id;
    }
    document.querySelectorAll(".sx-toc a").forEach(function(a){ a.classList.toggle("on", a.dataset.id === cur); });
  }

  var lastY = window.scrollY, acc = 0;
  function onScroll(){
    var y = window.scrollY;
    (y > 420) ? top.classList.add("show") : top.classList.remove("show");
    if (bar){ var h = document.documentElement.scrollHeight - window.innerHeight; bar.style.width = (h > 0 ? (y / h) * 100 : 0) + "%"; }
    // 窄屏下浮动按钮会压住正文：下滚（阅读）时藏起，上滚/近顶再浮现（CSS 只在窄屏应用 sx-fab-hide）。
    // 位移按同方向累计、反向清零：慢速拖动（每帧 1–3px）也能过阈值，且不被 iOS 回弹抖动误触。
    var d = y - lastY; lastY = y;
    if (d) acc = (d > 0) === (acc > 0) ? acc + d : d;
    if (acc > 24 && y > 300) document.body.classList.add("sx-fab-hide");
    else if (acc < -24 || y <= 300) document.body.classList.remove("sx-fab-hide");
    spy();
  }
  window.addEventListener("scroll", onScroll, { passive:true });
  onScroll();
  top.addEventListener("click", function(){ window.scrollTo({ top:0, behavior: reduce ? "auto" : "smooth" }); });
})();
`;

// 严格 CSP（防存储型 XSS）：report.html 由全权限 headless Claude 生成、原样上线公开站主域。
//   default-src none：默认什么都不许加载；
//   script-src 只放行上面 NAV_SCRIPT 的 sha256（绝不含 unsafe-inline）——别的内联脚本一律被挡；
//   style-src unsafe-inline：报告全靠内联 <style>，必须放开；
//   img-src self data: https:、font-src self data:：放开图片 / 字体；
//   base-uri none、form-action none：禁改 <base>、禁表单提交外发。
//   外部 <a href> 是页面跳转、不受这些指令约束，正常工作。
function buildCsp() {
  const hash = createHash("sha256").update(NAV_SCRIPT).digest("base64");
  return [
    "default-src 'none'",
    `script-src 'sha256-${hash}'`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

export function injectReportNav(html, {
  homeHref = "../../index.html",
  faviconHref = "../../assets/favicon.png",
} = {}) {
  // 站点 favicon（报告在 /r/<dir>/ 下，故上两级到 /assets）。注入到 <head>，
  // 让单独打开/分享的报告页也带站点图标，而非浏览器默认首字母。
  const favicon = `<link rel="icon" type="image/png" href="${faviconHref}">`;
  // CSP meta：和导航脚本同处一地，按脚本内容算哈希，注入与放行一致不漂移。
  const csp = `<meta http-equiv="Content-Security-Policy" content="${buildCsp()}">`;
  const headInject = csp + "\n" + favicon;
  // 注入到 <head> 末尾（第一个 </head>，即真正的头部结束；正文里若出现字面 </head> 不受影响）。
  const headM = html.match(/<\/head>/i);
  if (headM) {
    html = html.replace(headM[0], headInject + "\n" + headM[0]);
  } else {
    // 没有 </head> 的报告（模板被改坏、AI 产出漏写）也必须带上 CSP：老实现这里直接跳过，
    // 那篇报告就以「无 CSP」的状态上线公开站主域，等于这道防线对最异常的产物恰好失效。
    // 退而求其次插在文档最前面——meta CSP 只要出现在任何脚本/资源之前就生效。
    const htmlTagM = html.match(/<html\b[^>]*>/i);
    html = htmlTagM
      ? html.replace(htmlTagM[0], htmlTagM[0] + "\n" + headInject)
      : headInject + "\n" + html;
  }

  // 表格不进全文索引（data-pagefind-ignore）：表格里的裸数字串会被 Pagefind 摘成
  // 「682 亿. 82.10. 15.15.」这类无意义摘录；关键事实正文都有，摘录落在正文段落上更可读。
  html = html.replace(/<table(?=[\s>])(?![^>]*data-pagefind-ignore)/gi, "<table data-pagefind-ignore");

  // 统一报告副本的 viewport（覆盖所有存量报告——其原始 report.html 可能仍是旧 viewport，
  // 无需逐个改归档文件）。不锁 maximum-scale/user-scalable：body 已有 touch-action:manipulation
  // 单独解决双击误放大，禁缩放对低视力用户是纯损失（WCAG 1.4.4 要求可缩放到 200%）且 iOS 本就
  // 忽略这两个参数，唯一"生效"的是 Android Chrome 遵守它、把低视力用户放大功能锁死。
  const lockedViewport = '<meta name="viewport" content="width=device-width, initial-scale=1">';
  const vpRe = /<meta\s+name=["']viewport["'][^>]*>/i;
  if (vpRe.test(html)) html = html.replace(vpRe, lockedViewport);
  else if (headM) html = html.replace(/<\/head>/i, lockedViewport + "\n</head>");
  else html = html.replace(headInject, headInject + "\n" + lockedViewport); // 无 </head> 时跟着 CSP 一起走

  const snippet = `
<!-- searchX 站点导航（构建时注入，不写入归档 report.html） -->
<style>
/* 移动端禁双击放大（存量报告 head CSS 未含此规则，构建时补上）；电脑端缩放不受影响。
   同时锁死横向滚动：手机访问报告页只能上下滚，不能左右拖动放大。 */
html,body{touch-action:manipulation; max-width:100%; overflow-x:hidden}
/* 宽内容不撑破视口：图片自适应；超宽表格 / 代码块改为各自内部横向滚动，而非整页可拖 */
img,video,iframe{max-width:100%; height:auto}
pre{display:block; max-width:100%; overflow-x:auto; -webkit-overflow-scrolling:touch}
/* 表格：手机上列不再被压成竖排逐字（给最小列宽）；超宽时整张表可左右拖动查看；
   首列冻结，横向拖动看后面列时行名/字段名始终可见；表头加底色、隔行浅纹，更易读。 */
table{display:block; max-width:100%; overflow-x:auto; -webkit-overflow-scrolling:touch;
  border-collapse:separate; border-spacing:0; margin:1.6rem 0; font-size:.9rem; line-height:1.5;
  border-top:1px solid var(--rule); border-left:1px solid var(--rule)}
table th,table td{border-right:1px solid var(--rule); border-bottom:1px solid var(--rule);
  padding:.5rem .7rem; vertical-align:top; text-align:left; min-width:5em; max-width:17em;
  overflow-wrap:break-word}
table thead th{background:var(--paper-2); color:var(--ink); font-weight:600; white-space:nowrap}
table tbody tr:nth-child(even) td{background:rgba(127,127,127,.05)}
/* 首列冻结：sticky 需要不透明底色盖住滚到下面的内容，右侧 1px 投影作分隔。 */
table th:first-child,table td:first-child{position:sticky; left:0; z-index:1;
  min-width:6.5em; background:var(--card); font-weight:600; box-shadow:1px 0 0 var(--rule)}
/* 隔行底色特异性比首列规则高，会令偶数行首列变半透明、滚动内容透出来——这条盖回不透明 */
table tbody tr:nth-child(even) td:first-child{background:var(--card)}
table thead th:first-child{z-index:2; background:var(--paper-2)}
/* 长链接 / 长串（如来源 URL）强制换行，避免撑出横向滚动条 */
.wrap a,.wrap p,.wrap li,.wrap dt,.wrap dd,.wrap h1,.wrap h2,.wrap h3{overflow-wrap:break-word; word-break:break-word}
.sx-nav-btn{position:fixed; right:max(20px, calc((100vw - var(--measure)) / 2 - 56px)); width:44px; height:44px; border-radius:50%;
  background:var(--card); border:1px solid var(--rule); color:var(--seal); font-size:1.15rem;
  display:flex; align-items:center; justify-content:center; cursor:pointer; z-index:50;
  text-decoration:none; box-shadow:0 4px 14px rgba(0,0,0,.1);
  transition:opacity .3s ease, transform .3s ease, box-shadow .2s ease, border-color .2s ease}
.sx-nav-btn:hover{transform:translateY(-3px); box-shadow:0 9px 22px rgba(0,0,0,.15); border-color:var(--seal-soft)}
.sx-nav-btn:active{transform:translateY(-1px) scale(.95)}
.sx-home{bottom:20px}
.sx-home svg{width:19px; height:19px}
.sx-top{bottom:74px; opacity:0; transform:translateY(10px); pointer-events:none}
.sx-top.show{opacity:1; transform:none; pointer-events:auto}
/* 窄屏下按钮压正文：下滚（阅读）时藏起，上滚/近顶再浮现（脚本切 body.sx-fab-hide） */
@media (max-width:900px){
  body.sx-fab-hide .sx-nav-btn{opacity:0; transform:translateY(14px); pointer-events:none}
}
/* 顶部阅读进度条 */
.sx-progress{position:fixed; top:0; left:0; right:0; height:3px; z-index:60; background:transparent}
.sx-progress>i{display:block; height:100%; width:0; background:var(--seal); transition:width .1s linear}
/* 迷你横条目录（参照 Codex 的长内容导航）：常态一列等长小横条；指点（鼠标/手指）时脚本做
   鱼眼放大，只有最近那条弹标题气泡；手指松开跳段。条长由脚本写行内样式，这里只给基础态。
   桌面在左缘；窄屏或纯触控设备移到右缘（避开 iOS 左缘返回手势），气泡换到条的左侧。 */
.sx-toc{position:fixed; top:0; bottom:0; display:flex; flex-direction:column; justify-content:center;
  left:14px; z-index:40; pointer-events:none}
.sx-toc nav{pointer-events:auto; max-height:78vh; overflow:hidden; padding:8px 14px 8px 2px}
.sx-toc .h{display:none}
.sx-toc a{display:block; padding:4px 8px 4px 0; text-decoration:none; cursor:pointer; -webkit-tap-highlight-color:transparent}
.sx-toc a i{display:block; width:12px; height:2px; border-radius:2px; background:var(--muted); opacity:.45; transition:width .15s ease, opacity .15s, background .15s}
.sx-toc a.near i{opacity:.95}
.sx-toc a.on i{background:var(--seal); opacity:1}
/* 最近那条的标题气泡（脚本定位到该条的纵向中点） */
.sx-rail-tip{position:absolute; left:54px; transform:translateY(-50%); background:var(--card);
  border:1px solid var(--rule); border-radius:8px; box-shadow:0 6px 20px rgba(0,0,0,.14);
  padding:.28rem .7rem; font-family:ui-sans-serif,-apple-system,"PingFang SC",sans-serif; font-size:.78rem;
  color:var(--ink); white-space:nowrap; max-width:16em; overflow:hidden; text-overflow:ellipsis;
  opacity:0; transition:opacity .12s ease, top .1s ease}
.sx-rail-tip.show{opacity:1}
@media (max-width:899px), (hover:none){
  .sx-toc{left:auto; right:6px}
  .sx-toc nav{padding:8px 2px 8px 14px; touch-action:none}
  .sx-toc a{display:flex; justify-content:flex-end; padding:3.5px 0 3.5px 8px}
  .sx-toc a i{width:10px}
  .sx-rail-tip{left:auto; right:46px}
}
@media (prefers-reduced-motion: reduce){ .sx-nav-btn{transition:none !important} .sx-progress>i{transition:none}
  .sx-toc a i, .sx-rail-tip{transition:none !important} }
/* ── 2026-08-26 站点改版统一：存量报告的调色板 / 版面覆盖到与首页与设计定稿一致 ──
   老报告的 <style> 里烧着旧纸感样式；这段排在其后、同特异性靠后者胜，把变量与版面整体盖掉。
   调色板值要与 .claude/skills/research/templates/report.html（新报告）和 web/src/assets/feed.css 同步。 */
:root{
  --paper:#fafafa; --paper-2:#f0efec; --ink:#2b2926; --ink-soft:#6e6a63;
  --muted:#7d786f; --rule:#e7e6e3; --seal:#b4543a; --seal-soft:#c97a62;
  --card:#ffffff; --accent-bg:#fbeae4;
  --measure:47rem;   /* 阅读列 42→47rem：改版后两侧留白收一档 */
}
@media (prefers-color-scheme: dark){
  :root{
    --paper:#1b1a18; --paper-2:#252320; --ink:#ece9e3; --ink-soft:#b9b4ab;
    --muted:#8f8a80; --rule:#35322c; --seal:#d97e5c; --seal-soft:#c97a62;
    --card:#242220; --accent-bg:#33261f;
  }
}
.wrap{max-width:var(--measure)}   /* 存量报告的 .wrap 写死了旧 measure 的场合也统一吃到新宽度 */
.seal{background:var(--accent-bg); border:0; border-radius:8px; width:1.7rem; height:1.7rem; font-size:.78rem}
/* 报头居中（设计定稿：等宽日期行感觉由 .meta 承担，大标题居中，其下是核心结论导读 + 短色条） */
header.masthead{text-align:center; border-bottom:0; padding-bottom:0; margin-bottom:.6rem}
header.masthead .kicker{justify-content:center}
header.masthead h1{font-size:2.2rem; line-height:1.35}
header.masthead .meta{justify-content:center}
/* 核心结论（脚本已搬到报头下）：居中灰色导读 + 主色短色条收尾 */
.tldr{background:transparent; border:0; border-radius:0; padding:0; margin:1.1rem auto 0;
  max-width:36em; text-align:center; font-size:.98rem; line-height:1.9; color:var(--ink-soft)}
.tldr .lbl{display:none}
.tldr::after{content:""; display:block; width:40px; height:2px; border-radius:2px; background:var(--seal); margin:1.9rem auto 0}
/* 先说人话：去卡片化，小标签 + 正文 */
.plain{background:transparent; border:0; border-radius:0; padding:0; margin:2.8rem 0 2.4rem; font-size:1.02rem}
.plain .lbl{color:var(--seal)}
/* 关键发现：去卡片化，条目改成淡色标签行（设计定稿的 key-tag 样式） */
.findings{background:transparent; border:0; box-shadow:none; border-radius:0; padding:0; margin-bottom:2.8rem}
.findings h2{font-family:ui-sans-serif,-apple-system,"PingFang SC",sans-serif; font-size:.72rem;
  letter-spacing:.18em; text-transform:uppercase; color:var(--seal-soft); font-weight:600; margin:0 0 .6rem}
.findings ul{list-style:none; padding:0; margin:0}
.findings li{background:rgba(180,84,58,.07); border-left:2px solid rgba(180,84,58,.28); border-radius:0 8px 8px 0;
  padding:.4rem .85rem; margin:.45rem 0; font-size:.9rem; line-height:1.65; color:var(--ink-soft)}
/* 正文节题：去顶部分隔线；「A. …」式节题由脚本拆出块级等宽字母编号 */
main h2{border-top:0; padding-top:0}
.sx-lettered{margin:3rem 0 .9rem; font-size:1.32rem}
.sx-sec-letter{display:block; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:1.55rem; font-weight:600; color:var(--seal-soft); line-height:1.25; margin-bottom:.1rem}
.case,.limitation,.correction{border-radius:12px}
/* 正文区块滚动淡入（脚本挂 body.sx-reveal + 块上 .sx-rv/.in；脚本不跑则全部直接可见） */
body.sx-reveal .sx-rv{opacity:0; transform:translateY(14px); transition:opacity .5s ease, transform .5s ease}
body.sx-reveal .sx-rv.in{opacity:1; transform:none}
</style>
<div class="sx-progress" aria-hidden="true"><i></i></div>
<aside class="sx-toc" aria-label="目录"><nav><div class="h">目录</div></nav></aside>
<a class="sx-nav-btn sx-home" href="${homeHref}" aria-label="返回调研档案首页" title="返回档案首页">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 9.8V19h13V9.8"/></svg>
</a>
<button type="button" class="sx-nav-btn sx-top" aria-label="回到顶部" title="回到顶部">↑</button>
<script>${NAV_SCRIPT}</script>`;

  // 注入到真正的文档末尾：用最后一个 </body>，而非第一个。报告正文（如代码块里）若出现字面
  // </body>，第一个匹配会落在正文中间、把导航插进代码块；取最后一个才稳。
  const lastBody = html.toLowerCase().lastIndexOf("</body>");
  if (lastBody !== -1) {
    return html.slice(0, lastBody) + snippet + "\n" + html.slice(lastBody);
  }
  return html + snippet;
}
