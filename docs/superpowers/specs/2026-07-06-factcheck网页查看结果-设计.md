# 事实核查结果网页查看 — 设计

- 日期：2026-07-06（北京时间）
- 分支：`feat/factcheck-web-viewer`
- 相关：[[factcheck-能力]]、[[核查任务状态与结论回显]]、[[factcheck-kv-list-quota-fixed]]

## 背景与问题

事实核查（`/factcheck`）目前完整结果只落本机 Obsidian（`Factcheck/` 目录）。手机核查页 [check.html](../../../web/src/check.template.html) 的「最近核查」列表只显示状态 + 一行结论，要读完整结果得回 Obsidian。痛点：

- Obsidian 同步经常慢几分钟才有结果；
- Obsidian 软件本身在手机上交互难受。

目标：在网页里直接看完整核查结果，用 searchX 的纸感样式渲染，看结果不再经 Obsidian 同步。仅作者本人可用（沿用现有 `CHECK_KEY` 密钥门 + 免密专属链接），他人无提交、无查看权限。

## 已定选择

1. **Obsidian 继续写做本地存档**：网页只做「快速查看最近核查」，Obsidian 保留留底 / 双链 / 离线检索。网页覆盖近 7 天窗口，超期由 Obsidian 存档兜底。
2. **界面就在现有 check.html 里扩展**：一个页面、一次输密钥、不刷新、手机最顺；复用现成密钥门与「最近核查」列表。
3. **顶部裁定条**：结果最上方用纸感彩色 chip 显示 裁定 + 把握度 + 来源可信度 + 时间 + 来源数，下面才是六节正文。

## 架构与数据流

```
提交 → KV task → check-runner 轮询 → claude /factcheck
        ├─ 写 Obsidian 笔记（存档，照旧）
        ├─ 写 verdict.txt（一行结论，照旧 → 列表 chip）
        └─ 写 result.md（整篇 markdown，新增；限 temp 白名单路径）
   runner 读两份 → POST /check/<id>/done { outcome, summary, result }
        Worker: task.summary 进索引（轻）＋ result 存 checkresult:<id>（重、单独 key、7 天 TTL）
   手机列表显示 summary chip → 点某条 done → 懒加载 GET /check/<id>/result → 纸感渲染整篇
```

**关键设计点**

- 完整结果**单独存 `checkresult:<id>`**，绝不塞进轻量索引 `check:idx` / recent 视图——列表照旧只 read 索引、保持快，避免重蹈 [[factcheck-kv-list-quota-fixed]] 的额度坑。
- 完整结果**懒加载**：只有点开某条时才 `GET /check/<id>/result`，列表本身不拉全文。
- 与现有「一行结论 verdict.txt」机制**并存**：verdict.txt 继续喂列表 chip（未点开也能看结论），result.md 供详情视图渲染。两份信号文件同临时目录、cleanup 一并清。

## 组件与接口（改动清单，5 处）

### 1. factcheck SKILL.md
无人值守节新增一句：prompt 若给了「结果文件路径 `<resultPath>`」（限系统临时目录 `searchx-check/<id>/` 白名单，与 verdict.txt 同规矩），写完 Obsidian 笔记后，把**同一份完整内容（含 frontmatter）**再写一份到该路径。内容已在手，等于复制一份，无额外检索。prompt 没给路径就不写。

### 2. check-runner
- `factcheck-cmd.js`：`buildFactcheckPrompt` 加 `resultPath` 参数 → 追加「另写整篇到该路径」的指令（放在注入分隔线之外的 runner 指令区）。
- `index.js`：`prepareCheckVerdict` 扩成同时给出 `resultPath` + `readResult()`（同一临时目录，cleanup 一并清）。
- `runner.js`：`runOnce` 成功后读整篇结果，随 `markDone(id, { outcome, summary, result })` 上报。读不到 result 则降级为不带（不影响 done、summary 照常）。
- `poll.js`：`markCheckDone` 的 POST body 带上 `result`。

