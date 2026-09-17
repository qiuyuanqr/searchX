# factcheck 全面优化 · 设计稿（2026-09-17）

> 起因：用户认为 factcheck 的 UI、交互、技能三块"设计得非常随意"，要求全面优化。审查结论与两个 UI 方向的 mockup 见当日会话；用户拍板：**UI 走方向 A（提交箱式）**，第二批做 **Bark 推送 + 补证据重查**，快捷指令入口先放，笔记「逐条核查」**保留表格、网页端转卡片**。

## 第一批（技能 + runner，已上线 ab75722 / e3a2774 / b4ebf49 / d06ea34）

1. 公众号链接兜底：`scripts/fetch-article.py` 本机直抓（手机 UA、只依赖系统 python3 + curl；只放行 http(s)、拒内网地址）。SKILL Step 0：WebFetch 失败 → 直抓 → 两条都败才「无法证实」。真管线实测：WebFetch 拿到验证页、直抓拿到正文。
2. Step 2.6 行情核准：akshare 优先 → Stocks 活库优先（与 /stock §2.3 同通道链）。
3. Step 2 补「状态量核到当日」「一次查空≠不存在」。
4. 解答型输入：问题类不套六档，`verdict: 解答`、来源可信度「不适用」。
5. 三个信号文件合一：`title` / `summary` 进笔记 frontmatter，runner `result-signals.js` 解析。

## 第二批（本稿正文）

### 目标

手机上"投一条 → 知道它在跑 → 出结果一眼看到真假 → 失败能一键再来 → 有新证据能接着查"，全程不用翻邮件、不用等 Obsidian。

### Worker（`services/intake-worker/src/check.js`）

| 接口 | 鉴权 | 作用 |
|---|---|---|
| `POST /check/<id>/start` | runner 密钥 | runner 取到任务即调用，记 `startedAt`（状态仍是 pending，队列语义不变；runner 崩了下一轮照常重取并覆盖 startedAt） |
| `POST /check/<id>/retry` | CHECK_KEY | 失败（退休）任务一键重试：状态回 pending、清 summary/title/startedAt、`retries+1`。pending 的任务 409。 |
| `POST /check/<id>/recheck` | CHECK_KEY | 补证据重查：与 `/check` 同样的载荷（文字 / 链接 / 图片，可全空），新建任务并挂 `parentId`。父任务须存在且已完成（否则 404 / 409）。 |
| `GET /check/pending` | runner 密钥 | 带 `parentId` 的任务附上 `parentResult`（父任务整篇笔记，可能已过期为 null）与 `parentClaim`（父任务原始 text/link）。 |
| `GET /check/recent` | CHECK_KEY | 视图新增 `startedAt` / `retries` / `parentId`。 |

- `done` 收到 `outcome: "failed"` 时**不再删图片字节**（留给重试用；图片本就 7 天 TTL）。done 成功仍即删。
- 提交与重查共用一套载荷解析 / 校验 / 落库（抽成 `createTaskFromRequest`）。

### check-runner

- 取到任务先 `markStart`（best-effort，失败只记日志）。
- 任务带 `parentResult` → 写到任务临时目录 `previous.md`，prompt 在分隔线外加一段：「本条是对上一次核查的补证据重查，上一次笔记在 `<previous.md>`（只读该路径），请先读它再结合新内容重查，笔记里写明上次裁定与本次是否变化」；父任务原始 text/link 放进分隔线内（标「上次核查的原始内容」）。
- Bark 推送（新模块 `bark.js`）：`CHECK_RUNNER_BARK_URL`（形如 `https://api.day.app/<key>`）配了才发；默认正文只说「核查完成 / 失败」，`CHECK_RUNNER_BARK_DETAIL=1` 才带内容标题与一行结论（内容会经 Bark 服务器与 APNs 中转，默认不带）；`CHECK_RUNNER_CHECK_PAGE_URL` 配了则点推送直达核查页。邮件通知照旧、两者互不影响。

### SKILL（无人值守节）

- 「补证据重查」约定：prompt 给出上次笔记路径（同临时目录白名单）→ 读它当自己的前作，按新证据重新核查；新笔记文件名按 Step 5 同名规则加序号；「真相直述」开头一句写明"本次为补证据重查，上次裁定 X，本次 Y（变 / 不变）"。
- frontmatter 加 `note`：笔记相对库根的路径（`Factcheck/<文件名>.md`），手机页据此拼 `obsidian://open` 深链。

### 手机页（`web/src/check.template.html` + `assets/check-page.js` + `assets/check.js` + 新 `assets/check.css`）

方向 A：
- **输入箱**：一个文本框贴文字或链接（识别出的 URL 显示成链接卡片，公众号域名提示"会先尝试直抓，抓不到再补截图"）；截图可粘贴、可点「图片」多选，缩略图可删；一个「提交核查」按钮；提示"通常 5–10 分钟出结果"。
- **最近核查**：每条一张卡，左侧色条与徽章按裁定着色（属实 / 大体属实 绿；半真 / 误导 琥珀；不实 红；无法证实 灰；解答 蓝；核查中 橙）。状态三段：排队中 → 核查中 · 已 N 分钟（有 `startedAt` 且 < 45 分钟）→ 完成 / 失败。失败卡带「再试一次」；无法证实卡带「补截图重查」。结论行只显示冒号后的那句话（裁定已在徽章）。
- **结果页**：裁定头卡（大字裁定 + 把握度 + 一句话真相 + 来源可信度 / 输入类型 / 来源数 / 核查时间）→ 正文；**四列以上的表格在窄屏渲染成卡片**（md.js 给 `td` 加 `data-label`，CSS 在 ≤600px 堆叠）；底部固定「在 Obsidian 打开」（设置里填库名才显示）「补充证据 · 重查」。
- **设置**（右上 ⚙）：Obsidian 库名（存 localStorage）、退出并清除密钥。
- 修掉的旧问题：输入框继承搜索框的左缩进、退出按钮套成警示条、暗色下分隔线不可见、原生文件控件。

### 不做

- iOS 快捷指令分享入口（用户决定先放）。
- 改轮询频率（runner 5 分钟 / 页面 50 秒不变；「核查中」状态已足够让人知道在跑）。

### 验证

- 单测：Worker 三个新接口 + pending 附父结果 + failed 保留图片；runner markStart / previous.md / Bark；前端纯函数（结论解析、状态文案、链接识别、Obsidian 深链）；md.js data-label。
- 真浏览器：手机宽度 + 暗色，走提交、列表各状态、结果页、重试、重查、设置。
- 真管线：手机投一条 → 看「核查中 · 已 N 分钟」→ 完成后徽章着色 → 点「补充证据 · 重查」再投一条 → 新笔记写明上次裁定。
