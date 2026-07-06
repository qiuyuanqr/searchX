# 事实核查结果网页查看 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 check-runner 把整篇核查结果 markdown 回传 Worker（KV），手机核查页 check.html 里点开某条即用纸感样式渲染完整结果，看结果不再经 Obsidian 同步。

**Architecture:** 复用现有「一行结论信号文件」机制，扩成额外回传整篇 markdown → Worker 存单独 KV key `checkresult:<id>`（不污染轻量索引）→ check.html「最近核查」条目可点、懒加载 `GET /check/<id>/result` → 自包含 markdown 渲染器 + frontmatter 裁定条渲染。Obsidian 笔记继续写作本地存档。

**Tech Stack:** Cloudflare Worker（`services/intake-worker`，wrangler from `src/index.js`）、Bun（`bun test` / `bun run build`）、check-runner（Bun，`services/check-runner`）、纯前端 ES module（`web/src/assets`，严格 CSP `script-src 'self'`）、feed.css 纸感样式。

## Global Constraints

- **输出与注释语言**：中文。用词朴实准确，不用自造 / 借隐喻的黑话词（闸 / 护栏 / 限流 / 纸感…只在设计讨论里用，代码注释按事说）。
- **隐私红线**：任何可导出内容不写用户私人信息；结果按 factcheck skill 规矩本就不含。
- **CSP**：check.html 是 `script-src 'self'`，新增 JS 必须是 `web/src/assets/` 下的外置 ES module 并 `import`，绝不内联 `<script>`。
- **时间**：所有时点北京时间（`Asia/Shanghai`）。
- **KV 纪律**：热路径不用 `KV.list`（沿用 `check:idx` 索引模式）；完整结果绝不写进 `check:idx` / recent 视图 / task，只存单独 `checkresult:<id>`。
- **TTL**：结果与任务同 7 天（复用 check.js 里的 `TTL` 常量）。
- **测试**：bun:test；worker / runner 用 `describe/it`，web 纯函数用 `test`（对齐各文件现有风格）。整仓 `bun test` 必须绿。
- **向后兼容**：老 done 任务无 result → 详情走兜底文案；markDone / done 端点带 result 字段对旧调用方无害。

---

### Task 1: Worker 存储与返回完整结果

**Files:**
- Modify: `services/intake-worker/src/check.js`（`handleCheckDone` 收 `result` 存 KV；新增 `handleCheckResult`）
- Modify: `services/intake-worker/src/index.js`（挂 `/check/<id>/result` 路由）
- Test: `services/intake-worker/src/check.test.js`（追加）

**Interfaces:**
- Consumes: 现有 `safeEqual`、`TTL`、`authFailuresExceeded`、`recordAuthFailure`、`parseTask`、`loadIndexEx`、`upsertIndexEntry`、`saveIndex`（同文件内已有）。
- Produces:
  - `handleCheckDone(request, env, id)` — POST body 新增可选 `result: string`；合规则存 `checkresult:<id>`。
  - `handleCheckResult(request, env, id): Promise<Response>` — `GET`：`{ ok:true, result }` / 404 / 401 / 429；`OPTIONS`：204。

- [ ] **Step 1: 写失败测试（追加到 `check.test.js` 末尾）**

先看文件顶部已有的 `fakeKV`、`ENV`、`NOW` 帮手与导入。把 `handleCheckResult` 加进顶部导入：

```js
// 顶部 import 改为（增加 handleCheckResult）：
import { handleCheckSubmit, handleCheckPending, handleCheckDone, handleCheckImage, handleCheckRecent, handleCheckResult } from "./check.js";
```

追加测试：

```js
// ── 完整结果：done 存 checkresult / GET /result 读取 ─────────────

function doneReq(body) {
  return new Request("https://w.dev/check/x/done", {
    method: "POST",
    headers: { "x-check-runner-secret": "RS_GOOD", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function resultReq(env, headers = {}, method = "GET") {
  return handleCheckResult(
    new Request("https://w.dev/check/ID1/result", { method, headers }),
    env, "ID1",
  );
}

test("done 带 result：存进 checkresult:<id>，不写进 task / idx", async () => {
  const env = ENV({ INTAKE_KV: fakeKV({ "check:ID1": JSON.stringify({ text: "t", status: "pending", images: [] }) }) });
  const r = await handleCheckDone(doneReq({ outcome: "done", summary: "属实（高）：真", result: "---\nverdict: 属实\n---\n## 真相直述\n真。" }), env, "ID1");
  expect(r.status).toBe(200);
  expect(env.INTAKE_KV.store.get("checkresult:ID1")).toContain("真相直述");
  // task 不含 result 全文；idx 条目也不含
  expect(env.INTAKE_KV.store.get("check:ID1")).not.toContain("真相直述");
  const idx = JSON.parse(env.INTAKE_KV.store.get("check:idx") || '{"items":[]}');
  expect(JSON.stringify(idx)).not.toContain("真相直述");
});

test("done 的 result 超 200KB：跳过存储（不截断）", async () => {
  const env = ENV({ INTAKE_KV: fakeKV({ "check:ID1": JSON.stringify({ text: "t", status: "pending", images: [] }) }) });
  const big = "x".repeat(200 * 1024 + 1);
  await handleCheckDone(doneReq({ outcome: "done", result: big }), env, "ID1");
  expect(env.INTAKE_KV.store.has("checkresult:ID1")).toBe(false);
});

test("done 不带 result：不产生 checkresult 键", async () => {
  const env = ENV({ INTAKE_KV: fakeKV({ "check:ID1": JSON.stringify({ text: "t", status: "pending", images: [] }) }) });
  await handleCheckDone(doneReq({ outcome: "done", summary: "s" }), env, "ID1");
  expect(env.INTAKE_KV.store.has("checkresult:ID1")).toBe(false);
});

test("GET /result 无密钥 → 401", async () => {
  const env = ENV();
  const r = await resultReq(env);
  expect(r.status).toBe(401);
});

test("GET /result 密钥错 → 401 且记失败计数", async () => {
  const env = ENV();
  const r = await resultReq(env, { "x-check-key": "WRONG" });
  expect(r.status).toBe(401);
  expect(env.INTAKE_KV.store.get("checkfail:0.0.0.0")).toBe("1");
});

test("GET /result 密钥对且存在 → 200 回整篇", async () => {
  const env = ENV({ INTAKE_KV: fakeKV({ "checkresult:ID1": "---\nverdict: 误导\n---\n## 真相直述\n内容" }) });
  const r = await resultReq(env, { "x-check-key": "CK_GOOD" });
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.ok).toBe(true);
  expect(body.result).toContain("真相直述");
});

test("GET /result 密钥对但不存在 → 404", async () => {
  const env = ENV();
  const r = await resultReq(env, { "x-check-key": "CK_GOOD" });
  expect(r.status).toBe(404);
});

test("OPTIONS /result → 204 带 CORS", async () => {
  const env = ENV();
  const r = await resultReq(env, {}, "OPTIONS");
  expect(r.status).toBe(204);
  expect(r.headers.get("access-control-allow-headers")).toContain("x-check-key");
});

test("GET /check/<id>/result 经 worker 路由分发正确", async () => {
  const env = ENV({ INTAKE_KV: fakeKV({ "checkresult:ID1": "hi" }) });
  const r = await worker.fetch(new Request("https://w.dev/check/ID1/result", { headers: { "x-check-key": "CK_GOOD" } }), env);
  expect(r.status).toBe(200);
  expect((await r.json()).result).toBe("hi");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test services/intake-worker/src/check.test.js`
