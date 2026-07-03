import { createHash } from "node:crypto";

// 构建时给报告副本（web/dist/r/<dir>/index.html）注入站点导航：
// 一个常驻的「返回档案首页」按钮 + 一个滚动后出现的「回到顶部」按钮，
// 圆形纸感样式复刻主页 .to-top，并复用报告自身的配色变量（自动适配深色模式）。
// 注意：只注入到 dist 副本，原始 research/<dir>/report.html（归档/Obsidian 用）保持纯净。

// 导航交互脚本（进度条 / 目录 / 回到顶部）。单独抽出来：CSP 要按它的内容算 sha256 白名单，
// 只有这段脚本被放行，报告正文里任何其它内联脚本都会被浏览器挡下（见下方 buildCsp）。
const NAV_SCRIPT = `
(function(){
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var top = document.querySelector(".sx-top");
  var bar = document.querySelector(".sx-progress > i");

  // 外部来源链接一律新标签页打开：点来源不离开报告页（手机上尤其容易丢阅读位置）
  document.querySelectorAll('a[href^="http"]').forEach(function(a){ a.target = "_blank"; a.rel = "noopener"; });

  // 自动目录：固定区块 + 正文 h2，按文档顺序
  var secs = [];
  function add(el, label){ if (!el) return; if (!el.id) el.id = "sx-sec-" + secs.length; secs.push({ id: el.id, label: label }); }
  add(document.querySelector(".plain"), "先说人话");
  add(document.querySelector(".tldr"), "核心结论");
  add(document.querySelector(".findings"), "关键发现");
  document.querySelectorAll("main h2").forEach(function(h){ add(h, h.textContent.trim()); });
  add(document.querySelector("section.risks"), "风险与争议");
  add(document.querySelector(".glossary"), "名词小抄");
  add(document.querySelector("section.sources"), "来源清单");

  function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function linksHtml(){ return secs.map(function(s){ return '<a href="#" data-id="' + esc(s.id) + '">' + esc(s.label) + '</a>'; }).join(""); }
  var aside = document.querySelector(".sx-toc");
  var deskNav = document.querySelector(".sx-toc nav");
  var sheet = document.querySelector(".sx-toc-sheet");
  var sheetPanel = sheet.querySelector(".panel");
  var tocBtn = document.querySelector(".sx-toc-btn");
  if (secs.length){
    deskNav.insertAdjacentHTML("beforeend", linksHtml());
    sheetPanel.insertAdjacentHTML("beforeend", linksHtml());
  } else {
    aside.style.display = "none";   // 没有可索引区块：藏掉目录入口
    tocBtn.style.display = "none";
  }
  function jump(id){ var t = document.getElementById(id); if (t) t.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }); }
  // 打开/关闭目录浮层时一并锁/解锁整页滚动，防止滑动穿透到下面的报告页。
  function lock(on){ document.documentElement.classList.toggle("sx-toc-open", on); document.body.classList.toggle("sx-toc-open", on); }
  function openSheet(){
    sheet.classList.add("open"); lock(true);
    // 长目录（面板只显示得下一半）：打开时把当前章节滚到面板中部，读到后半篇也一眼见高亮
    var on = sheetPanel.querySelector("a.on");
    if (on) sheetPanel.scrollTop = Math.max(0, on.offsetTop - sheetPanel.clientHeight / 2);
  }
  function closeSheet(){ sheet.classList.remove("open"); lock(false); }
  document.querySelectorAll(".sx-toc a, .sx-toc-sheet a").forEach(function(a){
    // 先关浮层（解除整页滚动锁）再跳转：锁着滚动时发起平滑滚动在部分浏览器会被吞掉
    a.addEventListener("click", function(e){ e.preventDefault(); closeSheet(); jump(a.dataset.id); });
  });
  tocBtn.addEventListener("click", openSheet);
  sheet.addEventListener("click", function(e){ if (e.target === sheet) closeSheet(); });
  document.addEventListener("keydown", function(e){ if (e.key === "Escape") closeSheet(); });

  function spy(){
    var y = window.scrollY + 120, cur = secs.length ? secs[0].id : null;
    for (var i = 0; i < secs.length; i++){
      var el = document.getElementById(secs[i].id);
      if (el && el.getBoundingClientRect().top + window.scrollY <= y) cur = secs[i].id;
    }
    document.querySelectorAll(".sx-toc a, .sx-toc-sheet a").forEach(function(a){ a.classList.toggle("on", a.dataset.id === cur); });
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
  if (headM) html = html.replace(headM[0], headInject + "\n" + headM[0]);

  // 表格不进全文索引（data-pagefind-ignore）：表格里的裸数字串会被 Pagefind 摘成
  // 「682 亿. 82.10. 15.15.」这类无意义摘录；关键事实正文都有，摘录落在正文段落上更可读。
  html = html.replace(/<table(?=[\s>])(?![^>]*data-pagefind-ignore)/gi, "<table data-pagefind-ignore");

  // 移动端防误放大：把报告副本的 viewport 锁成「禁触摸缩放」。覆盖所有存量报告
  // （其原始 report.html 可能仍是旧 viewport），无需逐个改归档文件。
  // 仅约束移动端触摸缩放；电脑浏览器的 Cmd/Ctrl +/- 缩放不受 viewport 影响，照常可用。
  const lockedViewport =
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">';
  const vpRe = /<meta\s+name=["']viewport["'][^>]*>/i;
  if (vpRe.test(html)) html = html.replace(vpRe, lockedViewport);
  else if (headM) html = html.replace(/<\/head>/i, lockedViewport + "\n</head>");

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
table thead th{background:var(--accent-bg); color:var(--ink); font-weight:600; white-space:nowrap}
table tbody tr:nth-child(even) td{background:rgba(127,127,127,.05)}
/* 首列冻结：sticky 需要不透明底色盖住滚到下面的内容，右侧 1px 投影作分隔。 */
table th:first-child,table td:first-child{position:sticky; left:0; z-index:1;
  min-width:6.5em; background:var(--card); font-weight:600; box-shadow:1px 0 0 var(--rule)}
/* 隔行底色特异性比首列规则高，会令偶数行首列变半透明、滚动内容透出来——这条盖回不透明 */
table tbody tr:nth-child(even) td:first-child{background:var(--card)}
table thead th:first-child{z-index:2; background:var(--accent-bg)}
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
/* 自动目录：电脑端正文左侧吸顶侧栏（窄屏隐藏，退回浮层） */
.sx-toc{position:fixed; top:0; bottom:0; display:none; flex-direction:column; justify-content:center;
  width:170px; left:max(20px, calc((100vw - var(--measure)) / 2 - 190px)); z-index:40; pointer-events:none}
.sx-toc nav{pointer-events:auto; max-height:74vh; overflow-y:auto; overscroll-behavior:contain}
.sx-toc .h{font-family:ui-sans-serif,-apple-system,"PingFang SC",sans-serif; font-size:.66rem; letter-spacing:.16em;
  text-transform:uppercase; color:var(--muted); margin-bottom:.6rem}
.sx-toc a{display:block; font-family:ui-sans-serif,-apple-system,"PingFang SC",sans-serif; font-size:.8rem;
  line-height:1.35; color:var(--ink-soft); padding:.32rem 0 .32rem .6rem; border-left:2px solid transparent;
  text-decoration:none; cursor:pointer; transition:color .15s, border-color .15s}
.sx-toc a:hover{color:var(--seal)}
.sx-toc a.on{color:var(--seal); border-left-color:var(--seal); font-weight:600}
/* 手机端目录浮层 */
/* 整张浮层吞掉触摸手势（touch-action:none）：在半透明遮罩上拖动只会被拦下，不会带着下面的报告页一起滚——
   修复「滑目录时报告页跟着动」。点击遮罩关闭仍正常（tap/click 不受 touch-action 影响）。 */
.sx-toc-sheet{position:fixed; inset:0; z-index:70; display:none; background:rgba(20,16,10,.42);
  touch-action:none; overscroll-behavior:contain}
.sx-toc-sheet.open{display:block}
/* 面板内部可上下滚（touch-action:pan-y）；overscroll-behavior:contain 让滚到顶/底时不把滚动「漏」给下面的报告页。 */
.sx-toc-sheet .panel{position:absolute; left:0; right:0; bottom:0; max-height:70vh; overflow-y:auto;
  overscroll-behavior:contain; -webkit-overflow-scrolling:touch; touch-action:pan-y;
  background:var(--paper); border-top:1px solid var(--rule); border-radius:16px 16px 0 0; padding:1rem 1.2rem 1.4rem}
/* 浮层打开时锁住整页滚动（与首页提交弹窗的 modal-lock 同一招），双保险防穿透。
   标准模式下视口滚动根是 <html>，故 html/body 一起锁，wheel/触控都不漏。 */
html.sx-toc-open,body.sx-toc-open{overflow:hidden}
.sx-toc-sheet .grip{width:34px; height:4px; border-radius:2px; background:var(--rule); margin:0 auto .8rem}
.sx-toc-sheet a{display:block; font-family:ui-sans-serif,-apple-system,"PingFang SC",sans-serif; font-size:.95rem;
  color:var(--ink-soft); padding:.6rem 0; border-bottom:1px solid var(--rule); text-decoration:none}
.sx-toc-sheet a.on{color:var(--seal); font-weight:600}
.sx-toc-btn{bottom:128px; font-size:1.3rem}
@media (min-width:1100px){ .sx-toc{display:flex} .sx-toc-btn{display:none} }
@media (prefers-reduced-motion: reduce){ .sx-nav-btn{transition:none !important} .sx-progress>i{transition:none} .sx-toc a{transition:none} }
</style>
<div class="sx-progress" aria-hidden="true"><i></i></div>
<aside class="sx-toc" aria-label="目录"><nav><div class="h">目录</div></nav></aside>
<button type="button" class="sx-nav-btn sx-toc-btn" aria-label="目录" title="目录">≡</button>
<div class="sx-toc-sheet"><div class="panel"><div class="grip"></div></div></div>
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
