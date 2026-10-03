# searchX Check Runner（私密核查 runner）

轮询 Worker 的待核查任务，由共享 Codex 工作流按 factcheck 技能生成完整笔记、机械质检并独立核验。通过后宿主把同字节全文写入本机 Obsidian 和回传文件，再标记完成。整条流程私密，不写公开研究目录、不 push、不查重。

2026-10-03：这是可审阅的本地接线，尚未在常驻机启用或验收真实图片/手机链路。必须显式配置 `SEARCHX_CODEX_DELIVERY_ENABLED=1`；未启用、模型/档位不合要求、真实库未挂载或状态目录位于仓库内时，在取队列前退出。模型固定 `gpt-6.1-sol`，推理档位最低 `high`，不调用 Claude，不自动降级。

```
Cloudflare KV（check:* 键）
   │  GET /check/pending（x-check-runner-secret 头）
   ▼
对每条 pending 核查任务：
   ├─ POST /check/<id>/start   标记开跑（best-effort；手机页据此显示「核查中 · 已 N 分钟」）
   ├─ JSON request + inputs   原始 text/link/parentClaim 为数据，图片/前作是任务输入白名单
   ├─ runWorkflow            Codex 隔离生成 → 机械质检 → 独立只读核验
   ├─ deliverFactcheck       宿主写真实 Factcheck 笔记，再写同字节 result.md
   │     └─ 核验/完整性/交付失败 → 不 markDone，留待下轮重跑（fail 计数 +1）
   ├─ POST /check/<id>/done   标记完成（x-check-runner-secret 头）
   └─ 可选 notify             邮件（不含内容）+ Bark 推送（默认不含内容，DETAIL=1 才带标题与结论）
```

## 与 research runner 的区别

| | research runner | check-runner |
|---|---|---|
| 任务来源 | GitHub Issues（approved 标签）| Cloudflare KV（/check/pending 端点）|
| 产出 | 报告推 GitHub Pages 公开上线 | 笔记落本机 Obsidian，不上线 |
| 查重 | 有（20 天窗口，零 token）| 无 |
| 锁文件 | `searchx-runner/runner.lock` | `searchx-check-runner/check-runner.lock` |
| 日志目录 | `~/Library/Logs/searchx-runner/` | `~/Library/Logs/searchx-check-runner/` |

两个 runner 可在同一台机器上并存、各自独立运行，互不干扰。

## 文件

| 文件 | 职责 |
|---|---|
| `src/config.js` | 校验显式启用、Worker/库必填、6.1 Sol/high 以上与绝对路径；SMTP 可选 |
| `src/poll.js` | `fetchPendingChecks` / `markCheckDone`（注入 fetch，离线可测） |
| `src/factcheck-cmd.js` | `buildFactcheckPrompt({text,link,imagePaths,resultPath})` 旧 deps 接口用的 prompt（纯函数）；Codex 装配不执行或解析此 slash prompt |
| `src/result-signals.js` | `signalsFromResult(md)` 从结果文件的 frontmatter 取 `summary`（一行结论）与 `title`（列表标题），纯函数 |
| `src/result-qc.js` | `qcResult(md)` 结果文件轻量质检（必填字段 / summary 格式 / 六节 / 来源条数对账），只出问题清单进日志，纯函数 |
| `src/bark.js` | `buildBarkRequest` / `sendBark` Bark 推送（纯函数拼请求，注入 fetch 可测） |
| `src/attempts.js` | 任务级失败计数（毒任务封顶用），持久化经注入 load/save，离线可测 |
| `src/runner.js` | `runOnce(config,deps)` 编排，全部副作用经 deps 注入 |
| `src/index.js` | 装配入口：启动门禁、抢锁、共享 Codex workflow / nodemailer / fetch / 计数文件后跑 `runOnce` |
| `src/codex-delivery.js` | JSON 输入构造、核查接线、真实库/回传交付；路径白名单、软链拒绝、同任务幂等与不同字节拒绝覆盖 |

## 本地开发 / 测试