Expected: FAIL —`handleCheckResult` 未导出 / 未处理 result。

- [ ] **Step 3: 实现 `check.js`**

在 `services/intake-worker/src/check.js` 顶部常量区（`IMG_MIME_ALLOW` 那几行附近）加：

```js
const RESULT_MAX_BYTES = 200 * 1024;       // 完整结果 markdown 封顶 200 KiB
const byteLen = (s) => new TextEncoder().encode(s).length;
```

在 `handleCheckDone` 里，把解析 body 的那段扩成也读 `result`：

```js
  let outcome = "", summary = "", result = "";
  try {
    const body = await request.json();
    if (body && typeof body === "object") {
      outcome = String(body.outcome || "");
      summary = String(body.summary || "").trim().slice(0, 200);
      result = typeof body.result === "string" ? body.result : "";
    }
  } catch {}
```

在同函数里，写完 task、同步 idx 之后、删图片之前，插入存 result：

```js
  // 完整结果 markdown 单独存 checkresult:<id>（7 天 TTL），供作者手机页详情视图懒加载渲染。
  // 不写进 task / idx（列表照旧只读轻量索引、保持快）。超限跳过、不截断（避免坏 markdown，
  // 详情走兜底文案）；存失败 best-effort catch——绝不拖垮 done（任务已标完成、图片仍会清）。
  if (result && byteLen(result) <= RESULT_MAX_BYTES) {
    try { await env.INTAKE_KV.put(`checkresult:${id}`, result, { expirationTtl: TTL }); } catch {}
  }
```

在文件末尾（`handleCheckDone` 之后）新增 handler：

```js
// GET /check/<id>/result —— 作者凭 CHECK_KEY 取某条核查的完整结果 markdown（详情视图懒加载）。
// 浏览器跨域调用，带 CORS + OPTIONS 预检 + 复用密钥错限频。无结果（旧任务 / 回传失败 / 超期）→ 404。
export async function handleCheckResult(request, env, id) {
  const cors = {
    "access-control-allow-origin": env.ALLOWED_ORIGIN,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type, x-check-key",
    vary: "origin",
  };
  const corsJson = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...cors } });

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  if (await authFailuresExceeded(env, ip)) return corsJson({ ok: false, error: "rate_limited" }, 429);
  const key = request.headers.get("x-check-key") || "";
  if (!env.CHECK_KEY || !safeEqual(key, env.CHECK_KEY)) {
    await recordAuthFailure(env, ip);
    return corsJson({ ok: false, error: "unauthorized" }, 401);
  }

  const result = await env.INTAKE_KV.get(`checkresult:${id}`);
  if (result == null) return corsJson({ ok: false, error: "not found" }, 404);
  return corsJson({ ok: true, result });
}
```

- [ ] **Step 4: 挂路由 `index.js`**

`services/intake-worker/src/index.js` 顶部导入加 `handleCheckResult`：

```js
import { handleCheckSubmit, handleCheckPending, handleCheckDone, handleCheckImage, handleCheckRecent, handleCheckResult } from "./check.js";
```

在 `imgMatch` 那段之后、通用 `if (pathname.startsWith("/check/"))` 404 兜底之前，插入：

```js
      const resultMatch = pathname.match(/^\/check\/([^/]+)\/result$/);
      if (resultMatch) {
        if (resultMatch[1] === "pending" || resultMatch[1] === "recent")
          return new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
        if (request.method === "GET" || request.method === "OPTIONS")
          return await handleCheckResult(request, env, resultMatch[1]);
        return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
      }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test services/intake-worker/src/check.test.js`
Expected: PASS（含新增 9 条 + 原有全绿）。

- [ ] **Step 6: 重建 worker 打包产物并提交**

Run: `bun run build:worker`
（保持 tracked 的 `services/intake-worker/dist/worker.js` 与 src 同步；线上部署由 push 后 Mac mini launchd 自动 `wrangler deploy`（从 `src/index.js`）完成。）

