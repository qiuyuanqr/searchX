// web/src/assets/check-page.js — 事实核查提交页的 DOM 引导（外置脚本，配合严格 CSP `script-src 'self'`）。
// 纯逻辑（载荷构造 / 密钥读写 / 状态文案）在 check.js；本文件只做事件绑定与 fetch。
import {
  readKey, saveKey, clearKey, keyFromHash, describeCheckResult, describeSubmitError, describeRecentError,
  submitTimeoutMs, fitDimensions, validateCheckSubmission,
  describeTaskStatus, formatTaskTime, shouldKeepPolling,
} from "./check.js";

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

const MAX_IMAGES = 9;
const MAX_EDGE = 2000;     // 长边超此值才缩（保字迹优先）
const JPEG_QUALITY = 0.9;

// 已选图片：每项 { blob, url }。blob 是重编码后的 JPEG（归一化 HEIC、按需缩小）；url 是预览 object URL。
let selected = [];

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

function renderPreviews() {
  const box = $("img-preview");
  box.textContent = "";
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
  box.hidden = selected.length === 0;
}

function removeImage(i) {
  const [gone] = selected.splice(i, 1);
  if (gone) URL.revokeObjectURL(gone.url);
  renderPreviews();
}

function clearImages() {
  for (const it of selected) URL.revokeObjectURL(it.url);
  selected = [];
  renderPreviews();
}

// 密钥存 localStorage：输一次后此设备持久免登，关标签 / 重开浏览器都不丢。
// 仅手动点「退出」、清浏览器缓存、或换设备时才需重输；Worker 若改密钥则提交时 401 自动退回密钥闸。
// 取舍：明文密钥长期留在本机浏览器（不再是关标签即清）。此页为私人提交页 + 严格 CSP（script-src 'self'），
// XSS 面极窄，密钥泄露最坏后果仅是他人能投递核查任务、读不到任何数据，权衡下可接受。
// 与 feed.js 同款防护：沙箱/隐私模式下访问 localStorage 属性本身就可能抛 SecurityError，
// 必须 try/catch——否则整个模块加载失败，「进入」按钮等所有交互整页失效且无任何提示。
// readKey/saveKey/clearKey 已容忍空 storage（内部 try/catch），拿不到就退化为每次重输密钥。
function safeStorage(){ try { return window.localStorage; } catch { return null; } }
const store = safeStorage();
let key = readKey(store);

function showGate() {
  $("gate").hidden = false;
  $("form-area").hidden = true;
  $("gate-msg").hidden = true;
}

function showForm() {
  $("gate").hidden = true;
  $("form-area").hidden = false;
  loadRecent();
}

// ── 最近核查列表：拉 /check/recent 渲染；有排队中任务时每 50 秒自动刷新，全终态即停 ──
// （核查一趟通常要几分钟，20 秒轮询太勤；50 秒足够手机端"回来看一眼就有"）
const POLL_MS = 50000;
let pollTimer = null;

function renderRecent(tasks) {
  const box = $("recent-list");
  box.textContent = "";
  if (!tasks.length) {
    const p = document.createElement("p");
    p.className = "field-hint";
    p.textContent = "最近 7 天没有核查任务。";
    box.append(p);
    return;
  }
  for (const t of tasks) {
    const item = document.createElement("div");
    item.className = "task-item";
    const head = document.createElement("div");
    head.className = "task-head";
    const time = document.createElement("span");
    time.className = "task-time";
    time.textContent = formatTaskTime(t.createdAt);
    const st = describeTaskStatus(t.status);
    const chip = document.createElement("span");
    chip.className = "task-chip";
    chip.dataset.kind = st.kind;
    chip.textContent = st.label;
    head.append(time, chip);
    const snip = document.createElement("p");
    snip.className = "task-snippet";
    snip.textContent = t.textSnippet || "（无摘要）";
    item.append(head, snip);
    if (t.summary) {
      const sum = document.createElement("p");
      sum.className = "task-summary";
      sum.textContent = t.summary;
      item.append(sum);
    }
    box.append(item);
  }
}

// 加载失败 → 在列表区给一行可见提示（不再静默——静默过一次"手机连不上 workers.dev"，
// 页面上完全无从判断是哪环出的问题）。密钥清理仍统一走提交路径。
function renderRecentError(text) {
  const box = $("recent-list");
  box.textContent = "";
  const p = document.createElement("p");
  p.className = "field-hint";
  p.textContent = text;
  box.append(p);
}

async function loadRecent() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (!key) return;
  try {
    const r = await fetch(WORKER + "/check/recent", {
      headers: { "x-check-key": key },
      signal: timeoutSignal(RECENT_TIMEOUT_MS),
    });
    if (!r.ok) { renderRecentError(describeRecentError(r.status)); return; }
    const { tasks } = await r.json();
    const list = Array.isArray(tasks) ? tasks : [];
    renderRecent(list);
    if (shouldKeepPolling(list) && document.visibilityState === "visible") {
      pollTimer = setTimeout(loadRecent, POLL_MS);
    }
  } catch {
    renderRecentError(describeRecentError(0)); // 超时/不可达：给出"连不上"提示，点「刷新」重试
  }
}

