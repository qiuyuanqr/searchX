# M2a · 入队闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让朋友能在站内友好表单提交一个调研题目，经 Cloudflare Worker 校验后在 GitHub 建一条 `pending` Issue 并通知作者——全程 0 花费、0 上线。

**Architecture:** 公开面仍是 GitHub Pages 静态站，新增一张纸感**提交表单页**（构建进 `web/dist/submit.html`）。表单 POST 到一个无状态 **Cloudflare Worker**（唯一公开写入口）：Turnstile 人机验证 → 每 IP/邮箱每日限频（KV）→ 长度校验/清洗 → 用受限 GitHub token 建 `pending` Issue 并指派+@作者（触发 GitHub 原生邮件）。**仓库公开、Issue 公开 → 提交者邮箱绝不进 Issue 正文**，改存进 Worker 私有 KV（键 `sub:<issue号>`，留给 M2b Emailer），Issue 仅显示打码邮箱。

**Tech Stack:** 静态 HTML/CSS/JS（复用纸感 `feed.css` token）；bun + `bun:test`（与 M1 一致，全部纯函数 + 注入 fetch，离线可测）；Cloudflare Worker（ESM module，`export default { fetch }`，`bun build` 打成单文件，dashboard 粘贴或 `bun x wrangler deploy`）；Cloudflare Turnstile + KV；GitHub Issues + 受限 fine-grained PAT。

---

## 范围与边界

- **本计划只做 M2a（入队闭环）。** 不实现 Runner、不跑 `/research`、不发邮件——那是 M2b/M3（spec §6.4/§7）。
- **唯一花 Claude 额度处仍是 `/research` 本身；M2a 全是确定性脚本与一次性运维配置，零 token。**
- **不改 `/research` 产出格式、不改 M1 既有 build 输出语义**；只在 build 末尾多产一张 `submit.html`，并给首页加一个链接。
- 验收（spec §12 M2a）：站上提交 → 作者邮箱收到通知 + 仓库出现 `pending` Issue；驳回路径 0 花费、0 上线。

## File Structure

**新建（站点侧 · `web/`）**
- `web/src/site.config.json` — 公开站点配置（`WORKER_URL` / `TURNSTILE_SITE_KEY`，均为公开值，可入库）。
- `web/src/submit.template.html` — 纸感提交表单页模板（含 `{{WORKER_URL}}` / `{{TURNSTILE_SITE_KEY}}` 占位）。
- `web/src/assets/submit.js` — 表单客户端：两个纯函数（`buildPayload` / `describeResult`，可单测）+ 受 `typeof document` 守卫的 DOM 引导。
- `web/build/inject-config.js` + `.test.js` — 把 `{{KEY}}` 占位从配置对象注入模板字符串（纯函数）。

**修改（站点侧）**
- `web/build/build.js` — 末尾多读 `submit.template.html` + `site.config.json`，注入后写 `web/dist/submit.html`（assets 目录已整体拷贝，`submit.js` 自动带上）。
- `web/build/build.test.js` — 加一条断言：build 产出 `submit.html` 且含注入后的 `WORKER_URL`。
- `web/src/index.template.html` — 顶部加「+ 提交一个调研请求」链接到 `submit.html`。
- `web/src/assets/feed.css` — 加 `.submit-link` 样式（极简、纸感）。

**新建（Worker 侧 · `services/intake-worker/`）**
- `src/validate.js` + `.test.js` — `validateSubmission(input)`：必填/长度/邮箱/清洗。
- `src/issue-format.js` + `.test.js` — `formatIssue(clean,{author})` + `maskEmail(email)`：拼 Issue 标题/正文/标签/指派（纯函数）。
- `src/turnstile.js` + `.test.js` — `verifyTurnstile(token,secret,ip,fetchImpl)`：调 siteverify。
- `src/ratelimit.js` + `.test.js` — `checkRateLimit(kv,{...})` + `dayKey(date)`：KV 每日计数。
- `src/github.js` + `.test.js` — `createIssue({...},fetchImpl)`：调 GitHub Issues API。
- `src/handler.js` + `.test.js` — `handleIntake(request,env,deps)`：编排 CORS/方法/校验/限频/建 Issue/存邮箱。
- `src/index.js` — Cloudflare 入口 `export default { fetch }`（薄壳，不单测）。
- `wrangler.toml` — Worker 配置（KV 绑定 `INTAKE_KV`、公开 vars）。
- `README.md` — 一次性运维 + 部署手册（账号/Turnstile/token/labels/KV/deploy/E2E）。

**修改（根）**
- `package.json` — 加 `"build:worker"` 脚本（`bun build` 打 Worker 单文件）。
- `.gitignore` — 忽略 `services/intake-worker/dist/`。

> 命名约定（全计划一致，勿改）：KV 绑定 `INTAKE_KV`；env：`GITHUB_OWNER` / `GITHUB_REPO` / `AUTHOR_LOGIN` / `ALLOWED_ORIGIN` / `TURNSTILE_SECRET` / `GITHUB_TOKEN`；配置键 `WORKER_URL` / `TURNSTILE_SITE_KEY`；函数名见上。

---

# Phase A — 提交表单页（静态，0 花费，本地可验收）

> 本阶段全部在本地完成并 `bun test` + 浏览器目视，**先不推线上**（推线上要等 Phase C 把 Worker 跑通、`site.config.json` 填真值，否则表单 POST 到空地址）。

## Task 1: 配置注入工具 `injectConfig`

**Files:**
- Create: `web/build/inject-config.js`
- Test: `web/build/inject-config.test.js`

- [ ] **Step 1: Write the failing test**

```js
// web/build/inject-config.test.js
import { test, expect } from "bun:test";
import { injectConfig } from "./inject-config.js";

test("把 {{KEY}} 占位替换为配置值", () => {
  const out = injectConfig(`a={{WORKER_URL}} b={{TURNSTILE_SITE_KEY}}`, {
    WORKER_URL: "https://w.example.dev",
    TURNSTILE_SITE_KEY: "0xSITEKEY",
  });
  expect(out).toBe("a=https://w.example.dev b=0xSITEKEY");
});

test("未知占位原样保留（避免误删模板里的别的花括号）", () => {
  expect(injectConfig("x={{UNKNOWN}}", { WORKER_URL: "y" })).toBe("x={{UNKNOWN}}");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test web/build/inject-config.test.js`
