// web/src/assets/admin-page.js — 授权管理页的 DOM 引导（外置脚本，配合严格 CSP `script-src 'self'`）。
// 外置而非内联：让管理页能上 `script-src 'self'`（无 'unsafe-inline'），即使页面被注入标记也无法执行新脚本。
// 纯逻辑（拼链接 / 渲染 / 文案）在 admin.js；本文件只做事件绑定与请求。
import { renderPeopleRows, describeAdminError } from "./admin.js";

const WORKER = document.body.dataset.worker || "";   // {{WORKER_URL}} 注入在 body data-worker
const base = new URL(".", document.baseURI).href;     // 站点根（admin.html 同级），拼专属链接用
const $ = (id) => document.getElementById(id);
// 密钥只放 sessionStorage（关标签即清），不进 localStorage（缩小 XSS 窃取窗口）。
let key = sessionStorage.getItem("searchx_admin_key") || "";

async function api(path, opts = {}) {
  return fetch(WORKER + path, {
    ...opts,
    headers: { "content-type": "application/json", "x-admin-key": key, ...(opts.headers || {}) },
  });
}
async function load() {
  const r = await api("/admin/list");
  if (!r.ok) throw r.status;             // 401/429 → 抛状态码，由调用方提示
  const j = await r.json();
  $("people").innerHTML = renderPeopleRows(j.people || [], base);
}
// presetKey 给「自动登录」用——直接用 sessionStorage 里的密钥，而不是读空的输入框。
async function enter(presetKey) {
  key = (presetKey != null ? presetKey : $("admin-key").value).trim();
  if (!key) { $("gate-msg").textContent = describeAdminError(401); $("gate-msg").hidden = false; return; }
  try {
    await load();
    sessionStorage.setItem("searchx_admin_key", key);
    $("gate").hidden = true; $("panel").hidden = false; $("gate-msg").hidden = true;
  } catch (s) {
    key = "";
    sessionStorage.removeItem("searchx_admin_key");
    $("gate-msg").textContent = describeAdminError(s); $("gate-msg").hidden = false;
  }
}

$("enter").addEventListener("click", () => enter());
$("admin-key").addEventListener("keydown", (e) => { if (e.key === "Enter") enter(); });

$("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("add-email").value.trim();
  const r = await api("/admin/add", { method: "POST", body: JSON.stringify({ email }) });
  if (r.ok) { $("add-email").value = ""; $("add-msg").hidden = true; await load(); }
  else { $("add-msg").textContent = describeAdminError(r.status); $("add-msg").hidden = false; }
});

$("people").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.act === "copy") {
    try { await navigator.clipboard.writeText(b.dataset.link); b.textContent = "已复制"; setTimeout(() => (b.textContent = "复制"), 1500); } catch {}
  }
  if (b.dataset.act === "revoke") {
    if (!confirm("撤销 " + b.dataset.email + "？该专属链接将立即失效。")) return;
    await api("/admin/remove", { method: "POST", body: JSON.stringify({ email: b.dataset.email }) });
    await load();
  }
});

$("logout").addEventListener("click", () => { sessionStorage.removeItem("searchx_admin_key"); location.reload(); });

if (key) enter(key);   // 本机会话已存密钥 → 用它自动进（不是读空输入框）
