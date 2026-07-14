import { buildPayload, tokenFromQuery, resolveToken, clearStoredToken, describeVerify, describeResult, renderSearchResultsHTML, describeExistingReport, fetchAny } from "./submit.js";
import { findFreshReport, DEFAULT_DEDUP_WINDOW_DAYS } from "./dedup.js";
import { computeFeedView } from "./feed-filter.js";

// 取 localStorage，沙箱/隐私模式下属性访问本身可能抛错 → 兜成 null（resolveToken 再静默降级）。
function safeStorage(){ try { return window.localStorage; } catch { return null; } }

// 专属链接里的 token（?k=…）：提交的唯一凭证。空 = 未授权，不能提交。
// 优先取地址栏 ?k=，没有则回退本机存储——这样点开报告再返回首页、刷新、从手机主屏图标冷启动重开，都还在授权态。
const TOKEN = resolveToken(location.search, safeStorage());
// 地址栏若带了 ?k=，读完（已落盘）立即从地址栏 / 历史里抹掉：避免 token 残留浏览器历史、或随后续 referer 泄露。
if (tokenFromQuery(location.search) && window.history && history.replaceState) {
  try { history.replaceState(null, "", location.pathname + location.hash); } catch {}
}

const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let reportsCache = null;
async function loadReports(){
  if (reportsCache) return reportsCache;
  try {
    const url = new URL("reports.json", document.baseURI).href; // 站点根的报告清单（构建产出）
    const r = await fetch(url);
    reportsCache = r.ok ? await r.json() : [];
  } catch { reportsCache = []; } // 取不到就当无可比对：不拦提交，runner 仍会兜底查重
  return reportsCache;
}
function todayBeijing(){
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

// 回到顶部 + 窄屏浮动按钮避让：下滚（阅读）时藏起按钮，上滚/近顶再浮现（CSS 只在窄屏应用 fab-hide）
function bindToTop(){
  const toTop = document.querySelector(".to-top");
  const firstCard = document.querySelector(".article-card");
  let lastY = window.scrollY, acc = 0;
  function onScroll(){
    const y = window.scrollY;
    const t = firstCard ? (firstCard.offsetTop + firstCard.offsetHeight / 3) : 140;
    toTop.classList.toggle("show", y > t);
    // 位移按同方向累计、反向清零：慢速拖动（每帧 1–3px）也能过阈值，且不被 iOS 回弹抖动误触
    const d = y - lastY; lastY = y;
    if (d) acc = (d > 0) === (acc > 0) ? acc + d : d;
    if (acc > 24 && y > 300) document.body.classList.add("fab-hide");
    else if (acc < -24 || y <= 300) document.body.classList.remove("fab-hide");
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" }));
}

// 吸顶筛选区：真正吸住（贴到视口顶）才亮底边分隔
function bindStuck(){
  const bar = document.querySelector(".filterbar");
  if (!bar) return;
  const onScroll = () => bar.classList.toggle("stuck", bar.getBoundingClientRect().top <= 0.5);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

// 类型筛选；联动月分隔可见性与计数。
function bindChips(){
  const typeChips = document.getElementById("chips-type");
  const feed = document.getElementById("feed");
  const empty = document.getElementById("empty");
  const countEl = document.getElementById("count");
  const nodes = [...feed.children]; // li.article-card / li.month-sep（有序）
  const items = nodes.map((n) =>
    n.classList.contains("month-sep")
      ? { kind: "sep" }
      : { kind: "card", type: n.dataset.type || "" }
  );
  let activeType = "all";

  function apply(){
    const { visible, count } = computeFeedView(items, { type: activeType });
    nodes.forEach((n, i) => n.classList.toggle("hide", !visible[i]));
    // feedText 存起来：搜索态会把计数改成「找到 N 条」，清空搜索时由 bindSearch 用它还原
    if (countEl) { countEl.dataset.feedText = `共 ${count} 篇`; countEl.textContent = countEl.dataset.feedText; }
    empty.hidden = count > 0;
  }

  const setPressed = (group, activeChip) =>
    group.querySelectorAll(".chip").forEach((c) => {
      c.classList.toggle("on", c === activeChip);
      c.setAttribute("aria-pressed", c === activeChip ? "true" : "false");
    });

  function activateType(chip){
    setPressed(typeChips, chip);
    const f = chip.dataset.filter;
    activeType = f === "all" ? "all" : f.slice(5); // type:概念 → 概念
    apply();
  }

  // 点击与键盘（Enter / 空格）同一入口：chips 是 span[role=button]，键盘可达
  const bindChipGroup = (group, fn) => {
    group.addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (c) fn(c); });
    group.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const c = e.target.closest(".chip"); if (!c) return;
      e.preventDefault(); fn(c);
    });
  };
  bindChipGroup(typeChips, activateType);

  apply(); // 初始计数
}