Expected: FAIL — `Cannot find module './inject-config.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// web/build/inject-config.js
// 把 {{KEY}} 占位从扁平配置对象注入模板字符串；未知键原样保留。
export function injectConfig(template, config) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) =>
    key in config ? String(config[key]) : m
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test web/build/inject-config.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add web/build/inject-config.js web/build/inject-config.test.js
git commit -m "feat(web): add injectConfig template helper for M2a"
```

## Task 2: 站点公开配置 `site.config.json`

**Files:**
- Create: `web/src/site.config.json`

> 公开值，可入库。Phase C 部署后把 `WORKER_URL` / `TURNSTILE_SITE_KEY` 填成真值再推线上；现在先占位，保证本地构建/测试可跑。

- [ ] **Step 1: 写占位配置**

```json
{
  "WORKER_URL": "https://REPLACE_WITH_WORKER_URL",
  "TURNSTILE_SITE_KEY": "REPLACE_WITH_TURNSTILE_SITE_KEY"
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/site.config.json
git commit -m "feat(web): add public site.config.json (worker url + turnstile site key)"
```

## Task 3: 提交表单页模板 + 客户端脚本

**Files:**
- Create: `web/src/submit.template.html`
- Create: `web/src/assets/submit.js`
- Test: `web/src/assets/submit.test.js`

- [ ] **Step 1: Write the failing test（先测客户端两个纯函数）**

```js
// web/src/assets/submit.test.js
import { test, expect } from "bun:test";
import { buildPayload, describeResult } from "./submit.js";

test("buildPayload 去空白并带上 turnstile token", () => {
  const p = buildPayload(
    { title: "  比特币挖矿  ", focus: " 能耗 ", email: " a@b.com ", message: "" },
    "TKN"
  );
  expect(p).toEqual({
    title: "比特币挖矿",
    focus: "能耗",
    email: "a@b.com",
    message: "",
    turnstile: "TKN",
  });
});

test("describeResult: ok=true 给成功文案", () => {
  expect(describeResult({ ok: true }).kind).toBe("success");
});

test("describeResult: 已知错误码给对应中文", () => {
  expect(describeResult({ ok: false, error: "turnstile_failed" }).text).toContain("人机验证");
  expect(describeResult({ ok: false, error: "email_rate_limited" }).text).toContain("邮箱");
});

test("describeResult: 未知错误给兜底文案", () => {
  expect(describeResult({ ok: false, error: "weird" }).kind).toBe("error");
  expect(describeResult(null).kind).toBe("error");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test web/src/assets/submit.test.js`
Expected: FAIL — `Cannot find module './submit.js'`

- [ ] **Step 3: Write the client script**

```js
// web/src/assets/submit.js

// 纯函数：从表单字段值 + turnstile token 拼 POST 载荷。
export function buildPayload(fields, turnstileToken) {
  const s = (v) => (v == null ? "" : String(v)).trim();
  return {
    title: s(fields.title),
    focus: s(fields.focus),
    email: s(fields.email),
    message: s(fields.message),
    turnstile: turnstileToken || "",
  };
}

// 纯函数：把服务端响应（或异常）映射成给用户看的中文。
export function describeResult(res) {
  if (res && res.ok) {
    return {
      kind: "success",
      text: "已提交，作者会尽快审核。审核通过后研究结果会发到你的邮箱。",
    };
  }
  const map = {
    invalid: "请检查：题目和邮箱必填，且长度别超限。",
    bad_json: "提交格式有误，请重试。",
    turnstile_failed: "人机验证未通过，请重试。",
    ip_rate_limited: "今天提交太多次了，请明天再来。",
    email_rate_limited: "这个邮箱今天提交太多次了，请明天再来。",
    issue_create_failed: "服务器开小差了，请稍后重试。",
  };
  const code = res && res.error;
  return { kind: "error", text: map[code] || "提交失败，请稍后重试。" };
}

// DOM 引导：仅在浏览器运行（bun 测试环境无 document，自动跳过）。
if (typeof document !== "undefined") {
  const form = document.getElementById("submit-form");
  const statusEl = document.getElementById("form-status");

  const setStatus = (text, kind) => {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
    statusEl.hidden = false;
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const token = (fd.get("cf-turnstile-response") || "").toString();
    const payload = buildPayload(
      {
        title: fd.get("title"),
        focus: fd.get("focus"),
        email: fd.get("email"),
        message: fd.get("message"),
      },
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
      setStatus(out.text, out.kind);
      if (out.kind === "success") {
        form.reset();
        if (window.turnstile) window.turnstile.reset();
      }
    } catch {
      const out = describeResult({ ok: false });
      setStatus(out.text, out.kind);
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test web/src/assets/submit.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the form page template**

```html
<!-- web/src/submit.template.html -->
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>searchX · 提交调研请求</title>
<link rel="stylesheet" href="assets/feed.css">
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</head>
<body data-pagefind-ignore>
  <div class="wrap">
    <header>
      <div class="kicker"><span class="seal">研</span> 深度调研引擎 · DEEP RESEARCH</div>
      <h1 class="brand">提交一个调研请求</h1>
      <p class="lead" style="margin:.6rem 0 0">
        说清你想搞懂的对象（一个概念 / 一个人物 / 一种方法论 / 一个事件）。
        作者审核通过后会自动跑研究，结果会发到你留的邮箱，并出现在
        <a href="index.html" style="color:var(--seal)">调研档案</a> 里。
      </p>
      <div class="rule-grad" style="margin-top:1.1rem"></div>
    </header>

    <form id="submit-form" class="submit-form" data-worker="{{WORKER_URL}}" autocomplete="off">
      <label class="field">
        <span class="field-label">题目 <em>*</em></span>
        <input class="search" type="text" name="title" maxlength="160" required
               placeholder="例如：稳定币的清结算机制">
      </label>
      <label class="field">
        <span class="field-label">侧重点（可选）</span>
        <textarea class="search ta" name="focus" maxlength="500" rows="3"
                  placeholder="想重点了解的角度、想回答的具体问题…"></textarea>
      </label>
      <label class="field">
        <span class="field-label">你的邮箱 <em>*</em></span>
        <input class="search" type="email" name="email" maxlength="254" required
               placeholder="结果发到这里（不会公开）">
      </label>
      <label class="field">
        <span class="field-label">留言（可选）</span>
        <textarea class="search ta" name="message" maxlength="1000" rows="2"
                  placeholder="想对作者说的话…"></textarea>
      </label>

      <div class="cf-turnstile" data-sitekey="{{TURNSTILE_SITE_KEY}}"></div>

      <button class="submit-btn" type="submit">提交请求</button>
      <p id="form-status" class="form-status" role="status" aria-live="polite" hidden></p>
      <p class="fineprint">邮箱仅用于把结果发给你，不会出现在公开页面上。</p>
    </form>
  </div>

  <a class="to-top" href="index.html" aria-label="返回档案" title="返回档案" style="text-decoration:none">←</a>
  <script type="module" src="assets/submit.js"></script>
