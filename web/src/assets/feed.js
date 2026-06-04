import { buildPayload, describeResult } from "./submit.js";

const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// 卡片 3D 倾斜
function bindTilt(){
  if (reduce) return;
  const MAX = 4;
  document.querySelectorAll(".card-link").forEach((card) => {
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      card.style.setProperty("--ry", ((px - 0.5) * 2 * MAX).toFixed(2) + "deg");
      card.style.setProperty("--rx", (-(py - 0.5) * 2 * MAX).toFixed(2) + "deg");
    });
    card.addEventListener("pointerleave", () => {
      card.style.setProperty("--rx", "0deg");
      card.style.setProperty("--ry", "0deg");
    });
  });
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

// 标签筛选（type: / board:）
function bindChips(){
  const chips = document.getElementById("chips");
  const cards = [...document.querySelectorAll("#feed .article-card")];
  const empty = document.getElementById("empty");
  chips.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    chips.querySelectorAll(".chip").forEach((c) => c.classList.remove("on"));
    chip.classList.add("on");
    const f = chip.dataset.filter;
    let shown = 0;
    cards.forEach((card) => {
      let ok = f === "all";
      if (f.startsWith("type:")) ok = card.dataset.type === f.slice(5);
      if (f.startsWith("board:")) ok = (card.dataset.boards || "").split(",").includes(f.slice(6));
      card.classList.toggle("hide", !ok);
      if (ok) shown++;
    });
    empty.hidden = shown > 0;
  });
}

// Pagefind 全文检索：输入即查，清空回到信息流
function debounce(fn, ms){ let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function bindSearch(){
  const input = document.getElementById("q");
  const feed = document.getElementById("feed");
  const results = document.getElementById("results");
  const chips = document.getElementById("chips");
  const empty = document.getElementById("empty");
  let pf;

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
  function showFeed(){ results.hidden = true; results.innerHTML = ""; feed.hidden = false; chips.hidden = false; }
  function showResults(){ feed.hidden = true; chips.hidden = true; results.hidden = false; }

  const run = debounce(async (q) => {
    if (!q) { showFeed(); empty.hidden = true; return; }
    const engine = await ensure();
    const search = await engine.search(q);
    const items = await Promise.all(search.results.slice(0, 20).map((r) => r.data()));
    if (!items.length) { showResults(); results.innerHTML = ""; empty.hidden = false; return; }
    empty.hidden = true;
    results.innerHTML = items.map((d) =>
      `<div class="result"><a href="${d.url}"><h3>${d.meta.title || "(无标题)"}</h3><p class="ex">${d.excerpt}</p></a></div>`
    ).join("");
    showResults();
  }, 180);

  input.addEventListener("input", (e) => run(e.target.value.trim()));
}

// ── 提交弹窗（入口在首页内，不再跳独立网址）────────────────
// Turnstile 显式渲染：弹窗默认 hidden(display:none)，在隐藏容器里 auto-render 会得到 0 尺寸，
// 故只在弹窗可见时 render（API 就绪 / 打开弹窗 二者后到的那个触发）。
let tsId = null;
function renderTurnstile(){
  if (tsId !== null) return;                              // 已渲染
  const modal = document.getElementById("submit-modal");
  if (!modal || modal.hidden) return;                     // 只在弹窗可见时渲染
  const el = document.getElementById("ts-widget");
  if (!el || !window.turnstile || !window.turnstile.render) return; // API 未就绪
  tsId = window.turnstile.render(el, { sitekey: el.dataset.sitekey });
}
window.__renderTurnstile = renderTurnstile; // <head> 的 onTurnstileReady 就绪后会回调它

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
  let lastFocus = null;

  const setStatus = (text, kind) => { statusEl.textContent = text; statusEl.dataset.kind = kind; statusEl.hidden = false; };
  const showForm = () => { form.hidden = false; done.hidden = true; statusEl.hidden = true; };

  function open(){
    lastFocus = document.activeElement;
    showForm();
    modal.hidden = false;
    document.body.classList.add("modal-lock");
    openBtn.setAttribute("aria-expanded", "true");
    renderTurnstile();                       // 弹窗已可见，可安全渲染（API 未就绪则等回调）
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
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); }); // 点遮罩关闭
  document.addEventListener("keydown", (e) => {
    if (modal.hidden) return;
    if (e.key === "Escape") { close(); return; }
    if (e.key === "Tab") trapFocus(e);
  });

  again.addEventListener("click", () => {
    form.reset();
    if (tsId !== null && window.turnstile) window.turnstile.reset(tsId);
    showForm();
    const f = firstField(); if (f) f.focus();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const token = (window.turnstile && tsId !== null ? window.turnstile.getResponse(tsId) : "")
      || (fd.get("cf-turnstile-response") || "").toString();
    const payload = buildPayload(
      { title: fd.get("title"), focus: fd.get("focus"), email: fd.get("email"), message: fd.get("message") },
      token
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
        if (tsId !== null && window.turnstile) window.turnstile.reset(tsId); // 失败后刷新验证
      }
    } catch {
      setStatus(describeResult({ ok: false }).text, "error");
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

bindTilt();
bindToTop();
bindChips();
bindSearch();
bindSubmitModal();
bindRefresh();
