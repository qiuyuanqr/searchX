import { buildPayload, tokenFromQuery, describeVerify, describeResult, renderSearchResultsHTML, describeExistingReport } from "./submit.js";
import { findFreshReport } from "./dedup.js";
import { computeFeedView } from "./feed-filter.js";

// 专属链接里的 token（?k=…）：提交的唯一凭证。空 = 未授权，不能提交。
const TOKEN = tokenFromQuery(location.search);
// 读到 token 后立即从地址栏 / 历史里抹掉 ?k=：避免 token 残留在浏览器历史、或随后续 referer 泄露。
if (TOKEN && window.history && history.replaceState) {
  try { history.replaceState(null, "", location.pathname + location.hash); } catch {}
}

const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// 提交即查重：与 runner 同一时效窗口（天）。已有同标的且窗口内报告 → 提示已有、拦下提交。
const DEDUP_WINDOW_DAYS = 30;
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

// 回到顶部
function bindToTop(){
  const toTop = document.querySelector(".to-top");
  const firstCard = document.querySelector(".article-card");
  function onScroll(){
    const t = firstCard ? (firstCard.offsetTop + firstCard.offsetHeight / 3) : 140;
    (window.scrollY > t) ? toTop.classList.add("show") : toTop.classList.remove("show");
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" }));
}

// 吸顶筛选区：滚动后加底边分隔
function bindStuck(){
  const bar = document.querySelector(".filterbar");
  if (!bar) return;
  const onScroll = () => bar.classList.toggle("stuck", window.scrollY > 4);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

// 两组独立筛选（类型 / 板块），AND 组合；联动月分隔可见性与计数。
function bindChips(){
  const typeChips = document.getElementById("chips-type");
  const boardChips = document.getElementById("chips-board");
  const feed = document.getElementById("feed");
  const empty = document.getElementById("empty");
  const countEl = document.getElementById("count");
  const nodes = [...feed.children]; // li.article-card / li.month-sep（有序）
  const items = nodes.map((n) =>
    n.classList.contains("month-sep")
      ? { kind: "sep" }
      : { kind: "card", type: n.dataset.type || "", boards: (n.dataset.boards || "").split(",").filter(Boolean) }
  );
  let activeType = "all";
  let activeBoard = null;

  function apply(){
    const { visible, count } = computeFeedView(items, { type: activeType, board: activeBoard });
    nodes.forEach((n, i) => n.classList.toggle("hide", !visible[i]));
    if (countEl) countEl.textContent = `共 ${count} 篇`;
    empty.hidden = count > 0;
  }

  typeChips.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip"); if (!chip) return;
    typeChips.querySelectorAll(".chip").forEach((c) => c.classList.remove("on"));
    chip.classList.add("on");
    const f = chip.dataset.filter;
    activeType = f === "all" ? "all" : f.slice(5); // type:概念 → 概念
    apply();
  });

  boardChips.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip"); if (!chip) return;
    const name = chip.dataset.filter.slice(6); // board:算力 → 算力
    if (activeBoard === name) { activeBoard = null; chip.classList.remove("on"); } // 再点取消
    else {
      boardChips.querySelectorAll(".chip").forEach((c) => c.classList.remove("on"));
      chip.classList.add("on"); activeBoard = name;
    }
    apply();
  });

  apply(); // 初始计数
}

// Pagefind 全文检索：输入即查，清空回到信息流
function debounce(fn, ms){ let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function bindSearch(){
  const input = document.getElementById("q");
  const feed = document.getElementById("feed");
  const results = document.getElementById("results");
  const typeChips = document.getElementById("chips-type");
  const boardChips = document.getElementById("chips-board");
  const countEl = document.getElementById("count");
  const empty = document.getElementById("empty");
  let pf;
  const setChrome = (show) => [typeChips, boardChips, countEl].forEach((el) => { if (el) el.hidden = !show; });

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
  function showFeed(){ results.hidden = true; results.innerHTML = ""; feed.hidden = false; setChrome(true); }
  function showResults(){ feed.hidden = true; setChrome(false); results.hidden = false; }

  const run = debounce(async (q) => {
    if (!q) { showFeed(); empty.hidden = true; return; }
    const engine = await ensure();
    const search = await engine.search(q);
    const items = await Promise.all(search.results.slice(0, 20).map((r) => r.data()));
    if (!items.length) { showResults(); results.innerHTML = ""; empty.hidden = false; return; }
    empty.hidden = true;
    results.innerHTML = renderSearchResultsHTML(items); // title/url 在此函数内已转义，防 DOM-XSS
    showResults();
  }, 180);

  input.addEventListener("input", (e) => run(e.target.value.trim()));
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

  const setStatus = (text, kind) => { statusEl.textContent = text; statusEl.dataset.kind = kind; statusEl.hidden = false; };
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
      const r = await fetch(form.dataset.verify + "?k=" + encodeURIComponent(TOKEN));
      const data = await r.json().catch(() => ({ ok: false }));
      verified = true;                          // 拿到服务端确定答复才缓存
      applyAuth(describeVerify(data));
    } catch {
      // 瞬时网络故障：不缓存（verified 保持 false），关闭再打开弹窗可重试
      applyAuth(describeVerify({ ok: false }));
    }
  }

  // ── 提交即查重 ──
  // 清除提示并解除"重复"造成的禁用（注意：只解除查重禁用，不动"请求在途"那次禁用）。
  function clearDup(){
    if (dupNotice){ dupNotice.hidden = true; dupNotice.innerHTML = ""; }
    if (submitBtn && submitBtn.dataset.dupBlocked){ delete submitBtn.dataset.dupBlocked; submitBtn.disabled = false; }
  }
  async function runDupCheck(){
    if (!titleInput || !dupNotice) return;
    const t = titleInput.value.trim();
    if (!t) { clearDup(); return; }
    const match = findFreshReport({
      topic: t, entries: await loadReports(), today: todayBeijing(), windowDays: DEDUP_WINDOW_DAYS,
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
    if (btn && btn.disabled) return;          // 防连点 + 未授权（noauth）/查重禁用时不提交
    if (!authorized) { setStatus(describeVerify({ ok: false }).text, "error"); return; } // 双保险
    if (btn) btn.disabled = true;             // 请求在途时禁用，防连点
    const fd = new FormData(form);
    const payload = buildPayload(
      { title: fd.get("title"), focus: fd.get("focus"), message: fd.get("message") },
      TOKEN
    );
    setStatus("提交中…", "pending");
    try {
      const r = await fetch(form.dataset.worker, {
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
      if (btn) btn.disabled = false;          // 无论成败都恢复，允许失败后重试
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