</body>
</html>
```

- [ ] **Step 6: Add form styles to `feed.css`（追加到文件末尾）**

```css
/* ── 提交表单页（M2a） ── */
.submit-form{margin-top:1.4rem; display:flex; flex-direction:column; gap:1.05rem}
.field{display:flex; flex-direction:column; gap:.4rem}
.field-label{font-family:var(--sans); font-size:.78rem; letter-spacing:.04em; color:var(--ink-soft)}
.field-label em{color:var(--seal); font-style:normal}
.search.ta{line-height:1.55; resize:vertical; min-height:2.6rem; font-family:var(--sans)}
.submit-btn{align-self:flex-start; font-family:var(--sans); font-size:.9rem; color:#fff;
  background:var(--seal); border:1px solid var(--seal); border-radius:10px;
  padding:.6rem 1.5rem; cursor:pointer; transition:transform .18s ease, box-shadow .25s ease, background .2s}
.submit-btn:hover{transform:translateY(-2px); box-shadow:0 10px 22px rgba(177,74,49,.22)}
.submit-btn:active{transform:translateY(0) scale(.98)}
.form-status{font-family:var(--sans); font-size:.86rem; margin:0}
.form-status[data-kind="success"]{color:var(--seal)}
.form-status[data-kind="error"]{color:#b3402c}
.form-status[data-kind="pending"]{color:var(--muted)}
.fineprint{font-family:var(--sans); font-size:.74rem; color:var(--muted); margin:0}
@media (prefers-reduced-motion: reduce){ .submit-btn{transition:none !important} }
```

- [ ] **Step 7: Commit**

```bash
git add web/src/submit.template.html web/src/assets/submit.js web/src/assets/submit.test.js web/src/assets/feed.css
git commit -m "feat(web): paper-themed submit form page + client helpers (M2a)"
```

## Task 4: build 产出 `submit.html` + 首页加入口链接

**Files:**
- Modify: `web/build/build.js`
- Modify: `web/build/build.test.js`
- Modify: `web/src/index.template.html`

- [ ] **Step 1: Write the failing test（追加到 `build.test.js` 末尾）**

```js
test("build 产出提交表单页并注入配置", () => {
  build({
    root: "web/build/fixtures/research",
    out: OUT,
    assets: "web/src/assets",
    template: "web/src/index.template.html",
    submitTemplate: "web/src/submit.template.html",
    config: "web/build/fixtures/site.config.json",
  });
  expect(existsSync(`${OUT}/submit.html`)).toBe(true);
  const submit = readFileSync(`${OUT}/submit.html`, "utf8");
  expect(submit).toContain('data-worker="https://worker.test.dev"');
  expect(submit).toContain('data-sitekey="0xTESTSITEKEY"');
  expect(submit).not.toContain("{{WORKER_URL}}");
  expect(existsSync(`${OUT}/assets/submit.js`)).toBe(true);
});
```

- [ ] **Step 2: Create the test fixture config**

```json
// web/build/fixtures/site.config.json
{
  "WORKER_URL": "https://worker.test.dev",
  "TURNSTILE_SITE_KEY": "0xTESTSITEKEY"
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test web/build/build.test.js`
Expected: FAIL — `submit.html` 不存在（build 还没写它）

- [ ] **Step 4: Modify `build.js`**

在 `build.js` 顶部 import 处加入 `injectConfig`：

```js
import { renderIndex } from "./render-index.js";
import { injectConfig } from "./inject-config.js";
```

把 `build` 的参数签名扩成：

```js
export function build({
  root = "research",
  out = "web/dist",
  assets = "web/src/assets",
  template = "web/src/index.template.html",
  submitTemplate = "web/src/submit.template.html",
  config = "web/src/site.config.json",
} = {}) {
```

在 `cpSync(assets, ...)` 那一行**之后**、`return entries;` **之前**插入：

```js
  // 提交表单页（M2a）：把公开配置注入模板后写出
  const submitTpl = readFileSync(submitTemplate, "utf8");
  const cfg = JSON.parse(readFileSync(config, "utf8"));
  writeFileSync(join(out, "submit.html"), injectConfig(submitTpl, cfg));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test web/build/build.test.js`
Expected: PASS（含新断言；老断言仍绿）

- [ ] **Step 6: 首页加入口链接（`index.template.html`）**

把 header 里的 `kicker` 那一行替换为带右侧链接的版本：

```html
      <div class="kicker">
        <span class="seal">研</span> 深度调研引擎 · DEEP RESEARCH
        <a class="submit-link" href="submit.html">+ 提交调研请求</a>
      </div>
```

并在 `feed.css` 末尾追加（紧跟 Task 3 加的那段之后）：

```css
.kicker .submit-link{margin-left:auto; font-size:.7rem; letter-spacing:.06em; text-transform:none;
  color:var(--seal); text-decoration:none; border-bottom:1px solid transparent; transition:border-color .2s}
.kicker .submit-link:hover{border-bottom-color:var(--seal-soft)}
```

- [ ] **Step 7: 全量构建并浏览器目视验收**

Run:
```bash
bun run build
bun run serve   # 或 .claude/launch.json 的 site（端口 8081）
```
打开 `http://localhost:8080/`（serve）确认：① 首页右上出现「+ 提交调研请求」；② 点进 `submit.html` 表单纸感一致、字段齐全、Turnstile 占位渲染（占位 sitekey 下会报错属正常，Phase C 填真值后消失）；③ 移动端宽度与深色模式不破版。

> 验证手段优先用文本：`bun run build` 后 `grep -c 'submit-link' web/dist/index.html` 应为 1；`grep -o 'data-worker="[^"]*"' web/dist/submit.html` 应回显配置值。

- [ ] **Step 8: Commit**

```bash
git add web/build/build.js web/build/build.test.js web/build/fixtures/site.config.json web/src/index.template.html web/src/assets/feed.css
git commit -m "feat(web): build submit.html with injected config + feed entry link (M2a)"
```

---

# Phase B — Intake Worker（Cloudflare，TDD，离线可测）

> 全部纯函数 + 注入 `fetchImpl`/假 KV，`bun test` 离线跑通；不碰真实 Cloudflare/GitHub。根目录 `bun test` 会递归捡到 `services/**/*.test.js`，与 SKILL Step 6 门禁兼容。

## Task 5: `validateSubmission` — 必填/长度/邮箱/清洗

**Files:**
- Create: `services/intake-worker/src/validate.js`
- Test: `services/intake-worker/src/validate.test.js`

- [ ] **Step 1: Write the failing test**

```js
// services/intake-worker/src/validate.test.js
import { test, expect } from "bun:test";
import { validateSubmission } from "./validate.js";

const good = { title: "稳定币清结算", focus: "机制", email: "a@b.com", message: "谢谢" };

test("合法输入通过且回 clean", () => {
  const r = validateSubmission(good);
  expect(r.ok).toBe(true);
  expect(r.errors).toEqual([]);
  expect(r.clean.title).toBe("稳定币清结算");
});

test("缺题目/缺邮箱报错", () => {
  expect(validateSubmission({ ...good, title: "   " }).errors).toContain("title_required");
  expect(validateSubmission({ ...good, email: "" }).errors).toContain("email_required");
});

test("邮箱格式非法报错", () => {
  expect(validateSubmission({ ...good, email: "not-an-email" }).errors).toContain("email_invalid");
});

test("超长报错", () => {
  expect(validateSubmission({ ...good, title: "x".repeat(161) }).errors).toContain("title_too_long");
  expect(validateSubmission({ ...good, message: "x".repeat(1001) }).errors).toContain("message_too_long");
});

test("清洗掉控制字符但保留换行", () => {
  const r = validateSubmission({ ...good, focus: "第一行\n第二行坏" });
  expect(r.ok).toBe(true);
  expect(r.clean.focus).toBe("第一行\n第二行坏");
});

test("非字符串字段不抛异常", () => {
  const r = validateSubmission({ title: 123, email: null });
  expect(r.ok).toBe(false);
  expect(r.errors).toContain("title_required");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test services/intake-worker/src/validate.test.js`
Expected: FAIL — 模块不存在

- [ ] **Step 3: Write minimal implementation**

```js
// services/intake-worker/src/validate.js
const LIMITS = { title: 160, focus: 500, message: 1000, email: 254 };

const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

// 去掉控制字符（保留 \t \n \r），去首尾空白
const sanitize = (s) =>
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();

export function validateSubmission(input, limits = LIMITS) {
  const get = (k) => (typeof input?.[k] === "string" ? input[k] : "");
  const title = get("title").trim();
  const focus = get("focus").trim();
  const message = get("message").trim();
  const email = get("email").trim();

  const errors = [];
  if (!title) errors.push("title_required");
  if (title.length > limits.title) errors.push("title_too_long");
  if (focus.length > limits.focus) errors.push("focus_too_long");
  if (message.length > limits.message) errors.push("message_too_long");
  if (!email) errors.push("email_required");
  else if (email.length > limits.email || !isEmail(email)) errors.push("email_invalid");

  const clean = {
    title: sanitize(title),
    focus: sanitize(focus),
    message: sanitize(message),
    email,
  };
  return { ok: errors.length === 0, errors, clean };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test services/intake-worker/src/validate.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add services/intake-worker/src/validate.js services/intake-worker/src/validate.test.js
git commit -m "feat(worker): validateSubmission for intake (M2a)"
```

## Task 6: `formatIssue` + `maskEmail` — 拼 Issue（公开仓库不漏邮箱）

**Files:**
- Create: `services/intake-worker/src/issue-format.js`
- Test: `services/intake-worker/src/issue-format.test.js`

- [ ] **Step 1: Write the failing test**

```js
// services/intake-worker/src/issue-format.test.js
import { test, expect } from "bun:test";
import { formatIssue, maskEmail } from "./issue-format.js";

test("maskEmail 只露域名，本地名打码", () => {
  expect(maskEmail("alice@gmail.com")).toBe("a****@gmail.com");
  expect(maskEmail("x@d.io")).toBe("x@d.io");
  expect(maskEmail("garbage")).toBe("***");
});

test("formatIssue 标题=题目，标签=pending，指派作者", () => {
  const r = formatIssue(
    { title: "稳定币清结算", focus: "机制", message: "", email: "a@b.com" },
    { author: "qiuyuanqr" }
  );
  expect(r.title).toBe("稳定币清结算");
  expect(r.labels).toEqual(["pending"]);
  expect(r.assignees).toEqual(["qiuyuanqr"]);
  expect(r.body).toContain("@qiuyuanqr");
  expect(r.body).toContain("approved");
});

test("正文用代码围栏包用户内容，杜绝 markdown 注入；含打码邮箱、不含原始邮箱", () => {
  const r = formatIssue(
    { title: "标题", focus: "看 [点我](http://evil)", message: "", email: "alice@gmail.com" },
    { author: "qiuyuanqr" }
  );
  expect(r.body).toContain("```");
  expect(r.body).toContain("[点我](http://evil)"); // 在围栏里，纯文本
  expect(r.body).toContain("a****@gmail.com");
  expect(r.body).not.toContain("alice@gmail.com");
});

test("无侧重点/留言时不渲染对应小节", () => {
  const r = formatIssue(
    { title: "t", focus: "", message: "", email: "a@b.com" },
    { author: "qiuyuanqr" }
  );
  expect(r.body).not.toContain("### 侧重点");
  expect(r.body).not.toContain("### 留言");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test services/intake-worker/src/issue-format.test.js`
Expected: FAIL — 模块不存在

- [ ] **Step 3: Write minimal implementation**

```js
// services/intake-worker/src/issue-format.js

// 公开仓库 → Issue 公开。邮箱只露域名，本地名打码。
export function maskEmail(email) {
  const at = email.indexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain) return "***";
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(1, local.length - 1))}@${domain}`;
}

// 用代码围栏包裹用户内容，杜绝 markdown/HTML 注入。
const fence = (label, text) => ["", `### ${label}`, "```", text, "```"];

// clean.email 传入前已被调用方替换成打码值（见 handler）。
export function formatIssue(clean, { author }) {
  const lines = [
    "**调研请求**（来自站内表单）",
    "",
    `- 提交者邮箱（打码）：\`${clean.email}\``,
    `- 审批：@${author} 贴 \`approved\` 标签即开始（贴前 0 花费）`,
    ...fence("题目", clean.title),
  ];
  if (clean.focus) lines.push(...fence("侧重点", clean.focus));
  if (clean.message) lines.push(...fence("留言", clean.message));

  return {
    title: clean.title,
    body: lines.join("\n"),
    labels: ["pending"],
    assignees: [author],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test services/intake-worker/src/issue-format.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add services/intake-worker/src/issue-format.js services/intake-worker/src/issue-format.test.js
git commit -m "feat(worker): formatIssue + maskEmail (keep submitter email out of public issue)"
```

## Task 7: `verifyTurnstile` — 人机验证

**Files:**
- Create: `services/intake-worker/src/turnstile.js`
- Test: `services/intake-worker/src/turnstile.test.js`

- [ ] **Step 1: Write the failing test**

```js
// services/intake-worker/src/turnstile.test.js
import { test, expect } from "bun:test";
import { verifyTurnstile } from "./turnstile.js";

const okFetch = async (url, opts) => ({
  ok: true,
  json: async () => ({ success: true }),
  _url: url,
  _body: opts.body,
});
const failFetch = async () => ({ ok: true, json: async () => ({ success: false }) });

test("token 为空直接 false，不发请求", async () => {
  let called = false;
  const r = await verifyTurnstile("", "secret", "1.2.3.4", async () => { called = true; });
  expect(r).toBe(false);
  expect(called).toBe(false);
});

test("siteverify success=true → true，且 secret/response/remoteip 进了表单体", async () => {
  let seen;
  const r = await verifyTurnstile("TKN", "SECRET", "1.2.3.4", async (u, o) => {
    seen = o.body;
    return okFetch(u, o);
  });
  expect(r).toBe(true);
  expect(seen).toContain("secret=SECRET");
  expect(seen).toContain("response=TKN");
  expect(seen).toContain("remoteip=1.2.3.4");
});

test("success=false → false", async () => {
  expect(await verifyTurnstile("TKN", "S", null, failFetch)).toBe(false);
});

test("HTTP 非 2xx → false", async () => {
  expect(await verifyTurnstile("TKN", "S", null, async () => ({ ok: false }))).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test services/intake-worker/src/turnstile.test.js`
Expected: FAIL — 模块不存在

- [ ] **Step 3: Write minimal implementation**

```js
// services/intake-worker/src/turnstile.js
const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(token, secret, remoteip, fetchImpl = fetch) {
  if (!token) return false;
  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (remoteip) form.set("remoteip", remoteip);

  const res = await fetchImpl(VERIFY_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) return false;
  const data = await res.json();
  return data.success === true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test services/intake-worker/src/turnstile.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add services/intake-worker/src/turnstile.js services/intake-worker/src/turnstile.test.js
git commit -m "feat(worker): verifyTurnstile (M2a)"
```

## Task 8: `checkRateLimit` + `dayKey` — 每日限频

**Files:**
- Create: `services/intake-worker/src/ratelimit.js`
- Test: `services/intake-worker/src/ratelimit.test.js`

- [ ] **Step 1: Write the failing test**

```js
// services/intake-worker/src/ratelimit.test.js
import { test, expect } from "bun:test";
import { checkRateLimit, dayKey } from "./ratelimit.js";

// 假 KV：Map 实现 get/put
function fakeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    store: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
  };
}

test("dayKey 输出 UTC 的 YYYYMMDD", () => {
  expect(dayKey(new Date("2026-06-03T15:00:00Z"))).toBe("20260603");
});

test("初次提交放行并把两个计数器置 1", async () => {
  const kv = fakeKV();
  const r = await checkRateLimit(kv, { ip: "1.1.1.1", email: "a@b.com", dayKey: "20260603" });
  expect(r.allowed).toBe(true);
  expect(kv.store.get("rl:ip:1.1.1.1:20260603")).toBe("1");
  expect(kv.store.get("rl:email:a@b.com:20260603")).toBe("1");
});

test("IP 达上限拒绝（reason=ip_rate_limited），不再自增", async () => {
  const kv = fakeKV({ "rl:ip:1.1.1.1:20260603": "8" });
  const r = await checkRateLimit(kv, {
    ip: "1.1.1.1", email: "a@b.com", dayKey: "20260603", limits: { ip: 8, email: 4 },
  });
  expect(r.allowed).toBe(false);
  expect(r.reason).toBe("ip_rate_limited");
  expect(kv.store.get("rl:ip:1.1.1.1:20260603")).toBe("8");
});

test("邮箱达上限拒绝（reason=email_rate_limited）", async () => {
  const kv = fakeKV({ "rl:email:a@b.com:20260603": "4" });
  const r = await checkRateLimit(kv, {
    ip: "9.9.9.9", email: "a@b.com", dayKey: "20260603", limits: { ip: 8, email: 4 },
  });
  expect(r.allowed).toBe(false);
  expect(r.reason).toBe("email_rate_limited");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test services/intake-worker/src/ratelimit.test.js`
Expected: FAIL — 模块不存在

- [ ] **Step 3: Write minimal implementation**

```js
// services/intake-worker/src/ratelimit.js
// 每 IP / 每邮箱 每日提交上限。KV 最终一致 → 近似限频即可
// （真正的闸是作者人工审批；这里只挡批量灌水）。

export function dayKey(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

export async function checkRateLimit(
  kv,
  { ip, email, dayKey, limits = { ip: 8, email: 4 }, ttl = 172800 }
) {
  const checks = [
    { key: `rl:ip:${ip}:${dayKey}`, max: limits.ip, reason: "ip_rate_limited" },
    { key: `rl:email:${email}:${dayKey}`, max: limits.email, reason: "email_rate_limited" },
  ];
  for (const c of checks) {
    const cur = parseInt((await kv.get(c.key)) || "0", 10);
    if (cur >= c.max) return { allowed: false, reason: c.reason };
  }
  for (const c of checks) {
    const cur = parseInt((await kv.get(c.key)) || "0", 10);
    await kv.put(c.key, String(cur + 1), { expirationTtl: ttl });
  }
  return { allowed: true, reason: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test services/intake-worker/src/ratelimit.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add services/intake-worker/src/ratelimit.js services/intake-worker/src/ratelimit.test.js
git commit -m "feat(worker): per-ip/email daily rate limit via KV (M2a)"
```

## Task 9: `createIssue` — 调 GitHub Issues API

**Files:**
- Create: `services/intake-worker/src/github.js`
- Test: `services/intake-worker/src/github.test.js`

- [ ] **Step 1: Write the failing test**

```js
// services/intake-worker/src/github.test.js
import { test, expect } from "bun:test";
import { createIssue } from "./github.js";

test("成功 → 回 number/url，并带正确的 URL/headers/body", async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ number: 42, html_url: "https://github.com/o/r/issues/42" }) };
  };
  const r = await createIssue(
    { owner: "o", repo: "r", token: "T", title: "标题", body: "正文", labels: ["pending"], assignees: ["qiuyuanqr"] },
    fetchImpl
  );
  expect(r).toEqual({ ok: true, number: 42, url: "https://github.com/o/r/issues/42" });
  expect(seen.url).toBe("https://api.github.com/repos/o/r/issues");
  expect(seen.opts.headers.authorization).toBe("Bearer T");
  expect(seen.opts.headers["user-agent"]).toBeTruthy();
  const body = JSON.parse(seen.opts.body);
  expect(body.title).toBe("标题");
  expect(body.labels).toEqual(["pending"]);
  expect(body.assignees).toEqual(["qiuyuanqr"]);
});

test("非 2xx → ok:false 带 status", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => "forbidden" });
  const r = await createIssue(
    { owner: "o", repo: "r", token: "T", title: "t", body: "b", labels: [], assignees: [] },
    fetchImpl
  );
  expect(r.ok).toBe(false);
  expect(r.status).toBe(403);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test services/intake-worker/src/github.test.js`
Expected: FAIL — 模块不存在

- [ ] **Step 3: Write minimal implementation**

```js
// services/intake-worker/src/github.js
export async function createIssue(
  { owner, repo, token, title, body, labels, assignees },
  fetchImpl = fetch
) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "searchx-intake",
    },
    body: JSON.stringify({ title, body, labels, assignees }),
  });
  if (!res.ok) {
    const error = await res.text().catch(() => "");
    return { ok: false, status: res.status, error };
  }
  const data = await res.json();
  return { ok: true, number: data.number, url: data.html_url };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test services/intake-worker/src/github.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add services/intake-worker/src/github.js services/intake-worker/src/github.test.js