```bash
cd /private/tmp
bun test /绝对路径/searchX/services/check-runner   # 离线，不读仓库 .env、不跑模型、不联网
# 全量验证使用不含 .env 的临时源码镜像，禁止运行生产入口
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `CHECK_RUNNER_WORKER_URL` | ✅ | Worker 基址，如 `https://searchx-intake.qiuyuanqr.workers.dev`（即 intake-worker 部署地址） |
| `CHECK_RUNNER_SECRET` | ✅ | 与 Worker secret `CHECK_RUNNER_SECRET` **同值**（runner 凭它取/标任务；不一致则 `/check/pending` 静默 401，取不到任务） |
| `CHECK_RUNNER_SMTP_USER` | — | Gmail 地址（两个 SMTP 都填才启用通知邮件，缺一则 notify 关闭） |
| `CHECK_RUNNER_SMTP_PASS` | — | Gmail 应用专用密码 |
| `CHECK_RUNNER_AUTHOR_EMAIL` | — | 通知邮件收件人，默认同 `CHECK_RUNNER_SMTP_USER` |
| `SEARCHX_CODEX_DELIVERY_ENABLED` | ✅ | 必须显式设 `1` 才能取真实队列；本次离线开发未设置 |
| `SEARCHX_CODEX_MODEL` | — | 只接受 `gpt-6.1-sol`（默认） |
| `SEARCHX_CODEX_EFFORT` | — | 默认 `high`，只接受 `high` / `xhigh` / `max` / `ultra` |
| `SEARCHX_CODEX_STATE_ROOT` | — | 默认 `~/Library/Application Support/searchx-codex-jobs`；覆盖需仓外绝对路径，保存私密阶段产物与回执 |
| `SEARCHX_CODEX_BIN` | — | Codex 可执行文件，默认 `codex`；由适配器检查 |
| `CHECK_RUNNER_CLAUDE_ARGS` | — | 只保留旧配置字段兼容，不执行、不传给 Codex |
| `CHECK_RUNNER_MAX_ATTEMPTS` | — | 同一任务失败达此次数后停止重试（退休），默认 `3` |
| `CHECK_RUNNER_TIMEOUT_MINUTES` | — | 整个 Codex workflow 的绝对硬超时（含质检和核验，分钟），默认 `30`。到点先 TERM、宽限 10 秒再 KILL，按失败计入重试计数。没有它，一次挂死的 workflow 会一直持有单实例锁、让整条管道停摆 |
| `CHECK_RUNNER_BARK_URL` | — | Bark（iOS 推送）地址，形如 `https://api.day.app/<device_key>`；配了才在核查完成 / 失败时推送。默认正文只说"有一条核查完成"，不带内容 |
| `CHECK_RUNNER_BARK_DETAIL` | — | 设 `1` 才把内容标题与一行结论带进推送（内容会经 Bark 服务器与 APNs 中转，默认不带；用户原文任何模式都不进推送） |
| `CHECK_RUNNER_CHECK_PAGE_URL` | — | 核查页地址（如 `https://qiuyuanqr.github.io/check.html`），配了则点推送直达该页 |
| `CHECK_RUNNER_OBSIDIAN_VAULT` | ✅ | 真实 Obsidian 库绝对路径；必须已存在且不是软链，不允许在公开仓库。未挂载在取队列前退出，Factcheck 子目录由宿主创建 |

写到仓库根的 `.env`（已 gitignore，bun 自动加载）：

```
CHECK_RUNNER_WORKER_URL=https://searchx-intake.qiuyuanqr.workers.dev
CHECK_RUNNER_SECRET=<与 Worker CHECK_RUNNER_SECRET 同值>
CHECK_RUNNER_OBSIDIAN_VAULT=<已挂载的真实库绝对路径>
# 常驻机隔离内容验收和队列检查通过后，按明确授权启用：
# SEARCHX_CODEX_DELIVERY_ENABLED=1
# 可选（都填才发通知邮件）：
CHECK_RUNNER_SMTP_USER=<Gmail 地址>
CHECK_RUNNER_SMTP_PASS=<Gmail 应用专用密码>
```

> Worker 侧（intake-worker）须配两把 `/check` 路由密钥才能跑通：`CHECK_KEY`（作者提交核查任务）与 `CHECK_RUNNER_SECRET`（runner 取/标任务，与本机 `.env` 同值）。生成与设置见 [intake-worker README](../intake-worker/README.md) 的部署步骤；漏配则 `/check` 路由静默 401。
>
> 另：`/factcheck` 核对 A 股行情类声明时优先查本机 Stocks 活库（SKILL Step 2.6，与 `/stock` 同一套通道；Mac mini 上库在本机，只读访问方式写在该机的 `CLAUDE.local.md`），库不可用时降级为行情接口 → WebSearch 多源交叉，不阻塞。链接抓不到正文时 skill 会跑仓库内的 `scripts/fetch-article.py`（只依赖系统自带 python3 与 curl）本机直抓。

