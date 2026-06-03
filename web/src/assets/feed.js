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

bindTilt();
bindToTop();
bindChips();
