// web/src/assets/check-page.js — 事实核查提交页的 DOM 引导（外置脚本，配合严格 CSP `script-src 'self'`）。
// 纯逻辑（载荷构造 / 密钥读写 / 状态文案）在 check.js；本文件只做事件绑定与 fetch。
import {
  readKey, saveKey, clearKey, describeCheckResult, fitDimensions, validateCheckSubmission,
  describeTaskStatus, formatTaskTime, shouldKeepPolling,
} from "./check.js";

const WORKER = document.body.dataset.worker || "";   // {{WORKER_URL}} 注入在 body data-worker
const $ = (id) => document.getElementById(id);

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
const store = localStorage;
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

// ── 最近核查列表：拉 /check/recent 渲染；有排队中任务时每 20 秒自动刷新，全终态即停 ──
const POLL_MS = 20000;
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

async function loadRecent() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (!key) return;
  try {
    const r = await fetch(WORKER + "/check/recent", { headers: { "x-check-key": key } });
    if (!r.ok) return; // 401/5xx 静默：密钥失效在提交路径统一处理，列表失败可手动刷新
    const { tasks } = await r.json();
    const list = Array.isArray(tasks) ? tasks : [];
    renderRecent(list);
    if (shouldKeepPolling(list) && document.visibilityState === "visible") {
      pollTimer = setTimeout(loadRecent, POLL_MS);
    }
  } catch {} // 网络错误静默，手动刷新可重试
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
  } catch {
    setStatus("网络错误，请检查连接后重试。", "error");
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

// 本机会话已存密钥 → 直接显示表单（不用重输）
if (key) showForm();
