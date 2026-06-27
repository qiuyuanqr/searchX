# factcheck 图片上传（手机入口阶段2）设计

> 日期：2026-06-27 · 状态：已批准，待实施
> 关联：[[factcheck-能力]]（阶段1 文本/链接已上线）

## 背景与目标

`/factcheck` 私密事实核查的手机入口阶段1（文本 + 链接）已上线运营：手机 `check.html` → Worker（任务存 KV）→ Mac mini `check-runner` 每 5 分钟轮询 → `claude -p /factcheck`（bypassPermissions）→ 产出落 Obsidian `Factcheck/`。

`/factcheck` skill 本身已具备处理图片/截图的能力（见 SKILL.md「图片（截图）」一行）。**本阶段不改 skill 的核查逻辑**，只补一条缺口：**把手机上选的图片，经现有管线送到 Mac mini，变成 `/factcheck` 用 Read 能打开的本地文件路径。**

## 决策（已与用户确认）

- **多图**：一次提交 2–9 张（转发聊天/长截图常需多张）。
- **图片可单独提交**：文字改为选填。约束改为「图片 / 文字 / 链接**至少一项**」。
- **存储/传输：复用现有 `INTAKE_KV`（方案 A）**，零新基建、零新密钥/绑定。图片以二进制存 KV，runner 按需下载。R2 在此单人低频场景属过度工程，不采用。
- **隐私加固**：`done` 时 Worker 顺手删 `checkimg:<id>:*`（图片字节在云端只停留到跑完）；runner 删本机临时文件。
- **手机入口**：`accept="image/*"` 不强制 `capture`，相册/拍照都可（核查多为转发截图，相册为主）。

## 常量

- `IMG_MAX_COUNT = 9`
- `IMG_MAX_BYTES = 6 * 1024 * 1024`（单图 6 MiB）
- `IMG_MIME_ALLOW = ["image/jpeg", "image/png", "image/webp"]`
- 客户端缩放：长边 > `2000px` 才缩，JPEG 质量 `0.9`（**保字迹优先**，给模型读图留余量）
- KV TTL：`7 * 24 * 3600`（与现有任务一致）

## 数据流

```
手机 check.html
  选图 → canvas 重编码为 JPEG（归一化 HEIC / 按需缩到长边 2000px）
  FormData(text, link, images[]) ──POST /check (x-check-key)──▶ Worker
Worker
  校验(数量/大小/mime/至少一项) → 每图二进制存 checkimg:<id>:<n>（metadata.mime）
  任务存 check:<id> = {text, link, status:"pending", createdAt, images:[{mime,size}]}
Mac mini check-runner（每 5 分钟）
  GET /check/pending ─▶ 任务（含 images 元数据）
  对每条：GET /check/<id>/image/<n> 逐张下载 → 写 tmpdir/searchx-check/<id>/<n>.jpg
  buildFactcheckPrompt({text,link,imagePaths}) → claude -p /factcheck …
  成功 → POST /check/<id>/done（Worker 同时清 checkimg:<id>:*） → 删本机临时目录（finally 必删）
  失败 → 不 markDone（留待重跑）+ 删本机临时目录
```

## 改动清单

### 1. 手机端

**`web/src/check.template.html`**
- 表单加选图控件 `<input id="check-images" type="file" accept="image/*" multiple>` + 缩略图预览网格 `#img-preview` + 单张移除。
- `#check-text` 去掉 `required`；加提示「图片 / 文字 / 链接至少填一项」。
- CSP `img-src` 追加 `blob:`（缩略图用 object URL 预览）：`img-src 'self' data: blob:`。

**`web/src/assets/check.js`（纯逻辑，单测）**
- 新增 `fitDimensions(w, h, maxEdge)` → `{width,height}`：长边 ≤ maxEdge 原样，否则等比缩。
- 新增 `validateCheckSubmission({text, link, imageCount})` → `{ok, reason}`：至少一项 + text≤4000 + link≤1000 + imageCount≤9。
- 保留现有 `buildCheckPayload`/`validateCheckPayload`/`readKey`/`saveKey`/`clearKey`/`describeCheckResult`（密钥探测仍走 JSON）。

**`web/src/assets/check-page.js`（DOM/canvas 引导，不单测）**
- 选图 change：逐张 `createImageBitmap`→canvas（按 `fitDimensions` 缩放）→`toBlob('image/jpeg', 0.9)`，存入 `selected` 数组；渲染缩略图（object URL）+ 移除按钮；超 9 张拒收并提示。
- 提交：`validateCheckSubmission` 通过后构造 `FormData`（text、link、各 blob 以字段名 `images` 追加），`POST /check` 带 `x-check-key`，**不手设 content-type**（让浏览器带 multipart 边界）。成功清空文本/链接/图片。
- 401 失效退回密钥闸的现有逻辑保留。

### 2. Worker