// Pagefind 全文检索：输入即查，清空回到信息流
function debounce(fn, ms){ let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function bindSearch(){
  const input = document.getElementById("q");
  const clearBtn = document.getElementById("q-clear");
  const feed = document.getElementById("feed");
  const results = document.getElementById("results");
  const typeChips = document.getElementById("chips-type");
  const countEl = document.getElementById("count");
  const empty = document.getElementById("empty");
  let pf;
  // 搜索态只藏筛选 chips；计数保留、改显示「找到 N 条」
  const setChrome = (show) => { if (typeChips) typeChips.hidden = !show; };

  async function ensure(){
    // 相对“页面”而非“本模块”解析：feed.js 在 /assets/ 下，须按 document.baseURI 定位站点根的 pagefind。
    // 站点在根（/）或在 /searchX/ 子路径下都正确；Pagefind 再据此自动推断结果 URL 的 base。
    if (!pf) {
      const url = new URL("pagefind/pagefind.js", document.baseURI).href;
      pf = await import(url);
      await pf.init();
    }
    return pf;
  }
  function showFeed(){
    results.hidden = true; results.innerHTML = ""; feed.hidden = false; setChrome(true);
    if (countEl) countEl.textContent = countEl.dataset.feedText || ""; // 还原信息流计数
  }
  function showResults(n){
    feed.hidden = true; setChrome(false); results.hidden = false;
    if (countEl) countEl.textContent = `找到 ${n} 条`;
  }

  // 查询序号：debounce 只防抖入口、不取消在途查询。清空或快速改词后，先前慢的旧查询
  // resolve 回来会覆盖当前状态（空输入框却显示旧结果）——写 DOM 前校验仍是最新一次才生效。
  let searchSeq = 0;
  const run = debounce(async (q) => {
    const seq = ++searchSeq;
    if (!q) { showFeed(); empty.hidden = true; return; }
    const engine = await ensure();
    const search = await engine.search(q);
    const items = await Promise.all(search.results.slice(0, 20).map((r) => r.data()));
    if (seq !== searchSeq) return; // 期间有更新的输入/清空动作 → 旧结果直接丢弃
    if (!items.length) { showResults(0); results.innerHTML = ""; empty.hidden = false; return; }
    empty.hidden = true;
    // 传 reports.json 清单：结果卡带上日期/类型元信息（取不到清单则退化为纯标题+摘录）
    results.innerHTML = renderSearchResultsHTML(items, await loadReports()); // title/url 在此函数内已转义，防 DOM-XSS
    showResults(items.length);
  }, 180);

  input.addEventListener("input", (e) => {
    const q = e.target.value.trim();
    if (clearBtn) clearBtn.hidden = !q;
    run(q);
  });
  if (clearBtn) clearBtn.addEventListener("click", () => {
    input.value = ""; clearBtn.hidden = true; input.focus(); run("");
  });
}

// ── 提交弹窗（入口在首页内，仅持专属链接 ?k= 的人可提交）────────────────
function bindSubmitModal(){
  const openBtn = document.getElementById("open-submit");
  const modal = document.getElementById("submit-modal");
  if (!openBtn || !modal) return;
  const card = modal.querySelector(".modal-card");
  const closeBtn = document.getElementById("close-submit");
  const form = document.getElementById("submit-form");
  const statusEl = document.getElementById("form-status");
  const done = document.getElementById("submit-done");
  const again = document.getElementById("submit-again");
  const firstField = () => form.querySelector('input[name="title"]');
  const titleInput = form.querySelector('input[name="title"]');
  const dupNotice = document.getElementById("dup-notice");
  const submitBtn = form.querySelector(".submit-btn");
  const authState = document.getElementById("auth-state");
  let lastFocus = null;
  let authorized = false;   // /verify 通过后才 true
  let verified = false;     // 已验过一次（避免重复请求）

  const setStatus = (text, kind) => {
    statusEl.textContent = text; statusEl.dataset.kind = kind; statusEl.hidden = false;
    // 把提示滚到可视区——避免在长表单/手机上「点了提交却看不到任何反应」
    try { statusEl.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" }); } catch {}
  };
  const showForm = () => { form.hidden = false; done.hidden = true; statusEl.hidden = true; };

  // 授权态：用 ?k= 调 /verify 确认 token 有效。未授权 → 回显提示 + 禁用提交。
  function applyAuth(view){
    authorized = view.authorized;
    if (authState){ authState.textContent = view.text; authState.dataset.kind = view.authorized ? "ok" : "error"; authState.hidden = false; }
    if (submitBtn){
      if (view.authorized){ if (submitBtn.dataset.noauth){ delete submitBtn.dataset.noauth; submitBtn.disabled = false; } }
      else { submitBtn.dataset.noauth = "1"; submitBtn.disabled = true; }
    }
  }
  async function verifyToken(){
    if (verified) return;                       // 已拿到确定结果就不重复验
    if (!TOKEN){ verified = true; applyAuth(describeVerify({ ok: false })); return; }
    try {
      // 主备端点各带超时（fetchAny）：任一端口被网络黑洞时不至于永远「验证中」
      const fb = form.dataset.workerFallback;
      const r = await fetchAny(
        [form.dataset.verify, fb && fb + "/verify"].map((u) => u && u + "?k=" + encodeURIComponent(TOKEN))
      );
      // 只有 2xx + 合法 JSON 才算服务端确定答复（/verify 对无效 token 也回 200 {ok:false}）。
      // 5xx / 网关 HTML 错误页绝不能当「token 无效」：那会误清本机有效 token（?k= 已从
      // 地址栏抹掉，一清用户就只能重新找作者要链接），并把未授权缓存到整个会话。
      if (!r.ok) throw new Error("verify http " + r.status);
      const data = await r.json();
      verified = true;                          // 拿到服务端确定答复才缓存
      if (!data || !data.ok) clearStoredToken(safeStorage()); // 服务端判定无效/已撤销 → 清掉本机失效 token，下次不再误判已授权
      applyAuth(describeVerify(data));
    } catch {
      // 瞬时网络/服务故障：不缓存（verified 保持 false）、不清 token，关闭再打开弹窗可重试
      applyAuth(describeVerify({ ok: false }));
    }
  }

  // ── 提交即查重 ──
  // 清除提示并解除"重复"造成的禁用。只解除查重这一种禁用：未授权（noauth）的禁用必须保留，
  // 否则「未授权 → 输入已有题目 → 清空」会把按钮误恢复成可点（提交时虽有双保险拦截，但按钮态骗人）。
  function clearDup(){
    if (dupNotice){ dupNotice.hidden = true; dupNotice.innerHTML = ""; }
    if (submitBtn && submitBtn.dataset.dupBlocked){
      delete submitBtn.dataset.dupBlocked;
      if (!submitBtn.dataset.noauth) submitBtn.disabled = false;
    }
  }
  async function runDupCheck(){
    if (!titleInput || !dupNotice) return;
    const t = titleInput.value.trim();
    if (!t) { clearDup(); return; }
    const match = findFreshReport({
      topic: t, entries: await loadReports(), today: todayBeijing(), windowDays: DEFAULT_DEDUP_WINDOW_DAYS,
    });
    if (!match) { clearDup(); return; }
    dupNotice.innerHTML = describeExistingReport(match); // 内部已转义，防 DOM-XSS
    dupNotice.hidden = false;
    if (submitBtn){ submitBtn.dataset.dupBlocked = "1"; submitBtn.disabled = true; } // 拦下：honest 重复不进待审队列
  }
  const checkDup = debounce(runDupCheck, 200);

  function open(){
    lastFocus = document.activeElement;
    showForm();
    modal.hidden = false;
    document.body.classList.add("modal-lock");
    openBtn.setAttribute("aria-expanded", "true");
    verifyToken();                           // 用 ?k= 确认授权，未授权则禁用提交
    loadReports();                           // 预取报告清单，让首次输入即时可比对
    runDupCheck();                           // 题目若已有内容（如再次打开）立即查一次
    const f = firstField(); if (f) f.focus();
  }
  function close(){
    modal.hidden = true;
    document.body.classList.remove("modal-lock");
    openBtn.setAttribute("aria-expanded", "false");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  // 极简焦点陷阱：Tab 不跑出弹窗
  function trapFocus(e){
    const all = card.querySelectorAll('button, [href], input, textarea, [tabindex]:not([tabindex="-1"])');
    const items = [...all].filter((el) => !el.hidden && el.offsetParent !== null && !el.disabled);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  openBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  if (titleInput) titleInput.addEventListener("input", checkDup); // 输入题目即查重
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); }); // 点遮罩关闭
  document.addEventListener("keydown", (e) => {
    if (modal.hidden) return;
    if (e.key === "Escape") { close(); return; }
    if (e.key === "Tab") trapFocus(e);
  });

  again.addEventListener("click", () => {
    form.reset();
    clearDup();                              // 题目已清空，撤掉查重提示与禁用
    showForm();
    const f = firstField(); if (f) f.focus();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector(".submit-btn");
    if (btn && btn.disabled) {                 // 防连点 + 未授权（noauth）/查重禁用时不提交
      // 回车提交到禁用按钮时，别让用户「点了没反应」——把禁用原因显式说出来
      if (btn.dataset.noauth) setStatus(describeVerify({ ok: false }).text, "error");
      return;
    }
    if (!authorized) { setStatus(describeVerify({ ok: false }).text, "error"); return; } // 双保险
    const origLabel = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "提交中…"; } // 请求在途：禁用 + 文案，防连点且给出明确反馈
    const fd = new FormData(form);
    const payload = buildPayload(
      { title: fd.get("title"), focus: fd.get("focus"), message: fd.get("message") },
      TOKEN
    );
    setStatus("提交中…", "pending");
    try {
      // 主备端点各带超时（fetchAny）：黑洞网络下 10 秒即报错可重试，不再无限「提交中…」
      const r = await fetchAny([form.dataset.worker, form.dataset.workerFallback], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({ ok: false }));
      const out = describeResult(data);
      if (out.kind === "success") {
        form.hidden = true; done.hidden = false;
        if (card) card.scrollTop = 0;
      } else {
        setStatus(out.text, out.kind);
      }
    } catch {
      setStatus(describeResult({ ok: false }).text, "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = origLabel; } // 无论成败都恢复，允许失败后重试
    }
  });

  // 旧网址 submit.html 跳来时带 #submit → 自动打开弹窗
  if (location.hash === "#submit") open();
}

// 刷新按钮（右下角常驻）
function bindRefresh(){
  const btn = document.querySelector(".to-refresh");
  if (!btn) return;
  btn.addEventListener("click", () => location.reload());
}

bindToTop();
bindStuck();
bindChips();
bindSearch();
bindSubmitModal();
bindRefresh();
