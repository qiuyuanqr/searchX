// web/src/assets/check-page.js — 事实核查页的 DOM 引导（外置脚本，配合严格 CSP `script-src 'self'`）。
// 纯逻辑（载荷构造 / 密钥读写 / 状态文案 / 结论解析）在 check.js；本文件只做事件绑定与 fetch。
// 2026-09-17 方向 A 改版：单一输入箱（文字 / 链接 / 粘贴截图）、列表按裁定着色、三段状态、
// 一键重试、补证据重查、裁定头卡结果页、设置面板（Obsidian 库名 / 退出）。
import {
  readKey, saveKey, clearKey, keyFromHash, describeCheckResult, describeSubmitError, describeRecentError,
  submitTimeoutMs, fitDimensions, validateCheckSubmission,
  describeTask, formatTaskTime, formatClockTime, shouldKeepPolling,
  parseFrontmatter, resultHero, describeResultError, taskTitle,
  extractLink, isWeixinLink, obsidianUri, readVault, saveVault,
} from "./check.js";
import { renderMarkdown } from "./md.js";

const WORKER = document.body.dataset.worker || "";   // {{WORKER_URL}} 注入在 body data-worker
const $ = (id) => document.getElementById(id);

// 所有到 Worker 的 fetch 一律带超时：workers.dev 在部分网络（如大陆手机网）会被黑洞，
// 连接挂起既不成功也不报错，没超时就永远"提交中"。AbortSignal.timeout 不存在时手动兜底。
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

const PROBE_TIMEOUT_MS = 10000;   // 密钥探测：失败本就放行，超时只为别让密钥闸卡住
const RECENT_TIMEOUT_MS = 15000;  // 最近核查列表
const RESULT_TIMEOUT_MS = 15000;  // 完整结果懒加载
const ACTION_TIMEOUT_MS = 15000;  // 重试 / 重查这类小请求

const MAX_IMAGES = 9;
const MAX_EDGE = 2000;     // 长边超此值才缩（保字迹优先）
const JPEG_QUALITY = 0.9;

// 已选图片：每项 { blob, url }。blob 是重编码后的 JPEG（归一化 HEIC、按需缩小）；url 是预览 object URL。
let selected = [];
// 补证据重查目标：{ id, title } 或 null；非空时提交走 /check/<id>/recheck
let recheckParent = null;
// 当前打开的结果（供「补充证据 · 重查」用）
let openTask = null;

// 在 canvas 上把任意可解码图片重编码为 JPEG：归一化格式（含 iOS HEIC）、长边超限才等比缩。
// 解码失败（如不支持的格式）抛错，调用方据此跳过该张。
async function processImage(file) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = fitDimensions(bitmap.width, bitmap.height, MAX_EDGE);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  if (bitmap.close) bitmap.close();
  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", JPEG_QUALITY));
  if (!blob) throw new Error("encode failed");
  return blob;
}

// 输入箱下方的附件区：链接卡片（从文字里识别）+ 图片缩略图
function renderAttach() {
  const box = $("attach");
  box.textContent = "";
  const { link } = extractLink($("check-text").value);
  if (link) {
    const chip = document.createElement("div");
    chip.className = "linkchip";
    let host = "", path = link;
    try { const u = new URL(link); host = u.hostname; path = u.pathname + u.search; } catch {}
    const h = document.createElement("span"); h.className = "host"; h.textContent = host || "链接";
    const p = document.createElement("span"); p.className = "path"; p.textContent = path;
    chip.append("🔗", h, p);
    if (isWeixinLink(link)) {
      const n = document.createElement("span"); n.className = "note"; n.textContent = "公众号：会先直抓，抓不到再补截图";
      chip.append(n);
    }
    box.append(chip);
  }
  for (let i = 0; i < selected.length; i++) {
    const item = selected[i];
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const img = document.createElement("img");
    img.src = item.url;
    img.alt = `图片 ${i + 1}`;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "×";
    del.setAttribute("aria-label", `移除图片 ${i + 1}`);
    del.addEventListener("click", () => removeImage(i));
    thumb.append(img, del);
    box.append(thumb);
  }
}

function removeImage(i) {
  const [gone] = selected.splice(i, 1);
  if (gone) URL.revokeObjectURL(gone.url);
  renderAttach();
}

function clearImages() {
  for (const it of selected) URL.revokeObjectURL(it.url);
  selected = [];
  renderAttach();
}