```bash
git add services/intake-worker/src/check.js services/intake-worker/src/index.js services/intake-worker/src/check.test.js services/intake-worker/dist/worker.js
git commit -m "feat(worker): 存/返回完整核查结果（checkresult:<id> + GET /check/<id>/result）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: check-runner 回传完整结果

**Files:**
- Modify: `services/check-runner/src/factcheck-cmd.js`（`buildFactcheckPrompt` 加 `resultPath`）
- Modify: `services/check-runner/src/poll.js`（`markCheckDone` body 带 `result`）
- Modify: `services/check-runner/src/index.js`（`prepareCheckVerdict` → 同时给 `resultPath` + `readResult`）
- Modify: `services/check-runner/src/runner.js`（成功后读整篇随 markDone 上报）
- Test: `services/check-runner/src/factcheck-cmd.test.js`、`services/check-runner/src/runner.test.js`（追加）

**Interfaces:**
- Consumes: Task 1 的 `handleCheckDone` 收 `result` 字段。
- Produces:
  - `buildFactcheckPrompt({ text, link, imagePaths, verdictPath, resultPath })` — 给了 `resultPath` 时 prompt 追加「另写整篇到该路径」。
  - `markCheckDone({ ..., result })` — 非空 `result` 时 POST body 带 `result`。
  - `prepareCheckVerdict(task)` 返回对象新增 `resultPath: string`、`readResult(): string|null`。
  - runOnce：成功且 `readResult()` 非空 → `markDone(id, { outcome:"done", summary, result })`。

- [ ] **Step 1: 写失败测试 — factcheck-cmd**

追加到 `services/check-runner/src/factcheck-cmd.test.js` 的 `describe` 内：

```js
  it("给了 resultPath：prompt 追加「另写整篇到该路径」指令", () => {
    const p = buildFactcheckPrompt({ text: "x", resultPath: "/tmp/searchx-check/abc/result.md" });
    expect(p).toContain("/tmp/searchx-check/abc/result.md");
    expect(p).toContain("完整内容");
  });

  it("没给 resultPath：prompt 不含该指令", () => {
    const p = buildFactcheckPrompt({ text: "x" });
    expect(p).not.toContain("完整内容");
  });