## 运行

手动一次：

```bash
bun run check-runner
```

## 结论回显 / 内容标题（手机核查页显示）

- runner 为每条任务准备**一个**信号文件 `<tmpdir>/searchx-check/<id>/result.md`，由宿主在核验通过且真实笔记已写成功后，把**整篇核查笔记（含 frontmatter，与 Obsidian 同字节）**写进去。runner 读后：
  - frontmatter `summary` → **一行结论**（`裁定（把握度）：一句话真相`），列表那条下方的结论行；
  - frontmatter `title` → **12–20 字中性内容标题**，当手机列表那条的标题，替代提交时自动生成的"N 张图 / 链接域名 / 长文本前 40 字"；
  - 整篇 → 详情视图渲染。
- 2026-09-17 之前是三个文件（`verdict.txt` / `title.txt` / `result.md`）、prompt 里三段指令；合一后 skill 只写笔记，标题与结论是笔记 frontmatter 的一部分。旧的两个文件若还被写了（老版本 skill）照旧兜底读。
- 跑完后 runner 随 `POST /check/<id>/done` 的 body `{ outcome, summary, result?, title? }` 上报；手机 check.html 的「最近核查」区凭 `CHECK_KEY` 拉 `GET /check/recent` 显示状态、标题与结论（详情另凭 `GET /check/<id>/result` 懒加载整篇）。
- **Codex 必须交付已核验完整全文，并先写真实笔记才返回成功**；宿主的 summary/title 解析继续保留旧字段降级兼容。退休任务上报 `outcome: "failed"` + 一行原因 summary（页面显示"失败 · 已停止重试"、原因行"连续失败 N 次，已停止重试，可点「再试一次」重排"和一个「再试一次」按钮）。
- **注入边界**：Codex 收到固定 workflow 指令与 JSON 数据；原始文本、链接、父任务声明始终作为待核数据，图片与 previous.md 只作为任务输入文件。旧 buildFactcheckPrompt 仅保留可注入 deps 接口，不发给模型执行。真实库根和 resultPath 不进入模型 request。
- 结论只在作者自己的私密通道流转（KV 7 天过期、凭密钥），通知邮件照旧不含内容明文。

## 补证据重查 / 一键重试（2026-09-17）

- **一键重试**：手机页对「失败」任务点「再试一次」→ Worker `POST /check/<id>/retry` 把它重排回 pending（清旧结论、`retries+1`），下一轮照常取到。为此 Worker 在 `done` 收到 `failed` 时**不再删图片**（图片仍受 7 天 TTL）。runner 侧退休时已清过 attempts 计数，重试从零计。
- **补证据重查**：手机页对已完成任务点「补充证据 · 重查」→ Worker `POST /check/<id>/recheck` 新建一条挂 `parentId` 的任务。`/check/pending` 对这类任务附上 `parentResult`（父任务整篇笔记，可能已过期为 null）与 `parentClaim`（父任务原始 text/link + `imageCount` 截图张数）；runner 把整篇写成同目录的 `previous.md`、作为 previous.md 白名单输入，父任务原文放进 JSON parentClaim，父任务截图逐张取到同目录 `prev-<n>.jpg` 作为 parent-image-* 输入（取不到即已过 7 天 TTL → JSON request 写明「已过期不可用」，不算失败）。skill 读 previous.md 当自己的前作、按新证据重查，新笔记开头写明上次裁定与本次是否变化。**为此 Worker 在 done 时不再清图片字节**（2026-09-18 起；此前跑完即清）——父任务是纯截图时，图就是它唯一的原始内容；代价是图片在作者私密 KV 里多停留到 7 天 TTL。

## 失败 / 重跑语义