// 逐张重编码为 JPEG → 加入 selected → 渲染。超 9 张拒收并提示。
async function addImages(files) {
  const list = [...(files || [])].filter((f) => f && /^image\//.test(f.type || ""));
  if (!list.length) return;
  for (const f of list) {
    if (selected.length >= MAX_IMAGES) {
      setStatus(`最多 ${MAX_IMAGES} 张图片，多余的已忽略。`, "error");
      break;
    }
    try {
      const blob = await processImage(f);
      selected.push({ blob, url: URL.createObjectURL(blob) });
    } catch {
      setStatus("有一张图片无法读取，已跳过。", "error");
    }
  }
  renderAttach();
}

// 密钥存 localStorage：输一次后此设备持久免登，关标签 / 重开浏览器都不丢。
// 取舍：明文密钥长期留在本机浏览器。此页为私人提交页 + 严格 CSP（script-src 'self'），
// XSS 面极窄，密钥泄露最坏后果仅是他人能投递核查任务、读不到任何数据，权衡下可接受。
// 沙箱/隐私模式下访问 localStorage 属性本身就可能抛 SecurityError，必须 try/catch——
// 否则整个模块加载失败，「进入」按钮等所有交互整页失效且无任何提示。
function safeStorage(){ try { return window.localStorage; } catch { return null; } }
const store = safeStorage();
let key = readKey(store);

function showGate() {
  $("gate").hidden = false;
  $("form-area").hidden = true;
  $("gate-msg").hidden = true;
  $("settings-open").hidden = true;
}

function showForm() {
  $("gate").hidden = true;
  $("form-area").hidden = false;
  $("settings-open").hidden = false;
  showList();
  loadRecent();
}

function keyExpired() {
  clearKey(store); key = ""; showList(); showGate();
  $("gate-msg").textContent = "密钥已失效，请重新输入。"; $("gate-msg").hidden = false;
}

// ── 最近核查列表：拉 /check/recent 渲染；有排队中任务时每 50 秒自动刷新，全终态即停 ──
const POLL_MS = 50000;
let pollTimer = null;

function renderRecent(tasks) {
  const box = $("recent-list");
  box.textContent = "";
  if (!tasks.length) {
    const p = document.createElement("p");
    p.className = "ck-empty";
    p.textContent = "最近 7 天没有核查任务。";
    box.append(p);
    return;
  }
  const now = Date.now();
  for (const t of tasks) {
    const d = describeTask(t, now);
    const item = document.createElement("div");
    item.className = "task";
    item.dataset.tone = d.tone;
    const head = document.createElement("div");
    head.className = "task-head";
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.dataset.tone = d.tone;
    badge.textContent = d.label;
    const time = document.createElement("span");
    time.className = "task-time";
    time.textContent = formatTaskTime(t.createdAt);
    head.append(badge, time);
    const title = document.createElement("div");
    title.className = "task-title";
    title.textContent = (t.parentId ? "↻ " : "") + taskTitle(t);   // 重查任务前加记号
    item.append(head, title);
    if (d.text) {
      const sum = document.createElement("p");
      sum.className = "task-sum";
      sum.textContent = d.text;
      item.append(sum);
    }
    if (d.tone === "running") {
      const bar = document.createElement("div");
      bar.className = "task-progress";
      bar.append(document.createElement("i"));
      item.append(bar);
    }
    // done 的条目可点开看完整结果（懒加载）
    if (t.status === "done") {
      item.classList.add("clickable");
      item.setAttribute("role", "button");
      item.tabIndex = 0;
      item.addEventListener("click", () => openResult(t));
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openResult(t); }
      });
    }
    // 操作行：失败 → 再试一次；无法证实 → 补截图重查
    const acts = [];
    if (t.status === "failed") acts.push(actionButton("再试一次", (btn) => retryTask(t, btn)));
    if (t.status === "done" && d.tone === "unknown") acts.push(actionButton("补截图重查", () => startRecheck(t)));
    if (acts.length) {
      const row = document.createElement("div");
      row.className = "task-acts";
      row.append(...acts);
      item.append(row);
    }
    box.append(item);
  }
}

function actionButton(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ghost-btn";
  b.textContent = label;
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(b); });
  return b;
}

// 一键重试：POST /check/<id>/retry → 成功后立刻刷新列表（这条会变回排队中）
async function retryTask(t, btn) {
  btn.disabled = true;
  btn.textContent = "重排中…";
  try {
    const r = await fetch(`${WORKER}/check/${t.id}/retry`, {
      method: "POST",
      headers: { "x-check-key": key },
      signal: timeoutSignal(ACTION_TIMEOUT_MS),
    });
    if (r.status === 401) { keyExpired(); return; }
    if (r.status === 409) { setStatus("这条已经在排队了。", "pending"); }
    else if (!r.ok) { setStatus(`重试失败（HTTP ${r.status}），稍后再点一次。`, "error"); btn.disabled = false; btn.textContent = "再试一次"; return; }
    else setStatus("已重新排队，下一轮会重跑。", "success");
    loadRecent();
  } catch {
    setStatus("连不上核查服务，稍后再点一次。", "error");
    btn.disabled = false; btn.textContent = "再试一次";
  }
}