**`services/intake-worker/src/check.js`**
- `handleCheckSubmit`：按 `content-type` 分流——
  - `multipart/form-data`：`await request.formData()`（解析失败 → 400 `bad form`）；取 `text`/`link` 字段、`form.getAll("images")` 过滤出含 `arrayBuffer()` 的 File。
  - 否则走现有 JSON 路（向后兼容，保留全部现有行为与错误码）。
  - 校验：text≤4000 / link≤1000（`too long`）；images 数量≤9（`too many`）；单图 size≤`IMG_MAX_BYTES` 且 mime∈allowlist（`bad image`）；**text/link/images 至少一项**否则 400 `empty`。
  - 存储：每图 `INTAKE_KV.put('checkimg:'+id+':'+n, arrayBuffer, {expirationTtl, metadata:{mime}})`；任务 JSON 加 `images:[{mime,size}]`（text-only 时为 `[]`）。
- 新增 `handleCheckImage(request, env, id, n)`（runner 密钥鉴权）：`getWithMetadata('checkimg:'+id+':'+n, 'arrayBuffer')`，null→404，否则回字节 + `content-type=metadata.mime`。
- `handleCheckDone`：现有标 done 后，**额外** `delete('checkimg:'+id+':'+n)`（n 遍历 `t.images`），逐个 try/catch（best-effort，删失败不影响 done 的 200）。

**`services/intake-worker/src/index.js`**
- 路由加 `GET /check/<id>/image/<n>`：正则 `^\/check\/([^/]+)\/image\/(\d+)$`，GET→`handleCheckImage`，其它方法→405；置于 done 匹配之后、通用 `/check/` 404 兜底之前。

### 3. Runner

**`services/check-runner/src/poll.js`**
- 新增 `fetchCheckImage({workerUrl, secret, id, n}, fetchImpl=fetch)` → `{bytes:Uint8Array, mime}`；非 2xx 抛错。

**`services/check-runner/src/factcheck-cmd.js`**
- `buildFactcheckPrompt({text, link, imagePaths})`：在原 text/link 基础上，若 `imagePaths` 非空则追加一段「附图为本地文件，请用 Read 逐张打开后纳入核查：\n<路径逐行>」。仅图片（无 text/link）时 prompt 为 `/factcheck 附图…`。

**`services/check-runner/src/runner.js`**
- `runOnce` 注入新 dep `prepareImages(task) → {imagePaths, cleanup}`（可选）。每条任务：先 `prepareImages`（抛错则计 fail、continue、不 markDone）；`buildPrompt({...t, imagePaths})`；用 `try/finally` 包住 `runFactcheck`→`markDone`→`notify`，**`finally` 里调 `cleanup()`**（成功/失败/markDone 失败都清临时文件）。

**`services/check-runner/src/index.js`（副作用装配，不单测）**
- 实现 `prepareImages`：无图返回空；有图则 `mkdirSync(tmpdir()/searchx-check/<id>)`，逐张 `fetchCheckImage` → `writeFileSync(<n>.<ext>)`（ext 由 mime 推：jpeg→jpg/png→png/webp→webp/默认 bin），返回 `{imagePaths, cleanup: rmSync(dir,recursive)}`。
- 图片下载在父进程完成（claude 子进程仍剥掉 `CHECK_RUNNER_*` 机密，且无需联网取图）。

### 4. SKILL

**`.claude/skills/factcheck/SKILL.md`**
- 在图片处理处加一句：无人值守（runner）模式下，图片可能以**本地文件路径**给出（而非对话附件）——按现有「图片（截图）」方法对每个路径 `Read` 后纳入核查。

## 错误处理

- Worker：multipart 解析失败→400；超数/超大/坏 mime→400；缺全部输入→400；图端点缺失→404；`done` 清图 best-effort（不影响 200）。
- Runner：某任务图片下载失败→整条按失败、留待重跑、清临时文件；`/factcheck` 非零退出→现有重跑逻辑；临时目录 `finally` 必删。
- 前端：图解码/编码失败→提示并跳过该张；网络错→现有处理。

## 测试

- **worker `check.test.js`**：multipart 提交（含图）→201 + KV 有 `checkimg:` + 任务 `images`；multipart 纯文本仍可；数量>9→400；超大图→400；坏 mime→400；全空→400；`GET image`（无 secret→401 / 有→200+字节+content-type / 缺→404）；`done` 清图；经 `index.js` 路由的 image 路径 405 兜底。需给测试 `fakeKV` 补 `getWithMetadata`/`delete`/带 `metadata` 的 `put`。
- **web `check.test.js`**：`fitDimensions`（不缩/等比缩/退化）、`validateCheckSubmission`（至少一项/各上限）。
- **runner `factcheck-cmd.test.js`**：带 imagePaths / 不带 / 仅图片三种 prompt。
- **runner `poll.test.js`**：`fetchCheckImage` 成功 + 非 2xx 抛错（注入 fetch）。
- **runner `runner.test.js`**：`runOnce` 调 `prepareImages`、把 imagePaths 传给 buildPrompt、`cleanup` 在成功**和**失败路径都被调用。

## 部署

- **无新密钥/绑定**（复用 `INTAKE_KV` / `CHECK_KEY` / `CHECK_RUNNER_SECRET`）。
- Worker 改动需**手动** `bun x wrangler deploy`（CI 不自动部署 Worker）。
- `check.html` 走 Pages CI 自动部署（push 后）。
- runner 靠 Mac mini autosync 拉新代码。

## 非目标（YAGNI）

- 不上 R2 / 不做图床。
- 不做服务端图像压缩（缩放在手机端做）。
- 不做以图搜图 / 像素级取证（skill 既有局限，照旧）。