git commit -m "feat(worker): createIssue via GitHub REST API (M2a)"
```

## Task 10: `handleIntake` — 编排（CORS / 方法 / 校验 / 限频 / 建 Issue / 存邮箱）

**Files:**
- Create: `services/intake-worker/src/handler.js`
- Test: `services/intake-worker/src/handler.test.js`

- [ ] **Step 1: Write the failing test**

```js
// services/intake-worker/src/handler.test.js
import { test, expect } from "bun:test";
import { handleIntake } from "./handler.js";

function fakeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { store: m, async get(k){return m.has(k)?m.get(k):null;}, async put(k,v){m.set(k,v);} };
}

const ENV = () => ({
  ALLOWED_ORIGIN: "https://qiuyuanqr.github.io",
  TURNSTILE_SECRET: "TS",
  GITHUB_TOKEN: "GT",
  GITHUB_OWNER: "qiuyuanqr",
  GITHUB_REPO: "searchX",
  AUTHOR_LOGIN: "qiuyuanqr",
  INTAKE_KV: fakeKV(),
});

// 假 fetch：按 URL 分流 turnstile / github
function routeFetch({ turnstile = true, issue = { number: 7, html_url: "https://x/7" } } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (String(url).includes("siteverify")) return { ok: true, json: async () => ({ success: turnstile }) };
    if (String(url).includes("api.github.com")) return { ok: true, json: async () => issue };
    return { ok: false, status: 404, text: async () => "nope" };
  };
  fn.calls = calls;
  return fn;
}

