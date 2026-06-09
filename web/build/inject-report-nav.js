// 构建时给报告副本（web/dist/r/<dir>/index.html）注入站点导航：
// 一个常驻的「返回档案首页」按钮 + 一个滚动后出现的「回到顶部」按钮，
// 圆形纸感样式复刻主页 .to-top，并复用报告自身的配色变量（自动适配深色模式）。
// 注意：只注入到 dist 副本，原始 research/<dir>/report.html（归档/Obsidian 用）保持纯净。
export function injectReportNav(html, {
  homeHref = "../../index.html",
  faviconHref = "../../assets/favicon.png",
} = {}) {
  // 站点 favicon（报告在 /r/<dir>/ 下，故上两级到 /assets）。注入到 <head>，
  // 让单独打开/分享的报告页也带站点图标，而非浏览器默认首字母。
  const favicon = `<link rel="icon" type="image/png" href="${faviconHref}">`;
  const headM = html.match(/<\/head>/i);
  if (headM) html = html.replace(headM[0], favicon + "\n" + headM[0]);

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
.sx-nav-btn{position:fixed; right:20px; width:44px; height:44px; border-radius:50%;
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
@media (prefers-reduced-motion: reduce){ .sx-nav-btn{transition:none !important} }
</style>
<a class="sx-nav-btn sx-home" href="${homeHref}" aria-label="返回调研档案首页" title="返回档案首页">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 9.8V19h13V9.8"/></svg>
</a>
<button type="button" class="sx-nav-btn sx-top" aria-label="回到顶部" title="回到顶部">↑</button>
<script>
(function(){
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var top = document.querySelector(".sx-top");
  function onScroll(){ (window.scrollY > 420) ? top.classList.add("show") : top.classList.remove("show"); }
  window.addEventListener("scroll", onScroll, { passive:true });
  onScroll();
  top.addEventListener("click", function(){ window.scrollTo({ top:0, behavior: reduce ? "auto" : "smooth" }); });
})();
</script>`;

  const m = html.match(/<\/body>/i);
  if (m) return html.replace(m[0], snippet + "\n" + m[0]);
  return html + snippet;
}