### 3. Worker `services/intake-worker/src/check.js`
- `handleCheckDone`：接收可选 `result`（字符串，封顶约 200KB；**超限则跳过存储、不截断**，避免坏 markdown，详情走兜底文案）。合规则存 `checkresult:<id>`（7 天 TTL），**不写进 task、不写进 idx**。存 result 的任何失败都 best-effort catch，绝不拖垮 done（隐私删图、200 回包照旧）。
- 新增 `handleCheckResult`：`GET /check/<id>/result`，`CHECK_KEY` 门 + CORS + OPTIONS 预检 + 复用 `authFailuresExceeded` 限频。回 `{ ok:true, result }`（markdown 字符串）；无则 `{ ok:false, error:"not found" }` 404。
- `index.js`（Worker 路由）：挂上 `/check/<id>/result`。

### 4. web check.html + assets
- **列表交互**：`done` 的条目变为可点（button / role）；点击 → 懒拉 `/check/<id>/result` → 进详情视图；`failed` 显示失败原因（现有 summary），`pending` 不可点。
- **详情视图**（同页，无刷新）：解析 frontmatter → 顶部裁定条（裁定 + 把握度 + 来源可信度 + 时间 + 来源数，纸感彩色 chip）→ markdown 正文渲染 → 返回按钮回列表。
- **自包含 markdown 渲染器** `assets/md.js`（纯函数、可单测）：支持这套输出用到的子集——`## 标题`、管道表格、有序 / 无序列表、行内链接 `[text](url)`、加粗 `**`、`[[双链]]` 降级为纯文本（网页无 Obsidian 图谱）。**全程先转义 HTML 防注入**；链接只放行 `http(s)`、加 `rel="noopener noreferrer"`。CSP（`script-src 'self'`）本就挡脚本执行，此为双保险。
- **frontmatter 解析** + **verdict→配色映射** 抽成 `check.js` 纯函数。
- **纸感排版**：正文 h2 / 表格 / 列表 / 链接 / 裁定条样式加进 `feed.css`（或 check.html 内联块，按现有约定）。

### 5. 测试（沿用项目 TDD 习惯，每处带测）
- Worker：`handleCheckResult` 鉴权 / 404 / CORS / 限频；`handleCheckDone` 存 result + 封顶 + 不污染 idx / task。
- runner：`buildFactcheckPrompt` 含 resultPath 指令；prepareResult 路径与读取；`runOnce` 成功时把 result 传给 markDone、读不到时降级。
- web：`md.js` 各语法渲染 + HTML 转义 + 链接协议白名单；frontmatter 解析；verdict 配色；详情视图状态切换（列表↔详情、返回）。

## 边界与兜底

- **旧任务 / 回传失败 / 超期**：详情拉不到（404 / 网络）→ 显示「结果暂不可用，可去 Obsidian 看」兜底，绝不白屏。
- **只有 `done` 可点**；`failed` 就地显示失败原因；`pending` 不可点。
- **鉴权失效**：详情 `GET /result` 若 401 → 沿用现有「清密钥、退回密钥门」路径。429 → 限流提示。
- **隐私红线**：结果按 skill 规矩不含用户私人信息；`checkresult:<id>` 同样密钥门 + 7 天 TTL，与现有 KV 隐私模型一致。
- **注入安全**：markdown 渲染全程转义；result 内容虽出自本机可信 skill，仍不假设干净（来源标题可能含异常字符）。
- **向后兼容**：老 done 任务无 result → 详情走兜底文案；不报错。

## 非目标（YAGNI）

- 不做结果的长期归档 / 检索（网页只 7 天窗口；长期靠 Obsidian）。
- 不做结果编辑、评论、分享。
- 不引入外部 markdown 库（自包含渲染器即可，CSP 友好、依赖为零）。
- 不改动 research / stock 的公开站流程（本设计只碰私密 factcheck 链路）。