const post = (body) =>
  new Request("https://w.dev", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "5.5.5.5" },
    body: JSON.stringify(body),
  });

const NOW = new Date("2026-06-03T10:00:00Z");
const GOOD = { title: "稳定币清结算", focus: "机制", email: "alice@gmail.com", message: "", turnstile: "TKN" };

test("OPTIONS 预检回 204 + CORS 头", async () => {
  const res = await handleIntake(new Request("https://w.dev", { method: "OPTIONS" }), ENV());
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe("https://qiuyuanqr.github.io");
});

test("非 POST 回 405", async () => {
  const res = await handleIntake(new Request("https://w.dev", { method: "GET" }), ENV());
  expect(res.status).toBe(405);
});

test("快乐路径：建 Issue、存打码前的真实邮箱进 KV、回 ok", async () => {
  const env = ENV();
  const fetchImpl = routeFetch();
  const res = await handleIntake(post(GOOD), env, { fetch: fetchImpl, now: NOW });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  // 邮箱以 sub:<number> 私有存 KV，供 M2b 用
  expect(env.INTAKE_KV.store.get("sub:7")).toBe("alice@gmail.com");
  // 发给 GitHub 的正文不含原始邮箱
  const ghCall = fetchImpl.calls.find((c) => String(c.url).includes("api.github.com"));
  expect(JSON.parse(ghCall.opts.body).body).not.toContain("alice@gmail.com");
  expect(JSON.parse(ghCall.opts.body).body).toContain("a****@gmail.com");
});