// 进入「补证据重查」模式：横幅显示父任务标题，输入箱聚焦；提交时走 recheck 接口
function startRecheck(t) {
  recheckParent = { id: t.id, title: taskTitle(t) };
  $("recheck-title").textContent = recheckParent.title;
  $("recheck-banner").hidden = false;
  $("check-text").placeholder = "补充新证据、新链接或截图；留空则只按原内容再查一遍";
  showList();
  window.scrollTo(0, 0);
  $("check-text").focus();
}

function cancelRecheck() {
  recheckParent = null;
  $("recheck-banner").hidden = true;
  $("check-text").placeholder = "贴消息、说法或链接；截图可直接粘贴，或点下面「图片」";
}

// 列表视图 / 详情视图二选一（同页切换，不刷新、不重输密钥）
function showList() { $("result-view").hidden = true; $("list-view").hidden = false; openTask = null; }
function showResultView() { $("list-view").hidden = true; $("result-view").hidden = false; window.scrollTo(0, 0); }

// 点开某条 done：进详情视图 → 懒拉完整结果 → 渲染。失败给可见兜底文案，不白屏。
async function openResult(t) {
  openTask = t;
  $("result-title").hidden = true;
  $("result-hero").hidden = true;
  $("result-dock").hidden = true;
  $("result-body").textContent = "加载中…";
  showResultView();
  let r;
  try {
    r = await fetch(`${WORKER}/check/${t.id}/result`, {
      headers: { "x-check-key": key },
      signal: timeoutSignal(RESULT_TIMEOUT_MS),
    });
  } catch {
    $("result-body").textContent = describeResultError(0);
    return;
  }
  if (r.status === 401) { keyExpired(); return; }
  if (!r.ok) { $("result-body").textContent = describeResultError(r.status); showDock(null); return; }
  let data = {};
  try {
    data = await r.json();
  } catch {
    $("result-body").textContent = describeResultError(0);
    return;
  }
  const md = typeof (data && data.result) === "string" ? data.result : "";
  if (!md.trim()) {
    $("result-body").textContent = "这条核查没有回传全文（可能是旧任务）。完整结果请在本机 Obsidian 的 Factcheck/ 目录查看。";
    showDock(null);
    return;
  }
  renderResult(md, t);
}

// 渲染完整结果：frontmatter → 裁定头卡；正文 → md.js 渲染。
// innerHTML 安全：renderMarkdown 已全程转义、链接仅放行 http(s)，且本页 CSP script-src 'self' 再兜一层。
function renderResult(md, t) {
  const { frontmatter, body } = parseFrontmatter(md);
  const h = resultHero(frontmatter);
  const hero = $("result-hero");
  hero.textContent = "";
  hero.dataset.tone = h.tone;
  const v = document.createElement("div");
  v.className = "vh-v";
  v.textContent = h.verdict ? `${h.mark} ${h.verdict}`.trim() : "核查结果";
  if (h.confidence) { const s = document.createElement("small"); s.textContent = `把握度 ${h.confidence}`; v.append(s); }
  hero.append(v);
  if (h.summaryText) { const one = document.createElement("div"); one.className = "vh-one"; one.textContent = h.summaryText; hero.append(one); }
  if (h.meta.length) {
    const m = document.createElement("div");
    m.className = "vh-meta";
    for (const it of h.meta) { const sp = document.createElement("span"); const b = document.createElement("b"); b.textContent = it.v; sp.append(`${it.k} `, b); m.append(sp); }
    hero.append(m);
  }
  hero.hidden = false;
  const title = frontmatter.title || (t && taskTitle(t)) || "";
  $("result-title").textContent = title;
  $("result-title").hidden = !title;
  $("result-body").innerHTML = renderMarkdown(body);
  showDock(frontmatter);
}

// 底部操作：在 Obsidian 打开（设置里填了库名 + 笔记带 note 字段才显示）、补充证据 · 重查
function showDock(frontmatter) {
  const a = $("result-obsidian");
  const note = (frontmatter && frontmatter.note) || "";
  a.dataset.note = note;   // 设置里改了库名后据此重算深链
  const uri = obsidianUri(readVault(store), note);
  a.hidden = !uri;
  a.href = uri || "#";
  $("result-dock").hidden = false;
}

