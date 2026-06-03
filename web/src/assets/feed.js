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

bindTilt();
bindToTop();
bindChips();
bindSearch();
