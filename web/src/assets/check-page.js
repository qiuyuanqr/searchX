// web/src/assets/check-page.js — 事实核查提交页的 DOM 引导（外置脚本，配合严格 CSP `script-src 'self'`）。
// 纯逻辑（载荷构造 / 密钥读写 / 状态文案）在 check.js；本文件只做事件绑定与 fetch。
import { buildCheckPayload, validateCheckPayload, readKey, saveKey, clearKey, describeCheckResult } from "./check.js";

const WORKER = document.body.dataset.worker || "";   // {{WORKER_URL}} 注入在 body data-worker
const $ = (id) => document.getElementById(id);

// 密钥只放 sessionStorage（关标签即清），不进 localStorage（缩小 XSS 窃取窗口）。
let key = readKey(sessionStorage);

function showGate() {
  $("gate").hidden = false;
  $("form-area").hidden = true;
  $("gate-msg").hidden = true;
}

function showForm() {
  $("gate").hidden = true;
  $("form-area").hidden = false;
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
    saveKey(sessionStorage, key);
    showForm();
  }
}

$("enter").addEventListener("click", () => enter());
$("check-key").addEventListener("keydown", (e) => { if (e.key === "Enter") enter(); });

$("check-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("check-text").value;
  const link = $("check-link").value;
  const payload = buildCheckPayload(text, link);
  const v = validateCheckPayload(payload);
  if (!v.ok) { setStatus(v.reason, "error"); return; }

  const btn = $("submit-btn");
  btn.disabled = true;
  setStatus("提交中…", "pending");

  try {
    const r = await fetch(WORKER + "/check", {
      method: "POST",
      headers: { "content-type": "application/json", "x-check-key": key },
      body: JSON.stringify(payload),
    });
    if (r.status === 401) {
      // 密钥失效（可能 Worker 重置）→ 退回密钥闸
      clearKey(sessionStorage);
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
    }
  } catch {
    setStatus("网络错误，请检查连接后重试。", "error");
  } finally {
    btn.disabled = false;
  }
});

$("logout").addEventListener("click", () => {
  clearKey(sessionStorage);
  location.reload();
});

// 本机会话已存密钥 → 直接显示表单（不用重输）
if (key) showForm();