test("Turnstile 失败 → 403，不建 Issue", async () => {
  const fetchImpl = routeFetch({ turnstile: false });
  const res = await handleIntake(post(GOOD), ENV(), { fetch: fetchImpl, now: NOW });
  expect(res.status).toBe(403);
  expect(fetchImpl.calls.some((c) => String(c.url).includes("api.github.com"))).toBe(false);
});

test("校验失败 → 400 + details", async () => {
  const res = await handleIntake(post({ ...GOOD, title: "" }), ENV(), { fetch: routeFetch(), now: NOW });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("invalid");
});

test("超限 → 429", async () => {
  const env = ENV();
  env.INTAKE_KV = fakeKV({ "rl:email:alice@gmail.com:20260603": "4" });
  const res = await handleIntake(post(GOOD), env, { fetch: routeFetch(), now: NOW });
  expect(res.status).toBe(429);
});

test("坏 JSON → 400 bad_json", async () => {
  const req = new Request("https://w.dev", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
  const res = await handleIntake(req, ENV(), { fetch: routeFetch(), now: NOW });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("bad_json");
});

test("GitHub 建 Issue 失败 → 502", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("siteverify")) return { ok: true, json: async () => ({ success: true }) };
    return { ok: false, status: 500, text: async () => "boom" };
  };
  const res = await handleIntake(post(GOOD), ENV(), { fetch: fetchImpl, now: NOW });
  expect(res.status).toBe(502);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test services/intake-worker/src/handler.test.js`
Expected: FAIL — 模块不存在

- [ ] **Step 3: Write minimal implementation**

```js
// services/intake-worker/src/handler.js
import { validateSubmission } from "./validate.js";
import { verifyTurnstile } from "./turnstile.js";
import { checkRateLimit, dayKey } from "./ratelimit.js";
import { formatIssue, maskEmail } from "./issue-format.js";
import { createIssue } from "./github.js";