function renderRecentError(text) {
  const box = $("recent-list");
  box.textContent = "";
  const p = document.createElement("p");
  p.className = "ck-empty";
  p.textContent = text;
  box.append(p);
}

// 刷新按钮的即时反馈：点下去立刻禁用 + 文案转「刷新中…」；成功后盖「已更新 <时刻>」回执。
function setRefreshing(on) {
  const btn = $("recent-refresh");
  btn.disabled = on;
  btn.textContent = on ? "刷新中…" : "刷新";
}
function showSyncedNote(date) {
  const el = $("recent-synced");
  const t = formatClockTime(date);
  el.textContent = t ? `已更新 ${t}` : "已更新";
  el.hidden = false;
}

// opts.manual=true 表示用户主动点「刷新」→ 给按钮 loading 态 + 成功后盖「已更新」回执；
// 后台轮询 / 切回前台 / 提交后自动刷新都不传，保持静默。
async function loadRecent(opts = {}) {
  const manual = !!(opts && opts.manual);
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (!key) return;
  if (manual) setRefreshing(true);
  try {
    const r = await fetch(WORKER + "/check/recent", {
      headers: { "x-check-key": key },
      signal: timeoutSignal(RECENT_TIMEOUT_MS),
    });
    if (r.status === 401) { keyExpired(); return; }
    if (!r.ok) { renderRecentError(describeRecentError(r.status)); scheduleRetry(r.status); return; }
    const { tasks } = await r.json();
    const list = Array.isArray(tasks) ? tasks : [];
    renderRecent(list);
    if (manual) showSyncedNote(new Date());
    if (shouldKeepPolling(list) && document.visibilityState === "visible") {
      pollTimer = setTimeout(loadRecent, POLL_MS);
    }
  } catch {
    renderRecentError(describeRecentError(0));
    scheduleRetry(0);
  } finally {
    if (manual) setRefreshing(false);
  }
}

// 拉列表失败后按退避重排一次轮询；401 不重排（已退回密钥闸）。
function scheduleRetry(status) {
  if (status === 401) return;
  if (document.visibilityState !== "visible") return;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(loadRecent, POLL_MS * 2);
}

// 状态色靠 CSS `.form-status[data-kind="success"|"error"|"pending"]`。
function setStatus(msg, kind) {
  const el = $("form-status");
  el.textContent = msg;
  el.dataset.kind = kind;
  el.hidden = !msg;
}

async function enter(presetKey) {
  const candidate = (presetKey != null ? presetKey : $("check-key").value).trim();
  if (!candidate) {
    $("gate-msg").textContent = "请输入密钥。";
    $("gate-msg").hidden = false;
    return;
  }
  // 用一次轻量请求探测密钥是否正确：发空载荷 POST /check，期待 400（载荷无效）而非 401（密钥错）
  let probeOk = false;
  try {
    const r = await fetch(WORKER + "/check", {
      method: "POST",
      headers: { "content-type": "application/json", "x-check-key": candidate },
      body: JSON.stringify({ text: "" }),
      signal: timeoutSignal(PROBE_TIMEOUT_MS),
    });
    // 401 = 密钥错；429 = 该 IP 已因连续错密钥被临时锁定（此时无论密钥对错都返回 429）。
    if (r.status === 401) {
      $("gate-msg").textContent = "密钥不对，请重输。";
      $("gate-msg").hidden = false;
      return;
    }
    if (r.status === 429) {
      $("gate-msg").textContent = "尝试过多，已临时锁定（约一小时后自动解除），请稍后再试。";
      $("gate-msg").hidden = false;
      return;
    }
    probeOk = true;
  } catch {
    probeOk = true;   // 网络错误也允许通过（离线场景），实际提交时再报错
  }
  if (probeOk) {
    key = candidate;
    saveKey(store, key);
    showForm();
  }
}

$("enter").addEventListener("click", () => enter());
$("check-key").addEventListener("keydown", (e) => { if (e.key === "Enter") enter(); });