// 对齐站点约定（feed.js）：状态色靠 CSS `.form-status[data-kind="success"|"error"|"pending"]`。
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
  // 注：Worker 对空 text 应返回 400；密钥错返回 401。若 Worker 直接返回 401 以外视为密钥通过。
  let probeOk = false;
  try {
    const r = await fetch(WORKER + "/check", {
      method: "POST",
      headers: { "content-type": "application/json", "x-check-key": candidate },
      body: JSON.stringify({ text: "" }),
      signal: timeoutSignal(PROBE_TIMEOUT_MS),
    });
    // 401 = 密钥错；其它状态（包括 400 bad request）视为密钥本身是好的
    if (r.status === 401) {
      $("gate-msg").textContent = "密钥不对，请重输。";
      $("gate-msg").hidden = false;
      return;
    }
    probeOk = true;
  } catch {
    // 网络错误也允许通过（离线场景），实际提交时再报错
    probeOk = true;
  }
  if (probeOk) {
    key = candidate;
    saveKey(store, key);
    showForm();
  }
}

$("enter").addEventListener("click", () => enter());
$("check-key").addEventListener("keydown", (e) => { if (e.key === "Enter") enter(); });

// 选图：逐张重编码为 JPEG → 加入 selected → 渲染预览。超 9 张拒收并提示。
$("check-images").addEventListener("change", async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = "";   // 清空，便于移除后重选同一文件
  if (!files.length) return;
  for (const f of files) {
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
  renderPreviews();
});

$("check-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("check-text").value;
  const link = $("check-link").value;
  const v = validateCheckSubmission({ text, link, imageCount: selected.length });
  if (!v.ok) { setStatus(v.reason, "error"); return; }

  const btn = $("submit-btn");
  btn.disabled = true;
  setStatus("提交中…", "pending");

  try {
    const fd = new FormData();
    fd.append("text", text.trim());
    fd.append("link", link.trim());
    selected.forEach((it, i) => fd.append("images", it.blob, `img-${i}.jpg`));
    const r = await fetch(WORKER + "/check", {
      method: "POST",
      headers: { "x-check-key": key },   // 不手设 content-type，让浏览器带 multipart 边界
      body: fd,
      signal: timeoutSignal(submitTimeoutMs(selected.length)),
    });
    if (r.status === 401) {
      // 密钥失效（可能 Worker 重置）→ 退回密钥闸
      clearKey(store);
      key = "";
      showGate();
      $("gate-msg").textContent = "密钥已失效，请重新输入。";
      $("gate-msg").hidden = false;
      return;
    }
    const result = describeCheckResult(r.ok);
    setStatus(result.text, result.kind);
    if (result.kind === "success") {
      $("check-text").value = "";
      $("check-link").value = "";
      clearImages();
      loadRecent(); // 新任务立即出现在列表并开始轮询
    }
  } catch (err) {
    const e = describeSubmitError(err); // 超时单独给"换网络"指引，其余按一般网络错误
    setStatus(e.text, e.kind);
  } finally {
    btn.disabled = false;
  }
});

$("logout").addEventListener("click", () => {
  clearKey(store);
  location.reload();
});

$("recent-refresh").addEventListener("click", () => loadRecent());
// 切回前台且表单已解锁 → 刷新一次（顺带按需重启轮询）
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !$("form-area").hidden) loadRecent();
});

// 免密专属链接：check.html#k=<密钥> —— 打开即存密钥、直进表单，换设备也不用手输。
// 链接里的密钥优先于本机已存值（Worker 重置密钥后发新链接即可覆盖旧的）。
// 不做在线探测：专属链接在弱网/被墙时也要能进表单；密钥若错，提交时 401 会自动退回密钥闸。
// 存好后立刻把密钥从地址栏抹掉，避免常驻屏幕被旁人瞥见（收藏的链接本身不受影响）。
// 收下专属链接 hash 里的密钥（有则覆盖本机已存值——Worker 重置密钥后发新链接即可换钥），
// 并立刻把密钥从地址栏抹掉，避免常驻屏幕被旁人瞥见（收藏的链接本身不受影响）。返回是否收到。
function adoptHashKey() {
  const hashKey = keyFromHash(location.hash);
  if (!hashKey) return false;
  key = hashKey;
  saveKey(store, key);
  history.replaceState(null, "", location.pathname + location.search);
  return true;
}
adoptHashKey();
// 页面已开着时在地址栏输专属链接只改 hash、不重载脚本 → 靠 hashchange 补上同样的接收逻辑
window.addEventListener("hashchange", () => { if (adoptHashKey()) showForm(); });

// 已有密钥（本机存过或专属链接刚带来）→ 直接显示表单（不用重输）
if (key) showForm();