- **Codex workflow、核验或宿主交付失败**：不标 done，任务留在 KV 里，下轮自动重试，同时该任务的失败计数 +1。
- **退出码 0 但结果文件没写、结论 / 标题也取不到**：判为「未产出」，按失败处理（不标 done、计数 +1、留待重跑）。模型因额度耗尽 / 拒答 / 上下文超限而「正常退出但什么也没干」时退出码同样是 0，若照常标完成，任务会永久出队、还发一封查不到东西的「结果已存进 Obsidian」通知。旧注入依赖的三个信号兼容逻辑仍保留；实际 Codex 接线必须先完整笔记交付成功，不会仅凭标题返回成功。
- **结果信号文件准备失败**（磁盘满 / 权限 / 任务 id 形态非法）：整条按失败留待重跑，连 Codex 都不跑。不能降级继续——那样上面那道「未产出」闸会被跳过，等于用一次准备失败换一封假的完成通知。
- **markDone 回传失败**：核查其实已经跑完（Obsidian 笔记已落地），结果缓存在本机 `pending-done.json`，**下轮只补回传、不重跑核查**——重跑会重复消耗额度；宿主另以 task id 防止新增重复笔记。有缓存的任务**不进退休**：补回传连败再多次也只是留到下轮（2026-09-18 修；此前退休判定排在补回传之前，连败 3 次会把一条已成功的核查标成「失败」）。
- **失败达上限（默认 3 次，可用 `CHECK_RUNNER_MAX_ATTEMPTS` 调）**：任务"退休"——不再跑模型，直接标 done 让它从 pending 消失，并发一封"核查失败、已停止重试"的通知邮件（不含核查内容明文）。这是毒任务封顶：没有它，一条永远跑不成功的任务会在 KV 7 天 TTL 内每轮完整跑一次模型。
- **失败计数存本机** `~/Library/Application Support/searchx-check-runner/attempts.json`，条目 8 天自动过期（略长于任务 KV 的 7 天 TTL）；文件丢失只是多重试几次，无碍。
- **标 done 之后**：任务从 `/check/pending` 消失，不会重复处理。
- **结果质检**：跑完读到 result.md 后过一遍 `result-qc.js`（必填字段、summary 是否可解析、六节是否齐、来源条数与 `source_count` 对账），不合格项只写进日志（`结果质检 <id>：N 项不合格 → …`），不拦截、不改判。
- **notify 失败**（SMTP 出错）：记日志、不影响 markDone 和任务计数。

## 定时无人值守（Mac mini LaunchAgent）

**组成：**
- `services/check-runner/scheduled-run.sh` —— launchd 调用的包装（补 PATH、cd 仓库根、落日志）。
- `services/check-runner/launchd/com.searchx.check-runner.plist` —— LaunchAgent 模板（`StartInterval=300` 即每 5 分钟轮询一次；轮询本身只是一次 HTTP GET，无任务即退出，单实例锁防重叠）。
- 日志：`~/Library/Logs/searchx-check-runner/check-runner.log`。

**安装（仅在常驻不关机的 Mac mini 上做）：**

```bash
chmod +x services/check-runner/scheduled-run.sh
cp services/check-runner/launchd/com.searchx.check-runner.plist ~/Library/LaunchAgents/
launchctl bootout  "gui/$(id -u)/com.searchx.check-runner" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.searchx.check-runner.plist
launchctl enable   "gui/$(id -u)/com.searchx.check-runner"
launchctl print    "gui/$(id -u)/com.searchx.check-runner" | grep -E "state|run interval"
```

手动立刻跑：

```bash
bun run check-runner:now
bun run check-runner:log   # 看最近 80 行日志
```

卸载：

```bash
launchctl bootout "gui/$(id -u)/com.searchx.check-runner"
rm ~/Library/LaunchAgents/com.searchx.check-runner.plist
```

## 隐私 / 安全

- **通知邮件不含核查内容明文**：正文只说"有一条核查已完成，请在 Obsidian 查看"，不回显核查的文本或链接。
- **共享适配器只传允许的子进程环境**：Worker、SMTP、Bark 等业务凭据不传给 Python/Codex；模型不直接写真实库或回传文件。
- **私密文件交付**：`Factcheck/<清洗后的中文标题>--<taskid>.md`；同任务既存相同全文重用，不同全文拒绝静默覆盖。结果路径只接受当前任务的 result.md；软链及路径穿越拒绝。若先写笔记后写回传失败，下轮重用该笔记后补写回传。
- **整篇笔记会经 KV 回显到手机页**（凭 CHECK_KEY，7 天 TTL）：不上公开站、不进仓库，但严格说不再是「仅存本机」——README / CLAUDE.md 的「不上线」指的是不进公开站。
- **单实例锁**：锁文件 `~/Library/Application Support/searchx-check-runner/check-runner.lock`，与 research runner 的锁路径不同，两个 runner 可以同时运行、互不影响。