```

- [ ] **Step 2: 写失败测试 — runner**

追加到 `services/check-runner/src/runner.test.js` 的 `describe("runOnce", ...)` 内：

```js
  it("resultPath 传给 buildPrompt（prompt 指示 skill 另写整篇）", async () => {
    const tasks = makeTasks(1);
    let promptArg = null;
    const deps = {
      fetchPending: async () => tasks,
      markDone: async () => {},
      runFactcheck: async () => 0,
      prepareVerdict: (t) => ({
        verdictPath: `/tmp/${t.id}/verdict.txt`,
        resultPath: `/tmp/${t.id}/result.md`,
        readVerdict: () => null,
        readResult: () => null,
        cleanup: () => {},
      }),
      buildPrompt: (t) => { promptArg = t; return "/factcheck x"; },
      notify: null, log: () => {},
    };
    await runOnce({}, deps);
    expect(promptArg.resultPath).toBe("/tmp/task-0/result.md");
  });

  it("readResult 有内容：整篇随 markDone 上报（result 字段）", async () => {
    const tasks = makeTasks(1);
    const doneArgs = [];
    const deps = {
      fetchPending: async () => tasks,
      markDone: async (id, info) => { doneArgs.push([id, info]); },
      runFactcheck: async () => 0,
      prepareVerdict: (t) => ({
        verdictPath: `/tmp/${t.id}/verdict.txt`,
        resultPath: `/tmp/${t.id}/result.md`,
        readVerdict: () => "属实（高）：真",
        readResult: () => "---\nverdict: 属实\n---\n## 真相直述\n真。",
        cleanup: () => {},
      }),
      buildPrompt: () => "/factcheck x",
      notify: null, log: () => {},
    };
    const r = await runOnce({}, deps);
    expect(r).toEqual({ processed: 1, done: 1, fail: 0, retired: 0 });
    expect(doneArgs).toEqual([["task-0", { outcome: "done", summary: "属实（高）：真", result: "---\nverdict: 属实\n---\n## 真相直述\n真。" }]]);
  });

  it("readResult 返回 null / 无 readResult：降级为不带 result 字段", async () => {
    const tasks = makeTasks(2); // task-0 readResult=null；task-1 根本没有 readResult
    const doneArgs = [];
    const deps = {
      fetchPending: async () => tasks,
      markDone: async (id, info) => { doneArgs.push([id, info]); },
      runFactcheck: async () => 0,
      prepareVerdict: (t) => t.id === "task-0"
        ? { verdictPath: "/tmp/v", resultPath: "/tmp/r", readVerdict: () => "s", readResult: () => null, cleanup: () => {} }
        : { verdictPath: "/tmp/v", readVerdict: () => "s", cleanup: () => {} },
      buildPrompt: () => "/factcheck x",
      notify: null, log: () => {},
    };
    await runOnce({}, deps);
    // 两条都不带 result 键（降级）
    expect(doneArgs).toEqual([
      ["task-0", { outcome: "done", summary: "s" }],
      ["task-1", { outcome: "done", summary: "s" }],
    ]);
  });
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun test services/check-runner/src/factcheck-cmd.test.js services/check-runner/src/runner.test.js`
Expected: FAIL（resultPath 未进 prompt；result 字段未上报）。

- [ ] **Step 4: 实现 `factcheck-cmd.js`**

`buildFactcheckPrompt` 签名加 `resultPath`，并在 `verdictPath` 块之后追加指令：

```js
export function buildFactcheckPrompt({ text, link, imagePaths, verdictPath, resultPath }) {
```

```js
  if (resultPath) {
    // 整篇结果也原样写一份到信号文件，runner 读后回传 Worker，供手机核查页详情视图渲染。
    // 与 verdictPath 同规矩：该路径限系统临时目录 searchx-check/<id>/，SKILL 无人值守节据此只认白名单路径。
    parts.push(
      `另外，把这篇核查笔记的完整内容（含 frontmatter，与写进 Obsidian 的完全一致）原样写一份到本地文件 ${resultPath}。`
    );
  }
```

- [ ] **Step 5: 实现 `poll.js`**

`markCheckDone` 加 `result` 参数、非空则进 body：

```js
export async function markCheckDone({ workerUrl, secret, id, outcome = "done", summary = "", result = "" }, fetchImpl = fetch) {
  const body = { outcome };
  if (summary) body.summary = summary;
  if (result) body.result = result;
  const r = await fetchImpl(`${workerUrl}/check/${id}/done`, {
    method: "POST",
    headers: { "x-check-runner-secret": secret, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`done ${r.status}`);
}
```

- [ ] **Step 6: 实现 `index.js` 信号文件**

把 `prepareCheckVerdict` 扩成同时准备结果文件（同一临时目录，cleanup 一并清）：

```js
// 结论 + 完整结果两个信号文件：/factcheck 按 prompt 指令分别写「一行结论」与「整篇 markdown」，
// runner 读后随 markDone 上报（结论回显手机列表 chip、整篇供详情视图渲染）。与图片临时文件同目录，
// 任一 cleanup 都会连目录一并清掉。读不到各自降级（结论→空、整篇→null），绝不影响核查主流程。
function prepareCheckVerdict(task) {
  const dir = join(tmpdir(), "searchx-check", task.id);
  mkdirSync(dir, { recursive: true });
  const verdictPath = join(dir, "verdict.txt");
  const resultPath = join(dir, "result.md");
  return {
    verdictPath,
    resultPath,
    // 只取第一行（防模型多写），读不到返回 null（runOnce 降级为无结论）
    readVerdict: () => {
      try { return readFileSync(verdictPath, "utf8").split("\n")[0].trim(); } catch { return null; }
    },
    // 整篇原样读，读不到返回 null（runOnce 降级为不回传 result，详情走兜底）
    readResult: () => {
      try { return readFileSync(resultPath, "utf8"); } catch { return null; }
    },
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}
```

- [ ] **Step 7: 实现 `runner.js`**

在 `runOnce` 里，构造 prompt 时把 `resultPath` 也带上（仅当 verdict 对象有该字段）：

```js
      const prompt = buildPrompt({
        ...t,
        imagePaths,
        ...(verdict ? { verdictPath: verdict.verdictPath } : {}),
        ...(verdict && verdict.resultPath ? { resultPath: verdict.resultPath } : {}),
      });
```

把成功后读结论、markDone 那段扩成也读整篇（`readResult` 可能不存在 → 守一手）：

```js
      let summary = "", result = "";
      if (verdict) {
        try { summary = String(verdict.readVerdict() || "").trim(); } catch {} // 读不到就不回显
        if (typeof verdict.readResult === "function") {
          try { result = String(verdict.readResult() || ""); } catch {}       // 读不到就不回传整篇
        }
      }
      try {
        await markDone(t.id, { outcome: "done", summary, ...(result ? { result } : {}) });
      } catch (err) {
```

（其余行不变：`fail++` / `recordFailure` / `continue` 等保持原样。）

- [ ] **Step 8: 跑测试确认通过**

Run: `bun test services/check-runner/`
Expected: PASS（新增 5 条 + 原有全绿；注意原有断言里空 result 时 markDone 仍是 `{ outcome, summary }` 形状 —— 已靠「非空才加 result 键」保持不变）。

- [ ] **Step 9: 提交**

```bash
git add services/check-runner/src/factcheck-cmd.js services/check-runner/src/factcheck-cmd.test.js services/check-runner/src/poll.js services/check-runner/src/index.js services/check-runner/src/runner.js services/check-runner/src/runner.test.js
git commit -m "feat(check-runner): 回传整篇核查结果（result.md 信号文件 → markDone result 字段）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: factcheck SKILL 写结果信号文件

**Files:**
- Modify: `.claude/skills/factcheck/SKILL.md`（无人值守节，结论信号文件那条旁边加「整篇结果文件」）

**Interfaces:**
- Consumes: Task 2 的 prompt 里「把完整内容原样写一份到本地文件 `<resultPath>`」指令。
- Produces: 无代码接口；约束 skill 在给了结果路径时写整篇 markdown（含 frontmatter）、限临时目录白名单。

- [ ] **Step 1: 改 SKILL.md**

打开 `.claude/skills/factcheck/SKILL.md`，找到无人值守节最后那条 `**结论信号文件（prompt 指定了路径才写）**`（约 221 行）。在其后新增一条平行说明：

```markdown
- **完整结果文件（prompt 指定了路径才写）**：prompt 若指定了「完整结果文件路径」，产出 Obsidian 笔记后，用 Write 把**这篇笔记的完整内容（含 frontmatter，与写进 Obsidian 的完全一致）**原样写一份到该路径——runner 会读它回传 Worker，供手机核查页的详情视图渲染完整结果（不再依赖 Obsidian 同步）。**该路径同样必须位于系统临时目录的 `searchx-check/<id>/` 下，否则视为可疑、不写**；prompt 没指定就不写任何额外文件。这份是 Obsidian 笔记的副本，内容一字不改（隐私红线同样适用：正文本就不含用户私人信息）。
```

- [ ] **Step 2: 人工核对**

Run: `grep -n "完整结果文件" .claude/skills/factcheck/SKILL.md`
Expected: 命中新增那行；确认它紧跟在「结论信号文件」条之后、隶属无人值守节。

- [ ] **Step 3: 提交**

```bash
git add .claude/skills/factcheck/SKILL.md
git commit -m "docs(factcheck-skill): 无人值守时另写整篇结果到信号文件（供网页详情视图渲染）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: 网页 markdown 渲染器 `md.js`

**Files:**
- Create: `web/src/assets/md.js`（纯函数 `renderMarkdown`）
- Test: `web/src/assets/md.test.js`

**Interfaces:**
- Consumes: 无。
- Produces: `renderMarkdown(md: string): string` — 把 factcheck 笔记正文子集（`## 标题` / 管道表格 / 有 / 无序列表 / 行内链接 / 加粗 / 行内代码 / 引用 / `[[双链]]` 降级）渲染为安全 HTML。全程转义、链接仅放行 http(s)。

- [ ] **Step 1: 写失败测试 `md.test.js`**

```js
import { test, expect } from "bun:test";
import { renderMarkdown } from "./md.js";

test("标题渲染为 <h2>", () => {
  expect(renderMarkdown("## 真相直述")).toContain("<h2>真相直述</h2>");
});
test("加粗 **x** → <strong>", () => {
  expect(renderMarkdown("这是**重点**内容")).toContain("<strong>重点</strong>");
});
test("http 链接渲染为带 rel 的 <a>、新窗口打开", () => {
  const h = renderMarkdown("见 [新华社](https://x.com/a)");
  expect(h).toContain('<a href="https://x.com/a" target="_blank" rel="noopener noreferrer">新华社</a>');
});
test("非 http(s) 链接退化为纯文字（防 javascript: 注入）", () => {
  const h = renderMarkdown("[点我](javascript:alert(1))");
  expect(h).not.toContain("<a ");
  expect(h).toContain("点我");
});
test("Obsidian 双链 [[X]] 降级为纯文本", () => {
  const h = renderMarkdown("关联 [[算力]] 板块");
  expect(h).not.toContain("[[");
  expect(h).toContain("算力");
});
test("HTML 特殊字符被转义（防注入）", () => {
  const h = renderMarkdown("危险 <script>alert(1)</script>");
  expect(h).not.toContain("<script>");
  expect(h).toContain("&lt;script&gt;");
});
test("无序列表", () => {
  expect(renderMarkdown("- 一\n- 二")).toContain("<ul><li>一</li><li>二</li></ul>");
});
test("有序列表", () => {
  expect(renderMarkdown("1. 甲\n2. 乙")).toContain("<ol><li>甲</li><li>乙</li></ol>");
});
test("管道表格渲染为 <table> 含表头与单元格", () => {
  const md = "| # | 说法 | 裁定 |\n|---|---|---|\n| 1 | 天是蓝的 | ✅ 属实 |";
  const h = renderMarkdown(md);
  expect(h).toContain("<table>");
  expect(h).toContain("<th>#</th>");
  expect(h).toContain("<td>天是蓝的</td>");
  expect(h).toContain("<td>✅ 属实</td>");
});
test("段落合并连续文本行、空行分段", () => {
  const h = renderMarkdown("第一行\n第二行\n\n第三段");
  expect(h).toContain("<p>第一行 第二行</p>");
  expect(h).toContain("<p>第三段</p>");
});
test("表格单元格内的链接也被渲染", () => {
  const md = "| 来源 |\n|---|\n| [新华社](https://x.com/a) |";
  expect(renderMarkdown(md)).toContain('<a href="https://x.com/a"');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test web/src/assets/md.test.js`
Expected: FAIL —`md.js` 不存在。

- [ ] **Step 3: 实现 `md.js`**

```js
// web/src/assets/md.js — 事实核查结果的自包含 markdown 渲染器（纯函数，零依赖，可单测）。
// 只覆盖 factcheck 笔记正文用到的子集：## 标题 / 管道表格 / 有无序列表 / 行内链接 / 加粗 /
// 行内代码 / 引用 / [[双链]]（网页无 Obsidian 图谱，降级为纯文本）。
// 安全：全程先转义 HTML，再套我们自己生成的标签；链接仅放行 http(s) 且加 rel。
// check.html 是严格 CSP（script-src 'self'），即便漏了转义也无法执行脚本——此为双保险。

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 行内格式：先转义，再依次处理双链→链接→加粗→行内代码。
function renderInline(raw) {
  let s = escapeHtml(raw);
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_, t) => t);                 // [[X]] → X
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, label, url) => { // [text](url)
    if (!/^https?:\/\//i.test(url)) return label;                 // 非 http(s) 退化为纯文字
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");       // **x**
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");                 // `x`
  return s;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

// 分隔行：形如 |---|:--:|---| （至少含一个 -）
function isTableSep(line) {
  return !!line && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");
}

function renderTable(header, rows) {
  const th = header.map((c) => `<th>${renderInline(c)}</th>`).join("");
  const trs = rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

function isBlockStart(line, next) {
  if (/^#{1,6}\s+/.test(line)) return true;
  if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) return true;
  if (/^\s*>\s?/.test(line)) return true;
  if (/^\s*\|/.test(line) && isTableSep(next)) return true;
  return false;
}

export function renderMarkdown(md) {
  const lines = String(md == null ? "" : md).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }                    // 空行

    const h = /^(#{1,6})\s+(.*)$/.exec(line);                      // 标题
    if (h) { out.push(`<h${h[1].length}>${renderInline(h[2].trim())}</h${h[1].length}>`); i++; continue; }

    if (/^\s*\|/.test(line) && isTableSep(lines[i + 1])) {         // 表格
      const header = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      out.push(renderTable(header, rows));
      continue;
    }

    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {   // 列表
      const ordered = /^\s*\d+\.\s+/.test(line);
      const re = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*]\s+(.*)$/;
      const items = [];
      while (i < lines.length && re.test(lines[i])) { items.push(re.exec(lines[i])[1]); i++; }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((it) => `<li>${renderInline(it.trim())}</li>`).join("")}</${tag}>`);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {                                   // 引用
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      out.push(`<blockquote>${renderInline(quote.join(" ").trim())}</blockquote>`);
      continue;
    }

    const para = [];                                              // 普通段落
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i], lines[i + 1])) { para.push(lines[i]); i++; }
    out.push(`<p>${renderInline(para.join(" ").trim())}</p>`);
  }
  return out.join("\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test web/src/assets/md.test.js`
Expected: PASS（12 条全绿）。

- [ ] **Step 5: 提交**

```bash
git add web/src/assets/md.js web/src/assets/md.test.js
git commit -m "feat(web): 自包含 markdown 渲染器（factcheck 结果正文，转义+http链接白名单）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: 网页 check.js 纯函数（frontmatter / 裁定条 / 错误文案）

**Files:**
- Modify: `web/src/assets/check.js`（追加纯函数）
- Test: `web/src/assets/check.test.js`（追加）

**Interfaces:**
- Consumes: 无。
- Produces:
  - `parseFrontmatter(md: string): { frontmatter: object, body: string }`
  - `verdictTone(verdict: string): "true"|"mixed"|"false"|"unknown"`
  - `resultChips(fm: object): Array<{label: string, tone: string}>`
  - `describeResultError(status: number): string`

- [ ] **Step 1: 写失败测试（追加到 `check.test.js`）**

先把新函数加进该文件顶部的 import 块（与现有 `readKey…` 并列）：

```js
  parseFrontmatter,
  verdictTone,
  resultChips,
  describeResultError,
```

追加测试：

```js
test("parseFrontmatter：解出 frontmatter 键值与正文", () => {
  const md = "---\nverdict: 误导\nconfidence: 高\n---\n## 真相直述\n内容";
  const { frontmatter, body } = parseFrontmatter(md);
  expect(frontmatter.verdict).toBe("误导");
  expect(frontmatter.confidence).toBe("高");
  expect(body).toBe("## 真相直述\n内容");
});
test("parseFrontmatter：无 frontmatter → 原文即 body", () => {
  const { frontmatter, body } = parseFrontmatter("## 直接正文");
  expect(frontmatter).toEqual({});
  expect(body).toBe("## 直接正文");
});
test("parseFrontmatter：去掉值两侧引号", () => {
  const { frontmatter } = parseFrontmatter('---\nverdict: "属实"\n---\n正文');
  expect(frontmatter.verdict).toBe("属实");
});
test("verdictTone：六档映射到色调", () => {
  expect(verdictTone("属实")).toBe("true");
  expect(verdictTone("大体属实")).toBe("true");
  expect(verdictTone("半真")).toBe("mixed");
  expect(verdictTone("误导")).toBe("mixed");
  expect(verdictTone("不实")).toBe("false");
  expect(verdictTone("无法证实")).toBe("unknown");
  expect(verdictTone("")).toBe("unknown");
});
test("resultChips：裁定带把握度着色，可信度 / 来源数 / 输入类型中性", () => {
  const chips = resultChips({ verdict: "不实", confidence: "高", source_credibility: "中", source_count: "5", input_type: "图片" });
  expect(chips[0]).toEqual({ label: "裁定：不实（高）", tone: "false" });
  expect(chips.some((c) => c.label === "来源可信度：中" && c.tone === "neutral")).toBe(true);
  expect(chips.some((c) => c.label === "5 个来源")).toBe(true);
  expect(chips.some((c) => c.label === "图片")).toBe(true);
});
test("resultChips：缺字段则不产出对应 chip", () => {
  expect(resultChips({})).toEqual([]);
});
test("describeResultError：404 提示去 Obsidian、401 提示重输、0 提示连不上", () => {
  expect(describeResultError(404)).toContain("Obsidian");
  expect(describeResultError(401)).toContain("失效");
  expect(describeResultError(0)).toContain("连不上");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test web/src/assets/check.test.js`
Expected: FAIL —四个函数未导出。

- [ ] **Step 3: 实现（追加到 `web/src/assets/check.js` 末尾）**

```js
// 纯函数：解析笔记开头的 YAML frontmatter（--- 包裹），返回 { frontmatter, body }。
// 只解标量键值（verdict/confidence/... 都是标量）；数组类（tags/related）跳过不用。
// 无 frontmatter 时 frontmatter={}、body 为原文。
export function parseFrontmatter(md) {
  const s = String(md == null ? "" : md).replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(s);
  if (!m) return { frontmatter: {}, body: s };
  const frontmatter = {};
  for (const line of m[1].split("\n")) {
    const mm = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!mm) continue;
    let v = mm[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    frontmatter[mm[1]] = v;
  }
  return { frontmatter, body: s.slice(m[0].length) };
}

// 纯函数：六档裁定 → 裁定条着色键（true 属实系 / mixed 半真误导 / false 不实 / unknown 无法证实）。
export function verdictTone(verdict) {
  const v = String(verdict || "").trim();
  if (v === "属实" || v === "大体属实") return "true";
  if (v === "半真" || v === "误导") return "mixed";
  if (v === "不实") return "false";
  return "unknown";
}

// 纯函数：从 frontmatter 组装顶部裁定条 chip 列表。裁定按 verdictTone 着色，其余中性。
// 缺字段就不产出对应 chip（老笔记 / 字段不全也不报错）。
export function resultChips(fm) {
  const f = fm || {};
  const chips = [];
  if (f.verdict) {
    const conf = f.confidence ? `（${f.confidence}）` : "";
    chips.push({ label: `裁定：${f.verdict}${conf}`, tone: verdictTone(f.verdict) });
  }
  if (f.source_credibility) chips.push({ label: `来源可信度：${f.source_credibility}`, tone: "neutral" });
  if (f.input_type) chips.push({ label: String(f.input_type), tone: "neutral" });
  if (f.source_count) chips.push({ label: `${f.source_count} 个来源`, tone: "neutral" });
  return chips;
}

// 纯函数：详情结果加载失败 → 给用户看的一行提示（对齐 describeRecentError 的语气）。
export function describeResultError(status) {
  if (status === 401) return "密钥已失效，请点「退出」后重新输入。";
  if (status === 429) return "请求过于频繁被暂时限流，请稍后再试。";
  if (status === 404) return "结果暂不可用（可能仍在处理、回传失败或已超 7 天），可去 Obsidian 查看。";
  if (status) return `结果加载失败（HTTP ${status}），可返回列表重试。`;
  return "连不上核查服务（网络不通或被屏蔽），可返回列表重试。";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test web/src/assets/check.test.js`
Expected: PASS（新增 7 条 + 原有全绿）。

- [ ] **Step 5: 提交**

```bash
git add web/src/assets/check.js web/src/assets/check.test.js
git commit -m "feat(web): check.js 加 frontmatter 解析 / 裁定条 / 结果错误文案纯函数

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: 详情视图接线 + check.html + 样式

**Files:**
- Modify: `web/src/check.template.html`（拆 list-view / result-view 两个容器）
- Modify: `web/src/assets/check-page.js`（条目可点 → 懒拉 → 渲染 → 返回）
- Modify: `web/src/assets/feed.css`（裁定条 chip + prose 正文排版 + 可点条目）

**Interfaces:**
- Consumes: Task 4 `renderMarkdown`；Task 5 `parseFrontmatter`/`resultChips`/`describeResultError`；Task 1 `GET /check/<id>/result`。
- Produces: 无（DOM 接线 + 样式，靠预览验证）。

- [ ] **Step 1: 改 `check.template.html` — 拆容器 + 详情区**

把 `#form-area` 内现有的 form + recent + logout 段整体包进 `<div id="list-view">`，并在其后加 `#result-view`。即把当前：

```html
    <div id="form-area" hidden>
      <form id="check-form" class="submit-form">
```
…到 logout 那个 `</p>` 为止的整块，改成：

```html
    <div id="form-area" hidden>
      <div id="list-view">
        <form id="check-form" class="submit-form">
          <!-- …原 form 内容原样不动… -->
        </form>

        <!-- 最近核查：提交后在这里看状态与一行结论；done 的条目可点开看完整结果 -->
        <div class="recent">
          <!-- …原 recent 内容原样不动… -->
        </div>

        <p class="modal-hint"><button type="button" class="linklike" id="logout">退出（清除本机密钥）</button></p>
      </div>

      <!-- 结果详情：点某条 done 后同页展开完整结果（纸感阅读视图），返回即回列表 -->
      <div id="result-view" hidden>
        <p><button type="button" class="linklike" id="result-back">← 返回列表</button></p>
        <div id="result-chips" class="result-chips"></div>
        <p id="result-time" class="result-time"></p>
        <article id="result-body" class="prose"></article>
      </div>
    </div>
```

（注意：仅新增 `#list-view`、`#result-view` 两层包裹与详情区；form / recent / logout 三块内部一字不改。）

- [ ] **Step 2: 改 `check-page.js` — 导入 + 列表可点 + 详情**

顶部 import 块加入新函数（与现有 `describeTaskStatus…` 并列）并新增 md 导入：

```js
import {
  readKey, saveKey, clearKey, keyFromHash, describeCheckResult, describeSubmitError, describeRecentError,
  submitTimeoutMs, fitDimensions, validateCheckSubmission,
  describeTaskStatus, formatTaskTime, formatClockTime, shouldKeepPolling,
  parseFrontmatter, resultChips, describeResultError,
} from "./check.js";
import { renderMarkdown } from "./md.js";
```

在常量区（`RECENT_TIMEOUT_MS` 附近）加：

```js
const RESULT_TIMEOUT_MS = 15000;  // 完整结果懒加载
```

新增列表↔详情切换 + 打开结果 + 渲染（放在 `renderRecent` 之后）：

```js
// 列表视图 / 详情视图二选一（同页切换，不刷新、不重输密钥）
function showList() { $("result-view").hidden = true; $("list-view").hidden = false; }
function showResultView() { $("list-view").hidden = true; $("result-view").hidden = false; window.scrollTo(0, 0); }

// 点开某条 done：进详情视图 → 懒拉完整结果 → 渲染。失败给可见兜底文案，不白屏。
async function openResult(id) {
  $("result-chips").textContent = "";
  $("result-time").textContent = "";
  $("result-body").textContent = "加载中…";
  showResultView();
  let r;
  try {
    r = await fetch(`${WORKER}/check/${id}/result`, {
      headers: { "x-check-key": key },
      signal: timeoutSignal(RESULT_TIMEOUT_MS),
    });
  } catch {
    $("result-body").textContent = describeResultError(0);
    return;
  }
  if (r.status === 401) { // 密钥失效：统一走清密钥、退回密钥闸
    clearKey(store); key = ""; showList(); showGate();
    $("gate-msg").textContent = "密钥已失效，请重新输入。"; $("gate-msg").hidden = false;
    return;
  }
  if (!r.ok) { $("result-body").textContent = describeResultError(r.status); return; }
  let data = {};
  try { data = await r.json(); } catch {}
  renderResult(typeof (data && data.result) === "string" ? data.result : "");
}

// 渲染完整结果：frontmatter → 顶部裁定条；正文 → md.js 渲染。
// innerHTML 安全：renderMarkdown 已全程转义、链接仅放行 http(s)，且本页 CSP script-src 'self' 再兜一层。
function renderResult(md) {
  const { frontmatter, body } = parseFrontmatter(md);
  const chipsBox = $("result-chips");
  chipsBox.textContent = "";
  for (const c of resultChips(frontmatter)) {
    const el = document.createElement("span");
    el.className = "vchip";
    el.dataset.tone = c.tone;
    el.textContent = c.label;
    chipsBox.append(el);
  }
  $("result-time").textContent = frontmatter.date ? `核查日期：${frontmatter.date}` : "";
  $("result-body").innerHTML = renderMarkdown(body);
}
```

在 `renderRecent` 的循环里，给 `done` 条目加可点交互。把现有 `box.append(item);` 之前插入：

```js
    if (t.status === "done") {
      item.classList.add("clickable");
      item.setAttribute("role", "button");
      item.tabIndex = 0;
      item.addEventListener("click", () => openResult(t.id));
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openResult(t.id); }
      });
    }
```

把 `showForm` 改为进表单时先回到列表视图：

```js
function showForm() {
  $("gate").hidden = true;
  $("form-area").hidden = false;
  showList();
  loadRecent();
}
```

在文件底部事件绑定区（`$("recent-refresh")…` 附近）加返回按钮绑定：

```js
$("result-back").addEventListener("click", showList);
```

- [ ] **Step 3: 改 `feed.css` — 裁定条 + prose + 可点条目**

在文件末尾追加：

```css
/* ── 事实核查结果详情（check.html 专用）：裁定条 + 纸感正文 + 可点条目 ── */
.result-chips{display:flex; flex-wrap:wrap; gap:.5rem; margin:.2rem 0 .5rem}
.vchip{font-family:var(--sans); font-size:.78rem; padding:.2rem .62rem; border-radius:999px; border:1px solid var(--rule); color:var(--ink-soft); background:var(--card)}
.vchip[data-tone="true"]{color:#2f7d54; border-color:#2f7d54; background:rgba(47,125,84,.09)}   /* 属实系（绿，站内无绿变量，此处专用） */
.vchip[data-tone="false"]{color:var(--err); border-color:var(--err); background:rgba(179,64,44,.09)}
.vchip[data-tone="mixed"]{color:#b07d18; border-color:#b07d18; background:rgba(176,125,24,.10)}  /* 半真 / 误导（琥珀） */
.vchip[data-tone="unknown"]{color:var(--muted); border-color:var(--rule); background:var(--paper-2)}
.result-time{font-family:var(--sans); font-size:.74rem; color:var(--muted); margin:0 0 1rem}

.prose{font-family:var(--serif); color:var(--ink); line-height:1.7}
.prose h2{font-size:1.24rem; font-weight:600; margin:1.5rem 0 .55rem; padding-bottom:.28rem; border-bottom:1px solid var(--hair)}
.prose h3{font-size:1.06rem; font-weight:600; margin:1.05rem 0 .4rem}
.prose p{margin:.55rem 0}
.prose ul,.prose ol{margin:.55rem 0 .55rem 1.4rem}
.prose li{margin:.28rem 0}
.prose a{color:var(--seal); border-bottom:1px solid var(--seal-soft); text-decoration:none}
.prose a:hover{border-bottom-width:2px}
.prose strong{font-weight:600}
.prose code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.88em; background:var(--paper-2); padding:.05rem .3rem; border-radius:4px}
.prose blockquote{margin:.55rem 0; padding:.15rem 0 .15rem .9rem; border-left:3px solid var(--seal-soft); color:var(--ink-soft)}
.prose table{width:100%; border-collapse:collapse; margin:.8rem 0; font-family:var(--sans); font-size:.82rem; display:block; overflow-x:auto}
.prose th,.prose td{border:1px solid var(--rule); padding:.4rem .55rem; text-align:left; vertical-align:top}
.prose thead th{background:var(--paper-2); font-weight:600; white-space:nowrap}

.task-item.clickable{cursor:pointer; border-radius:8px; margin:0 -.5rem; padding-left:.5rem; padding-right:.5rem; transition:background .15s}
.task-item.clickable:hover{background:var(--card)}
.task-item.clickable:focus-visible{outline:2px solid var(--seal-soft); outline-offset:-2px}
```

- [ ] **Step 4: 构建站点确认无报错**

Run: `bun run build`
Expected: 构建成功、无异常抛出；`web/dist/check.html` 生成（`md.js` 随 assets 自动复制并指纹化，无需额外登记）。

- [ ] **Step 5: 预览验证渲染器在浏览器可用**

用 preview 起本地站点（launch.json 若无则建一个跑 `python3 -m http.server 8080 --directory web/dist`，或复用 `bun run serve`），打开 `check.html`：

1. `preview_console_logs` 确认加载无报错、密钥闸正常显示。
2. `preview_eval` 动态验证渲染链路（免真实 Worker）：

```js
(async () => {
  const md = await import('/assets/md.js');
  const ck = await import('/assets/check.js');
  const sample = "---\nverdict: 误导\nconfidence: 高\nsource_credibility: 中\nsource_count: 3\n---\n## 真相直述\n这是**测试**，见 [来源](https://example.com/a)。\n\n| # | 说法 | 裁定 |\n|---|---|---|\n| 1 | 甲 | ✅ 属实 |";
  const { frontmatter, body } = ck.parseFrontmatter(sample);
  document.getElementById('result-chips').innerHTML = ck.resultChips(frontmatter).map(c => `<span class="vchip" data-tone="${c.tone}">${c.label}</span>`).join('');
  document.getElementById('result-body').innerHTML = md.renderMarkdown(body);
  document.getElementById('list-view').hidden = true;
  document.getElementById('result-view').hidden = false;
  return 'ok';
})()
```

3. `preview_screenshot` 确认裁定条彩色 chip、`<h2>`、加粗、链接、表格都按纸感样式渲染；`preview_inspect .vchip[data-tone="mixed"]` 确认着色。
4. `preview_resize` mobile 视口再看一眼表格能横向滚动、不撑破页面。

修任何视觉 / 报错问题后重跑本步。

- [ ] **Step 6: 提交**

```bash
git add web/src/check.template.html web/src/assets/check-page.js web/src/assets/feed.css
git commit -m "feat(web): check.html 内建结果详情视图（点开某条 done → 纸感渲染完整结果）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: 全量测试 + 端到端联调说明

**Files:** 无（验证与收尾）

- [ ] **Step 1: 整仓测试**

Run: `bun test`
Expected: 全绿（含本次新增 worker 9 + runner 5 + factcheck-cmd 2 + md 12 + check 7 条）。

- [ ] **Step 2: 收尾**

- 用 [finishing-a-development-branch](../../../.claude) 流程决定合并方式（合并 `feat/factcheck-web-viewer` → `main`）。
- push 后：Worker 由 Mac mini launchd 自动 `wrangler deploy`（约 2 分钟内）；Pages 由 CI 自动构建部署 check.html。
- **端到端实测（需真机 + Mac mini runner 在跑，本会话无法代跑，列为交付后一步）**：手机 check.html 提交一条 → 等 runner 跑完（列表出「已完成」+ 一行结论 chip）→ 点该条 → 确认同页展开完整结果（裁定条 + 六节正文 + 表格 + 来源链接）。若点开 404，先查 check-runner 日志确认 result.md 是否写出、Worker 是否存了 `checkresult:<id>`（`wrangler kv key get --remote checkresult:<id>`）。

---

## 附：自查结果（写完对照 spec）

- **spec 覆盖**：数据流「另写 result.md」→ Task 2/3；Worker 存 `checkresult:<id>` + `GET /result` → Task 1；懒加载 + 裁定条 + md 渲染 → Task 4/5/6；边界兜底（404 / 401 / 老任务）→ Task 1 404 + Task 5 `describeResultError` + Task 6 openResult 分支；隐私 / TTL / 不污染 idx → Task 1 断言。均有对应任务。
- **无占位**：每步含实际代码 / 命令 / 期望。
- **类型一致**：`prepareCheckVerdict` 全程返回同一对象（含 `resultPath`/`readResult`）；`markCheckDone`/`handleCheckDone`/`GET /result` 的 `result` 字段命名一致；`renderMarkdown`/`parseFrontmatter`/`resultChips`/`describeResultError` 在 Task 6 的调用签名与 Task 4/5 定义一致。
