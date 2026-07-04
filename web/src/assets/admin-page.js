// web/src/assets/admin-page.js — 授权管理页的 DOM 引导（外置脚本，配合严格 CSP `script-src 'self'`）。
// 外置而非内联：让管理页能上 `script-src 'self'`（无 'unsafe-inline'），即使页面被注入标记也无法执行新脚本。
// 纯逻辑（拼链接 / 渲染 / 文案）在 admin.js；本文件只做事件绑定与请求。
import { renderPeopleRows, describeAdminError, describeSelftest } from "./admin.js";

const WORKER = document.body.dataset.worker || "";   // {{WORKER_URL}} 注入在 body data-worker
const base = new URL(".", document.baseURI).href;     // 站点根（admin.html 同级），拼专属链接用
const $ = (id) => document.getElementById(id);
// 密钥只放 sessionStorage（关标签即清），不进 localStorage（缩小 XSS 窃取窗口）。
// 属性访问包 try/catch：隐私模式/站点级禁存储下裸访问会抛错、整页脚本崩死（与 check-page.js 同款防护）。
function safeSession(){ try { return window.sessionStorage; } catch { return null; } }
const session = safeSession();
let key = (session && session.getItem("searchx_admin_key")) || "";

async function api(path, opts = {}) {
  return fetch(WORKER + path, {
    ...opts,
    signal: AbortSignal.timeout(10000), // 黑洞网络 10 秒即报错（与 submit/check 页一致），不让操作永远没有下文
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
    if (session) session.setItem("searchx_admin_key", key);
    $("gate").hidden = true; $("panel").hidden = false; $("gate-msg").hidden = true;
  } catch (s) {
    key = "";
    if (session) session.removeItem("searchx_admin_key");
    $("gate-msg").textContent = describeAdminError(s); $("gate-msg").hidden = false;
  }
}

$("enter").addEventListener("click", () => enter());
$("admin-key").addEventListener("keydown", (e) => { if (e.key === "Enter") enter(); });

$("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("add-email").value.trim();
  // 整体兜底：网络断开/请求超时会让 fetch reject，没有 catch 就是静默的未处理拒绝——
  // 管理员点了「生成专属链接」却看不到任何反馈，无从判断有没有生效。
  try {
    const r = await api("/admin/add", { method: "POST", body: JSON.stringify({ email }) });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      $("add-email").value = "";
      await load();
      // 生成即自检：立刻用新 token 打一次 /verify（与朋友页面同一路径），当场告诉管理员这条链接能不能发。
      let v = null;
      try {
        const vr = await fetch(WORKER + "/verify?k=" + encodeURIComponent((j && j.token) || ""), { signal: AbortSignal.timeout(10000) });
        v = await vr.json().catch(() => null);
      } catch {}
      $("add-msg").textContent = describeSelftest(v).text;
    }
    else $("add-msg").textContent = describeAdminError(r.status);
  } catch {
    $("add-msg").textContent = describeAdminError(0); // 网络异常 → 通用「操作失败，请重试」
  }
  $("add-msg").hidden = false;
});

$("people").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.act === "copy") {
    try { await navigator.clipboard.writeText(b.dataset.link); b.textContent = "已复制"; setTimeout(() => (b.textContent = "复制"), 1500); } catch {}
  }
  if (b.dataset.act === "revoke") {
    if (!confirm("撤销 " + b.dataset.email + "？该专属链接将立即失效。")) return;
    try {
      await api("/admin/remove", { method: "POST", body: JSON.stringify({ email: b.dataset.email }) });
      await load();
    } catch {
      // 撤销是安全敏感操作：失败必须显式说，不能让管理员误以为已撤干净
      $("add-msg").textContent = "网络异常，撤销可能未生效——请刷新页面确认名单。";
      $("add-msg").hidden = false;
    }
  }
});

$("logout").addEventListener("click", () => { if (session) session.removeItem("searchx_admin_key"); location.reload(); });

if (key) enter(key);   // 本机会话已存密钥 → 用它自动进（不是读空输入框）