// 选图：按钮 → 隐藏的 file input；粘贴 / 拖放也收图
$("pick-images").addEventListener("click", () => $("check-images").click());
$("check-images").addEventListener("change", async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = "";   // 清空，便于移除后重选同一文件
  await addImages(files);
});
$("check-text").addEventListener("paste", async (e) => {
  const items = [...((e.clipboardData && e.clipboardData.files) || [])];
  if (items.some((f) => /^image\//.test(f.type || ""))) {
    e.preventDefault();   // 有图就只收图；纯文字粘贴照常
    await addImages(items);
  }
});
const composer = $("check-form");
composer.addEventListener("dragover", (e) => { e.preventDefault(); composer.classList.add("dragover"); });
composer.addEventListener("dragleave", () => composer.classList.remove("dragover"));
composer.addEventListener("drop", async (e) => {
  e.preventDefault();
  composer.classList.remove("dragover");
  await addImages((e.dataTransfer && e.dataTransfer.files) || []);
});
// 文字变化 → 链接卡片跟着变（轻量防抖）
let attachTimer = null;
$("check-text").addEventListener("input", () => {
  clearTimeout(attachTimer);
  attachTimer = setTimeout(renderAttach, 150);
  // 自适应高度（上限由 CSS max-height 控制）
  const ta = $("check-text");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + "px";
});

$("check-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { text, link } = extractLink($("check-text").value);
  const v = validateCheckSubmission({ text, link, imageCount: selected.length });
  // 重查允许全空（只按原内容再查一遍），其余校验（超长 / 超张数）照旧
  const emptyOk = !!recheckParent && v.reason === "图片、文字、链接至少填一项。";
  if (!v.ok && !emptyOk) { setStatus(v.reason, "error"); return; }

  const btn = $("submit-btn");
  btn.disabled = true;
  setStatus("提交中…", "pending");
  const target = recheckParent ? `${WORKER}/check/${recheckParent.id}/recheck` : `${WORKER}/check`;

  try {
    const fd = new FormData();
    fd.append("text", text.trim());
    fd.append("link", link.trim());
    selected.forEach((it, i) => fd.append("images", it.blob, `img-${i}.jpg`));
    const r = await fetch(target, {
      method: "POST",
      headers: { "x-check-key": key },   // 不手设 content-type，让浏览器带 multipart 边界
      body: fd,
      signal: timeoutSignal(submitTimeoutMs(selected.length)),
    });
    if (r.status === 401) { keyExpired(); return; }
    if (r.status === 409 && recheckParent) { setStatus("上一次核查还没完成，等它跑完再补证据。", "error"); return; }
    const result = describeCheckResult(r.ok);
    setStatus(result.text, result.kind);
    if (result.kind === "success") {
      $("check-text").value = "";
      $("check-text").style.height = "";
      clearImages();
      renderAttach();
      cancelRecheck();
      loadRecent(); // 新任务立即出现在列表并开始轮询
    }
  } catch (err) {
    const e2 = describeSubmitError(err); // 超时单独给"换网络"指引，其余按一般网络错误
    setStatus(e2.text, e2.kind);
  } finally {
    btn.disabled = false;
  }
});

$("recheck-cancel").addEventListener("click", cancelRecheck);
$("result-recheck").addEventListener("click", () => { if (openTask) startRecheck(openTask); });
$("recent-refresh").addEventListener("click", () => loadRecent({ manual: true }));
$("result-back").addEventListener("click", showList);
// 切回前台且表单已解锁 → 刷新一次（顺带按需重启轮询）
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !$("form-area").hidden) loadRecent();
});

// ── 设置面板：Obsidian 库名（本机 localStorage）+ 退出 ──
function openSettings() {
  $("vault-name").value = readVault(store);
  $("settings").hidden = false;
  $("vault-name").focus();
}
function closeSettings() { $("settings").hidden = true; }
$("settings-open").addEventListener("click", openSettings);
$("settings-open-foot").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", closeSettings);
$("settings").addEventListener("click", (e) => { if (e.target === $("settings")) closeSettings(); });
$("settings-save").addEventListener("click", () => {
  saveVault(store, $("vault-name").value);
  closeSettings();
  if (!$("result-view").hidden) { /* 结果页开着：Obsidian 按钮随设置刷新 */
    const a = $("result-obsidian");
    const uriNow = obsidianUri(readVault(store), a.dataset.note || "");
    a.hidden = !uriNow;
    a.href = uriNow || "#";
  }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("settings").hidden) closeSettings(); });
$("logout").addEventListener("click", () => {
  clearKey(store);
  location.reload();
});

// 免密专属链接：check.html#k=<密钥> —— 打开即存密钥、直进表单，换设备也不用手输。
// 链接里的密钥优先于本机已存值；存好后立刻把密钥从地址栏抹掉。
function adoptHashKey() {
  const hashKey = keyFromHash(location.hash);
  if (!hashKey) return false;
  key = hashKey;
  saveKey(store, key);
  history.replaceState(null, "", location.pathname + location.search);
  return true;
}
adoptHashKey();
window.addEventListener("hashchange", () => { if (adoptHashKey()) showForm(); });

// 已有密钥（本机存过或专属链接刚带来）→ 直接显示表单（不用重输）
if (key) showForm();