export async function handleIntake(request, env, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const now = deps.now || new Date();

  const cors = {
    "access-control-allow-origin": env.ALLOWED_ORIGIN,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "origin",
  };
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json", ...cors },
    });

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  let input;
  try {
    input = await request.json();
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }

  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const token = typeof input?.turnstile === "string" ? input.turnstile : "";

  const passed = await verifyTurnstile(token, env.TURNSTILE_SECRET, ip, fetchImpl);
  if (!passed) return json({ ok: false, error: "turnstile_failed" }, 403);

  const { ok: valid, errors, clean } = validateSubmission(input);
  if (!valid) return json({ ok: false, error: "invalid", details: errors }, 400);

  const rl = await checkRateLimit(env.INTAKE_KV, { ip, email: clean.email, dayKey: dayKey(now) });
  if (!rl.allowed) return json({ ok: false, error: rl.reason }, 429);

  // 公开仓库 → Issue 正文只放打码邮箱
  const issue = formatIssue({ ...clean, email: maskEmail(clean.email) }, { author: env.AUTHOR_LOGIN });
  const created = await createIssue(
    { owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO, token: env.GITHUB_TOKEN, ...issue },
    fetchImpl
  );
  if (!created.ok) return json({ ok: false, error: "issue_create_failed" }, 502);

  // 真实邮箱私有存 KV（键 sub:<number>），供 M2b Emailer 取
  await env.INTAKE_KV.put(`sub:${created.number}`, clean.email);

  return json({ ok: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test services/intake-worker/src/handler.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Run the full suite（确认没破 M1）**

Run: `bun test`
Expected: PASS（M1 既有 10 个 + 本计划新增的全部）

- [ ] **Step 6: Commit**

```bash
git add services/intake-worker/src/handler.js services/intake-worker/src/handler.test.js
git commit -m "feat(worker): handleIntake orchestrator — CORS/validate/turnstile/rate-limit/issue (M2a)"
```

## Task 11: Worker 入口 + 打包脚本 + wrangler.toml

**Files:**
- Create: `services/intake-worker/src/index.js`
- Create: `services/intake-worker/wrangler.toml`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Write the Cloudflare entry（薄壳，不单测）**

```js
// services/intake-worker/src/index.js
import { handleIntake } from "./handler.js";

export default {
  async fetch(request, env) {
    return handleIntake(request, env);
  },
};
```

- [ ] **Step 2: Write `wrangler.toml`**

```toml
# services/intake-worker/wrangler.toml
name = "searchx-intake"
main = "src/index.js"
compatibility_date = "2026-01-01"

# KV：限频计数 + 提交者邮箱私有记录（sub:<issue号>）
# 创建后把 id 填进来：bun x wrangler kv namespace create INTAKE_KV
[[kv_namespaces]]
binding = "INTAKE_KV"
id = "REPLACE_WITH_KV_ID"

[vars]
GITHUB_OWNER = "qiuyuanqr"
GITHUB_REPO = "searchX"
AUTHOR_LOGIN = "qiuyuanqr"
ALLOWED_ORIGIN = "https://qiuyuanqr.github.io"

# 机密不写这里——用 dashboard 或 `bun x wrangler secret put`：
#   TURNSTILE_SECRET, GITHUB_TOKEN
```

- [ ] **Step 3: Add bundle script to `package.json`**

在 `scripts` 里加一行（放在 `serve` 之后）：

```json
    "build:worker": "bun build services/intake-worker/src/index.js --outfile services/intake-worker/dist/worker.js --format esm"
```

- [ ] **Step 4: gitignore Worker 产物**

在 `.gitignore` 的「deps & build output」段追加：

```
services/intake-worker/dist/
```

- [ ] **Step 5: 验证打包出单文件**

Run: `bun run build:worker`
Expected: 生成 `services/intake-worker/dist/worker.js`（单文件 ESM，含 `export default`）。

Run: `grep -c "export default" services/intake-worker/dist/worker.js`
Expected: ≥ 1

- [ ] **Step 6: Commit**

```bash
git add services/intake-worker/src/index.js services/intake-worker/wrangler.toml package.json .gitignore
git commit -m "feat(worker): cloudflare entry + bundle script + wrangler config (M2a)"
```

---

# Phase C — 运维配置 + 部署 + 端到端验收

> 本阶段是**一次性人工运维**（建账号/拿密钥/部署），非 TDD——涉及人持有的凭据与第三方控制台。每步给出确切操作；凭据**永不入库**。`{owner}={qiuyuanqr}`、`{repo}={searchX}`。

## Task 12: 部署 Worker 并打通端到端

**Files:**
- Create: `services/intake-worker/README.md`（把下面的步骤固化成手册）
- Modify: `web/src/site.config.json`（填真值）

- [ ] **Step 1: 在仓库建四个状态标签**（GitHub 网页 → `qiuyuanqr/searchX` → Issues → Labels → New label）：
  `pending` / `approved` / `rejected` / `done`。
  （`createIssue` 带 `labels:["pending"]`，标签须先存在；这四个也给 M2b 用。）

- [ ] **Step 2: 建受限 GitHub token**（Settings → Developer settings → **Fine-grained tokens** → Generate）：
  - Resource owner = `qiuyuanqr`，Repository access = **Only select repositories → searchX**。
  - Permissions → Repository → **Issues: Read and write**（其余全 No access）。
  - 生成后复制 token（形如 `github_pat_…`）。**只贴进 Cloudflare 机密，绝不入库。**

- [ ] **Step 3: 建 Cloudflare 账号（免费）+ Turnstile widget**：
  - Cloudflare dashboard → **Turnstile** → Add site：域名填 `qiuyuanqr.github.io`（Widget mode = Managed）。
  - 记下 **Site Key**（公开，进 `site.config.json`）和 **Secret Key**（机密，进 Worker）。

- [ ] **Step 4: 建 KV namespace**：
  - 用 wrangler：`bun x wrangler kv namespace create INTAKE_KV` → 把回显的 `id` 填进 `wrangler.toml`。
  - 或 dashboard：Workers & Pages → KV → Create namespace（名 `INTAKE_KV`），记下 id 填 `wrangler.toml`。

- [ ] **Step 5: 部署 Worker**（二选一）：
  - **A · wrangler（若 `bun x wrangler` 可用）**：
    ```bash
    cd services/intake-worker
    bun x wrangler secret put TURNSTILE_SECRET   # 粘 Turnstile Secret Key
    bun x wrangler secret put GITHUB_TOKEN        # 粘 fine-grained PAT
    bun x wrangler deploy
    ```
    记下回显的 Worker URL（形如 `https://searchx-intake.<subdomain>.workers.dev`）。
  - **B · dashboard 粘贴（本机无 node/wrangler 时的兜底）**：
    `bun run build:worker` → Workers & Pages → Create Worker → 编辑器粘贴 `services/intake-worker/dist/worker.js` → Settings 里：Variables 加 `GITHUB_OWNER/GITHUB_REPO/AUTHOR_LOGIN/ALLOWED_ORIGIN`（与 `wrangler.toml [vars]` 一致）、Secrets 加 `TURNSTILE_SECRET/GITHUB_TOKEN`、KV Bindings 绑 `INTAKE_KV` → 部署，记下 Worker URL。

- [ ] **Step 6: 回填站点配置并上线**：
  把真值写入 `web/src/site.config.json`：
  ```json
  {
    "WORKER_URL": "https://searchx-intake.<subdomain>.workers.dev",
    "TURNSTILE_SITE_KEY": "0x4AAAAAAA…"
  }
  ```
  然后（隐私终检确认无私人信息后）：
  ```bash
  bun test && bun run build
  git add web/src/site.config.json services/intake-worker/README.md
  git commit -m "chore(M2a): wire live worker url + turnstile site key; publish submit page"
  git push origin main
  ```
  push 触发既有 Action 部署，`https://qiuyuanqr.github.io/searchX/submit.html` 上线。

- [ ] **Step 7: 端到端验收（M2a「完成」定义）**：
  1. 打开线上 `submit.html`，Turnstile 正常渲染（无 sitekey 报错）。
  2. 填一条测试题目 + **你自己的邮箱**，过人机验证，提交 → 页面显示成功文案。
  3. 仓库 Issues 出现一条 `pending` Issue，标题=题目，正文含**打码**邮箱、指派给你、@你。
  4. 你的邮箱收到 GitHub 的指派/提醒邮件。
  5. 全程**无任何 `/research` 运行、无站点内容变更**（0 花费、0 上线新报告）。
  6. 反向：连发超过每日上限 → 第 N+1 次返回限频文案（验证限频）。
  7. 清理：关掉测试 Issue。

- [ ] **Step 8: 写 README 手册并提交**（把 Step 1–7 固化为 `services/intake-worker/README.md`，含"机密永不入库"红线、KV 里 `sub:<n>` 留给 M2b 的说明）：

```bash
git add services/intake-worker/README.md
git commit -m "docs(worker): M2a setup & deploy runbook"
```

> Step 6 的 `git push` 已触发自动上线；本计划不引入新的发布逻辑（复用 M1 的 Action + SKILL Step 6 语义）。

---

## Self-Review（对照 spec §6.1/§6.2/§6.3/§6.6/§10/§12）

- **§6.1 友好表单（无需 GitHub 账号）+ Worker 校验入队**：Task 3（表单）+ Task 5–10（Worker：Turnstile/限频/长度/建 Issue）✓
- **§6.2 GitHub Issues 即队列、`pending` 标签、GitHub 原生通知**：Task 6（labels:["pending"]）+ Task 12 Step 1（建标签）+ 指派/@作者触发邮件 ✓
- **§6.3 @作者 / 指派**：Task 6 `assignees:[author]` + 正文 `@author`，Task 12 Step 7 验证邮件 ✓
- **§6.6 安全模型**：Turnstile（Task 7）+ 限频（Task 8）+ 长度上限/清洗（Task 5）+ 受限 token（Task 12 Step 2）+ 机密永不进前端（site.config 只放公开值；Secret 只在 Worker）✓。"朋友口令/邮箱白名单"按用户选择**不先上**（spec 列为可选）。
- **§10.2 无需 GitHub 账号**：表单 + Worker 路线满足 ✓
- **§12 M2a 验收**：Task 12 Step 7 ✓
- **公开仓库泄露邮箱风险**：maskEmail + KV 私有存（Task 6 + Task 10）——超出 spec 显式条目的一处必要加固 ✓
- **零 token**：全程确定性脚本 + 一次性运维，无 `/research`、无大模型调用 ✓

**Placeholder 扫描**：无 TBD/TODO；每个 code step 给了完整代码与可运行命令。`site.config.json`/`wrangler.toml` 里的 `REPLACE_WITH_*` 是**运行期真值占位**（Task 12 显式填），非计划占位。

**类型/命名一致性**：KV 绑定全程 `INTAKE_KV`；env 名跨 handler/wrangler/README 一致；`validateSubmission`/`verifyTurnstile`/`checkRateLimit`/`dayKey`/`formatIssue`/`maskEmail`/`createIssue`/`handleIntake`/`injectConfig`/`buildPayload`/`describeResult` 在定义与调用处签名一致；错误码（`turnstile_failed`/`invalid`/`ip_rate_limited`/`email_rate_limited`/`bad_json`/`issue_create_failed`）在 handler 返回与 `describeResult` 映射两侧对齐。

**留给 M2b 的接口**：① `pending → approved → done` 标签机；② KV `sub:<issue号>` = 提交者真实邮箱（Emailer 取）；③ Worker `[vars]` 已定 owner/repo/author。M2b Runner 用同一受限 token + REST API 拉 `approved` 未 `done` 的 Issue。
