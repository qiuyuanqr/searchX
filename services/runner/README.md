# searchX Runner（M2b · 一键跑研究 + 发信）

2026-10-03：本工作区已接入共享 Codex workflow 和宿主交付，**尚未部署到生产常驻机**。交接状态中的 `runner` / `check-runner` 仍为 disabled，本次没有恢复周期执行。下面描述待切换代码行为；过去的“已上线”“每 5 分钟自动跑”不能证明新链路验收完成。

Runner 只在指定 Mac mini 上消费队列。MacBook 用于开发和离线验证，不运行 `runner`、定时包装脚本或同步钩子。启用后，它只处理 `approved` 且未 `done` 的 Issue：先查重，再由固定 `gpt-6.1-sol`（默认 `high`，最低 `high`）隔离研究和独立核验；通过后由宿主写三件套与 Obsidian、构建、精准提交推送，最后沿用原标签、页面可达检查和邮件逻辑。模型不直接提交、发布、写真实笔记或发信。

必须显式设置 `SEARCHX_CODEX_DELIVERY_ENABLED=1` 才能取真实队列。缺启用标记、模型/档位不符、执行器不可用、真实库未挂载或 Stocks 白名单查询器不完整时，启动检查直接退出。没有 Claude 或其他模型 fallback。

启动检查复用核查宿主的 `assertDeliveryConfiguration`：状态目录与笔记库必须位于公开仓库外，状态目录不能包含仓库；已有路径祖先及库根含软链会拒绝，未挂载库根不会自动创建。检查在抢锁、取队列和模型调用之前执行。

只有 workflow 返回完整已核验的 `isolated_reviewed` 或 `parked` 后，宿主交付失败才返回 `delivery_deferred`。runner 在扫描产出或读取搁置信号之前处理它：本轮计运行失败供现有运维告警，Issue 留在队列，不增加研究失败次数、不贴 `done`、不发完成通知；下一轮由适配器核对并复用已核验缓存再交付。模型执行失败仍按原连续失败预算处理。交付锁不因这条重试规则被强制回收。

交付中的本任务目录持续保留自有 `.parked` 标记，直到远端 `main` 确认包含本任务提交后才移除；精准提交只含三件套与 INDEX，标记不入 Git。这样本地已提交但尚未推送的股票报告不会被下一 tick 的查重当成已公开报告。构建仍使用不含该标记的临时镜像，推送重试复用原提交，不再构建。未发布旧测试版本若已移除标记，明确调用宿主交付重试会在核对状态归属、提交及文件字节后恢复标记；不会遍历所有状态目录做自动迁移，因此旧临时测试数据应先通过这一明确重试恢复保护，再交给队列。该执行层尚未部署，生产没有需要迁移的旧 Codex 交付状态。

```
GitHub Issues（作者已贴 approved，尚未 done）
   │  listApprovedIssues
   ▼
每条 Issue：
   ├─ parseIssueRequest       提取 topic / focus
   ├─ findFreshReport         20 天股票查重；命中沿用已有报告回信与 done
   ├─ runCodexResearch        topic / focus 作为 JSON 数据，旧 slash prompt 不执行
   │    └─ runWorkflow        分类 → 证据/写作 → 机械质检 → 独立只读核验 → 定点修订
   │                          全部阶段保存在仓外私密 stateRoot，检查点可复用
   ├─ deliverResearch         宿主校验回执与每个文件 hash、互斥锁及 main 状态
   │    ├─ 核验未通过 → 搁置信号，沿用原状态机
   │    └─ 已核验 → 三件套 + INDEX + Obsidian → 构建 → 精准 commit / push
   ├─ diffNewDirs             沿用原产物检测；执行或交付失败留待重试
   ├─ addLabel done           沿用原幂等与失败上限
   └─ 页面可达检查 / 邮件 / Issue 评论，未确认上线则入待确认队列
```

模型调用包括写作、独立核验和必要修订。队列、标签、查重、宿主交付和通知由固定脚本执行，不调用模型。

## 隐私 / 安全（务必理解）

- **唯一花钱动作锁在人工审批之后**：Runner 只处理带 `approved` 标签的 Issue。恶意大量提交的最坏后果只是待审列表多几条。
- **邮件内容遵守隐私红线**：只含报告标题 / 已公开的一句话结论（TLDR）/ 公开链接，**绝不含任何用户私人信息**。
- **Cloudflare 凭据不下本机**：取提交者邮箱只经 Worker 的只读端点 `GET /sub/<n>`，用共享密钥头 `x-sub-secret` 鉴权——本机只持这把共享密钥，不持 CF API token。
- **机密永不入库**：GitHub PAT / 共享密钥 / Gmail 应用专用密码全部走未入库的根 `.env`（已 gitignore）或 `export`。`.env` / `.env.local` 已在 `.gitignore`。
- **PAT 最小权限**：仅 searchX 仓库、Issues 读写，与 M2a 建 Issue 的 bot 身份分离。宿主 Git 发布仍使用原有 Git 鉴权，不把 Issue PAT 发给模型。
- **模型隔离**：共享适配器仅允许必要的 CLI/代理环境，剥除 GitHub、Worker、SMTP、Bark 及 API 密钥。模型只读取任务输入和白名单工具，Stocks 固定 `research` 范围、`user=none`，禁止任意 SQL 和私人表。真实库根只供宿主交付使用。
- **宿主发布**：完整性校验、真实笔记写入、构建与 Git 发布由 `codex-delivery.js` 执行；只暂存本任务报告目录和 INDEX，禁止自动提交其他会话改动。

## 查重——已调研过的不重复做（20 天时效窗口）

每条 Issue 在调用 Codex workflow **之前**先查重（`src/dedup.js` 的 `findFreshReport`，纯脚本、零 token）：扫 `research/` 已有报告，按**股票代码**或**公司全名**比对，**同一只票且报告生成日期在 20 天内**就判为重复。

- **命中**：不重复调研——取提交者邮箱，发一封「已有调研报告」回信（含报告标题 / TLDR / 公开链接，抄送作者）、在 Issue 上评论留痕、贴 `done`，跳过本条。**不调用模型、零额度**。
- **报告已超过 20 天**（行情、基本面大多已变动）或**查无报告**：照常跑研究。
- 窗口可调：环境变量 `RUNNER_DEDUP_WINDOW_DAYS`（默认 20）。
- 只查**股票类**（`type=股票`）报告；概念 / 人物 / 板块类不参与（它们的"再调研"通常是有意刷新）。
- 匹配偏「宁可漏拦也少误拦」：漏拦最多多跑一次研究（会正常产出文件夹，不会死循环），误拦会把别的票报告硬塞给提交者更糟，故名称匹配以精确为主。
- 回信失败（取邮箱 / SMTP 出错）：仍贴 `done` 防重判，评论提示「请手动告知提交者」。
- 股票技能的查重规则位于 `.agents/skills/stock/SKILL.md` §0.1；Claude 历史技能保留在 `.claude/skills/`。

## 文件

| 文件 | 职责 |
|---|---|
| `src/config.js` | `loadRunnerConfig(env)` 从 `process.env` 读配置、校验必填、去空白 |
| `src/issues.js` | `listApprovedIssues` / `addLabel` / `commentIssue`（注入 fetch） |
| `src/parse-issue.js` | `parseIssueRequest({title,body})` → `{topic,focus}`（CRLF 归一） |
| `src/research-cmd.js` | 旧 deps 接口兼容用 prompt；实际 Codex 装配不执行 slash 命令 |
| `src/research-output.js` | `diffNewDirs(before,after)` 识别本次新产出文件夹 |
| `src/dedup.js` | `findFreshReport({topic,entries,today,windowDays})` 查重：同标的且窗口内已有报告则命中（纯函数） |
| `src/sub-fetch.js` | `fetchSubmitterEmail({workerUrl,secret,issueNumber})` 经 Worker 取邮箱 |
| `src/email.js` | `composeEmail(...)` + `sendEmail(msg,{transport})`（注入 transport） |
| `src/runner.js` | `runOnce(config,deps)` 编排，全部副作用经 deps 注入 |
| `src/index.js` | 启动门禁、锁和真实依赖装配（Codex workflow / nodemailer / scanResearch）后跑 `runOnce` |
| `src/codex-research.js` | JSON 请求接共享 workflow，取得隔离产物后交给宿主；取消期间拒绝交付 |
| `src/codex-delivery.js` | 真实笔记、三件套、构建、精准 Git 发布及交付检查点恢复 |
| `../codex-runtime/adapter.js` | 私密任务状态、进程、受控环境与回执/hash校验 |

## 本地开发 / 测试

业务逻辑全是纯函数 + 注入依赖（`fetch`/`transport`/`scanDirs`/`runResearch`），**离线可测**（不碰真实 GitHub/Cloudflare/SMTP/模型或真实 vault）：

```bash
cd /private/tmp
bun test /绝对路径/searchX/services/runner # 从仓外启动，不自动加载仓库 .env
# 全量离线验收使用不含 .env 的临时源码镜像；禁止运行生产装配入口
```

`src/index.js` 包含真实队列、发布和 SMTP 副作用，不能通过直接运行入口验收离线代码；使用可注入依赖测试正常及失败路径。

---

## 历史初始化 Runbook（账号与 Worker 配置参考）

下面 1–4 步来自原 M2b 初始化，保留作历史参考，不表示需要重新配置凭据或重新部署 Worker。账号、密钥、部署和服务变更必须按当前会话授权执行。步骤 5–7 已改为此次 Codex 切换说明，尚未执行。

> `{owner}=qiuyuanqr`、`{repo}=searchX`、`{author}=qiuyuanqr`。承接 M2a：Cloudflare 账号 `<你的 Gmail>`、Worker `searchx-intake.qiuyuanqr.workers.dev`、KV `INTAKE_KV`、四个标签 `pending/approved/rejected/done` 已建好、提交者邮箱已存入 KV 的 `sub:<n>` 键。**凭据永不入库。**

### 1. 建作者 fine-grained PAT（仅 searchX、Issues 读写）
GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate：
- Resource owner = `qiuyuanqr`；Repository access = **Only select repositories → searchX**。
- Permissions → Repository → **Issues: Read and write**（其余 No access）。
- 复制 token（`github_pat_…`）→ 待写入 `.env` 的 `RUNNER_GITHUB_TOKEN`。
> 与 M2a 那个 bot 用的 classic token 分开：本 token 只供本机 Runner 使用，权限最小化。因为打 `done` 标签不会触发任何通知，所以用哪个账号身份都无所谓。

### 2. 生成 `/sub` 端点共享密钥
```bash
openssl rand -hex 24
```
记下输出——同时用于 Worker secret `SUB_READ_SECRET` 与本机 `RUNNER_SUB_SECRET`。

### 3. 给 Worker 设 `SUB_READ_SECRET` 并部署带 `/sub` 路由的新版本
本分支已给 M2a Worker 加了 `GET /sub/<n>` 路由（`src/sub-read.js` + `src/index.js`）。先重打包再部署：
```bash
bun run build:worker     # 产出含新路由的 services/intake-worker/dist/worker.js
```
设密钥 + 部署（**二选一**）：

**A · wrangler**
```bash
cd services/intake-worker
bun x wrangler secret put SUB_READ_SECRET   # 粘第 2 步的密钥
bun x wrangler deploy
```
**B · dashboard**：Workers & Pages → `searchx-intake` → 编辑器粘贴新的 `dist/worker.js` → Settings → Variables and Secrets：加 Secret `SUB_READ_SECRET`（值=第 2 步）→ Deploy。

验证端点（用真实存在的 issue 号，如 M2a 测试 Issue #2，其邮箱在 KV `sub:2`）：
```bash
curl -s -H "x-sub-secret: <密钥>" https://searchx-intake.qiuyuanqr.workers.dev/sub/2          # → {"ok":true,"email":"…"}
curl -s -o /dev/null -w "%{http_code}\n" https://searchx-intake.qiuyuanqr.workers.dev/sub/2    # 不带头 → 401
```

### 4. 建 Gmail 应用专用密码
Google 账号 `<你的 Gmail>` → Security → 确保**两步验证已开** → **App passwords** → 生成（应用选「邮件」）。
- 记下 16 位密码 → `.env` 的 `RUNNER_SMTP_PASS`；`RUNNER_SMTP_USER` = `<你的 Gmail>`。

### 5. 切换前检查 Codex 与路径

固定 `gpt-6.1-sol`，默认 `SEARCHX_CODEX_EFFORT=high`；只允许 `high` / `xhigh` / `max` / `ultra`。任何其他模型、低档或未知档都拒绝启动，不降级、不回退 API。必须在指定常驻机完成真实隔离能力与内容验收，不能只检查 CLI 登录状态。

配置真实已挂载 `RUNNER_OBSIDIAN_VAULT`、仓外 `SEARCHX_CODEX_STATE_ROOT` 和完整 `SEARCHX_STOCKS_ROOT`。Stocks 查询器应包含 `venv/bin/python` 与 `scripts/query_for_agent.py`，后台只用白名单共享数据。核对原 Claude 服务仍停止、生产 main/upstream/远端一致、无并行脏改动，以及待处理 Issue 数和失败缓存后，才按明确授权启用单条测试任务。

历史 `RUNNER_CLAUDE_ARGS` 和代码字段 `claudeTimeoutMs` 只保留旧接口兼容；前者不执行、不传给 Codex，后者实际控制 Codex workflow 超时。旧 Claude 权限放行操作已从当前运行步骤移除。

### 6. 写本机 `.env`（未入库）
在仓库根创建 `.env`（已 gitignore，bun 自动加载）：
```
RUNNER_GITHUB_TOKEN=github_pat_…
RUNNER_WORKER_URL=https://searchx-intake.qiuyuanqr.workers.dev
RUNNER_SUB_SECRET=<第 2 步的密钥>
RUNNER_SMTP_USER=<你的 Gmail>
RUNNER_SMTP_PASS=<Gmail 应用专用密码>
# 宿主必填，库根须真实存在：
RUNNER_OBSIDIAN_VAULT=<已挂载的Obsidian库绝对路径>
# 下面三项可覆盖默认值，均为非凭据配置：
# SEARCHX_CODEX_MODEL=gpt-6.1-sol
# SEARCHX_CODEX_EFFORT=high
# SEARCHX_CODEX_STATE_ROOT=<仓外私密状态目录绝对路径>
# SEARCHX_STOCKS_ROOT=<Stocks项目绝对路径>
# 完成常驻机验收和队列检查后，按授权显式开启：
# SEARCHX_CODEX_DELIVERY_ENABLED=1
# 其它可选：RUNNER_SITE_BASE / RUNNER_AUTHOR_EMAIL / RUNNER_OWNER / RUNNER_REPO
```
确认未被跟踪：`git status --porcelain | grep -E '\.env$'` 应无输出。

### 7. 单条生产验收后再恢复周期运行

本次没有运行此步骤。指定 Mac mini 的实际生产 `main` 工作区必须配置 upstream `origin/main`、无未交付的其他改动，且本地和远端历史一致。宿主交付会取得 stocks-import 和 Git 同步互斥锁；远端 main 变化时拒绝自动合并覆盖。

获得单条真实任务运行与发布/通知授权后，才使用下方入口；**不要在开发 MacBook 上运行**：

```bash
bun run runner
```

Codex 输出隔离产物，宿主核验回执/hash、写 `Research/` 笔记和本任务三件套/INDEX、构建、精准提交推送，并确认远端 SHA。原状态机随后处理 `done`、公开页面可达性和结果邮件。运行退出 0 或服务 loaded 都不能代替报告内容、公开页及邮件验收；确认后才另行恢复周期执行。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `RUNNER_GITHUB_TOKEN` | ✅ | 作者 fine-grained PAT（searchX、Issues:RW） |
| `RUNNER_WORKER_URL` | ✅ | Worker 基址，如 `https://searchx-intake.qiuyuanqr.workers.dev` |
| `RUNNER_SUB_SECRET` | ✅ | 与 Worker secret `SUB_READ_SECRET` 同值 |
| `RUNNER_SMTP_USER` | ✅ | Gmail 地址 |
| `RUNNER_SMTP_PASS` | ✅ | Gmail 应用专用密码 |
| `RUNNER_OBSIDIAN_VAULT` | ✅ | 已挂载的真实 Obsidian 库绝对路径；宿主写 `Research/`，模型不直接写入 |
| `SEARCHX_CODEX_DELIVERY_ENABLED` | ✅ | 必须显式 `1` 才能取队列和宿主交付；本次未在生产启用 |
| `SEARCHX_CODEX_MODEL` | — | 只接受 `gpt-6.1-sol`，默认同值 |
| `SEARCHX_CODEX_EFFORT` | — | 默认 `high`，允许 `high` / `xhigh` / `max` / `ultra` |
| `SEARCHX_CODEX_STATE_ROOT` | — | 默认 `~/Library/Application Support/searchx-codex-jobs`；必须仓外绝对路径，保存私密请求、阶段、产物、回执和交付检查点 |
| `SEARCHX_STOCKS_ROOT` | — | 默认 `~/Coding/Stocks`；必须完整 Stocks 项目绝对路径，仅白名单只读共享数据 |
| `SEARCHX_CODEX_BIN` / `SEARCHX_PYTHON_BIN` / `SEARCHX_BUN_BIN` | — | 执行器路径，默认 `codex` / `python3` / `bun`；适配器校验，不传旧 Claude flags |
| `RUNNER_CLAUDE_ARGS` | — | 仅保留旧配置兼容，不执行、不生效 |
| `RUNNER_SITE_BASE` | — | 站点基址，默认 `https://qiuyuanqr.github.io/searchX` |
| `RUNNER_DEDUP_WINDOW_DAYS` | — | 查重时效窗口（天），默认 `20`；空/非法/负数回退 20 |
| `RUNNER_MAX_FAILURES` | — | 失败停跑阈值：同一 Issue 连续「研究未产出」达此次数即自动贴 `done` 停跑止损，默认 `3`；空/非法/小于 1 回退 3 |
| `RUNNER_TIMEOUT_MINUTES` | — | 整个 Codex workflow（写作、质检、独立核验和修订）的绝对硬超时（分钟），默认 `180`。到点先 TERM、宽限 10 秒再 KILL，按「研究未产出」计入失败退避。也是单实例锁「存活但超龄」判定的基数（超龄上限＝本值 + 30 分钟） |
| `RUNNER_AUTHOR_EMAIL` | — | 抄送地址，默认同 `RUNNER_SMTP_USER` |
| `RUNNER_OWNER` / `RUNNER_REPO` | — | 默认 `qiuyuanqr` / `searchX` |

## 检查点与失败 / 重跑语义

`stateRoot/jobs/<identity-hash>/` 保留任务级请求、白名单输入、阶段输出、机械质检与独立核验回执。请求、输入及模型/档位等身份相同的重试，适配器先校验保存的回执、实际文件 hash 和执行审计；已成功阶段或完整已核验产物可复用，失败不能凭残留状态字符串报成功。身份或证据变化不能当旧检查点重用。

宿主另在该任务目录保存 `delivery-state.json`，记录本任务归档、INDEX 前后内容与 commit/push 状态。构建或 push 失败后从已核验产物和交付状态继续，不重新研究；复用前校验任务所有权、文件字节和 main/远端历史。遇其他会话改动、异内容覆盖或远端历史变化时退出，保留成果待处理。宿主发布本身另有 10 分钟总时限。

- **幂等标记 = `done` 标签**：再跑 `bun run runner` 只处理 `approved` 且未 `done` 的 Issue，已完成的跳过——不二次花费、不二次发信。
- **模型或核验未完成**（工作流失败、未通过核验，或返回值无法确认可交付状态）：**不贴 `done`**，计入运维 `失败`，留待下轮重跑；同时在本机记一次**连续研究失败计数**（`~/Library/Application Support/searchx-runner/research-failures.json`）。**同一 Issue 连续研究失败达 `RUNNER_MAX_FAILURES`（默认 3）次即自动止损**：贴 `done` 停止重跑 + Issue 评论说明 + 给作者发「已停跑」专信——无可复用检查点的阶段仍会消耗额度，因此需要限制反复模型尝试。研究一旦成功计数即清零（只累计「连续」失败，偶发故障不算账）。**恢复方式**：人工排查修复后移除该 Issue 的 `done` 标签，下一轮自动重新排队（计数已清零，重新有完整重试预算）。若停跑时贴 `done` 失败（如 PAT 瞬断），计数保留，下一轮会**先补做停跑、绝不先重跑研究**；专信也留到止损真正落地那轮才发（防每 5 分钟一封的邮件轰炸，期间由限频报警兜底知会）。
- **已核验后的宿主交付暂缓**：工作流已返回 `isolated_reviewed` 或 `parked`，随后锁、写库、构建或推送失败时，宿主返回结构化 `delivery_deferred`。Runner 在扫描产物或处理 parked 状态前消费此结果，保留队列与现有研究失败计数，**不递增研究失败计数、不贴 `done`、不发完成通知**；下一轮复用已核验缓存继续交付。此类故障仍计入当轮运维 `失败` 并令运行失败，以便现有告警发现阻塞。
- **发信失败**（取邮箱/SMTP 出错）：报告**已上线且已贴 `done`**，Runner 在 Issue 上留一条 `⚠️ …发信失败…请手动补发` 评论。**注意**：再跑不会重发该条邮件（它已 `done`）——按评论手动补发即可。
- **可访问性检查失败 / 未确认上线**（Pages 偶发 5xx 等导致 push 后报告页一直非 200）：报告**已上线且已贴 `done`**（贴 `done` 是为防下一轮重跑研究），但 Runner 暂缓给提交者发信（免得发出打不开的 404 链接），并留一条 `⚠️ …暂未确认上线…` 评论。同时把该条记进本机「上线待确认」队列（`~/Library/Application Support/searchx-runner/pending-publish.json`）：**后续每轮 runner 会自动重新检查，一旦确认上线就自动补发提交者邮件，无需人工**。（急的话也可在 Actions → deploy.yml → Run workflow 手动补跑部署。）计入 `上线待确认` 而**不计 `失败`、退出码仍为 0**：研究本身已成功，部署慢或等 deploy-retry 自动补跑是常态，此时发「runner 失败」报警是误报（2026-07-09 实测）；队列超龄（见下）才计失败并专信告警。
- **贴 `done` 失败**（如 PAT 过期、被限制请求频率）：研究已上线但标签没贴上——Runner 会计入 `失败`、留一条 `⚠️ …贴 done 失败…请手动补贴` 评论、并**继续处理同批后续 Issue**（不再让整轮中止）。请按评论手动补贴 `done`，否则下一轮会重新处理该 Issue；匹配的已核验工作流/交付检查点可复用，仍需补齐标签或由查重路径收尾。
- **取 `approved` 列表本身失败**（首个 GitHub 请求就 4xx/5xx，如 PAT 失效）：本轮没做任何事就带可见错误退出（退出码 1）；修好凭据后重跑即可，无副作用。
- **必须在仓库根、`main`、工作区干净时跑**：这个装配入口预检仓库、显式启用、模型档位、Codex/Python、真实库与 Stocks 查询器；宿主交付另校验实际 main/upstream、路径与任务所有权。

## 自检报警（探活 + 失败邮件，防「坏了不吭声」）

2026-07-03 巨轮智能提交静默丢失（workers.dev 被墙内 SNI 阻断、无任何一方报警）后加的一层。三个部件：

- **墙内探活**（`src/probe-cli.js`）：`scheduled-run.sh` 每个 tick 先探一遍「站点首页 + Worker 主端点 + 备用端点」（各 10s 超时）。站点挂或主端点挂且**连续满 4 个 tick（约 20 分钟，计数落盘 `probe-streaks.json`）** → 给作者发报警邮件——墙内到 Cloudflare/GitHub 的分钟级瞬时抖动是常态（2026-07-06~09 实测一周十余次、断 1~3 tick 即自愈），单次失败只留日志不报警；仅备用（workers.dev）挂不报警（主链路仍通、墙内间歇阻断是已知常态），只留日志。海外视角另有 `.github/workflows/probe.yml`（每半小时，挂了 GitHub 自动发失败邮件）——两个视角缺一不可：墙内阻断只有本机测得到。
- **探活历史**（`src/probe.js` + `scripts/probe-stats.js`）：每个 tick 顺带把三个目标的结果记一行到 `probe-log.jsonl`（滚动保留最近 5000 行 ≈ 17 天），失败带类型——`timeout` / `tls` / `reset` / `refused` / `dns`，认不出的原样保留运行时给的 code。**只记录、不参与报警判定**（报警仍走上面那套连续失败计数）。看统计：`bun run probe:stats`（历史在跑 runner 那台机器上，本机是空的：`ssh mac-mini 'cd ~/Coding/searchX && bun run probe:stats'`）。
  为什么要分类型：2026-08-31 排查「站点时快时慢」时实测，墙内对 `qiuyuanqr.github.io` 的干扰有两种表现——TCP 连不上（等满超时）与 TLS 握手被重置（几秒即断，SNI 阻断的典型特征），而只记布尔值时它们和「站点真挂了」长得一模一样。**已知弱点**：Bun 把「DNS 解析失败」和「端口拒绝」都报成同一个 code，所以 `refused` 实际是两者的合并类，真要查 DNS 污染得另外用 dig 验。
- **runner 失败报警**：`scheduled-run.sh` 里 runner 退出码非 0 → 发报警邮件。常见失败=研究未产出，会被之后的 tick 自动重跑（未成功且无法复用的模型阶段仍消耗额度）；同一 Issue 连续失败 3 次由 runner 自动贴 `done` 停跑止损并发「已停跑」专信（见「失败 / 重跑语义」）。报警让作者及时知道「在重试」，专信让作者知道「已止损、待人工排查」。
- **报警内容**（`classifyFailure` in `src/alert.js`）：失败类报警（`runner-failed` / `check-runner-failed` / `stocks-import-failed`）由 `scheduled-run.sh` 把**本轮日志**（最后一条 `──────── tick：` 之后的部分）经管道喂给 `alert-cli.js --log-stdin`，邮件正文按【错误类型】【发生在】【关键错误】【怎么处理】【现场日志】【完整日志】分栏，**类型同时进主题**（手机推送只看得见主题）。类型按 `FAILURE_PATTERNS` 从具体到笼统匹配——顺序是关键：`研究未产出` 这种笼统症状必须垫底，否则会盖住写在同一段日志里的真因（2026-08-24 实例：历史真因是 Claude 登录过期，邮件却只报「连续 3 次研究未产出」）。认不出类型时退回「未知错误」+ 日志末尾，**信息不会比只报退出码的旧版更少**。日志片段经 `redactSecrets` 打码后才出网。加这层的由来：2026-08-26 GitHub PAT 被重新生成，邮件全文只有「定时 runner 退出码 1」，真因只躺在 Mac mini 的日志里，白挂了 10 小时 44 分。
- **限频**（`src/alert.js` + `src/alert-cli.js`）：同类报警（按 key）6 小时内最多一封，防每 5 分钟一 tick 的邮件轰炸；发送成功才落限频标记（`~/Library/Application Support/searchx-runner/alert-<key>.last`），发送失败下个 tick 重试。发信只用 `RUNNER_SMTP_USER/PASS`（+可选 `RUNNER_AUTHOR_EMAIL`），特意不走 `loadRunnerConfig`——其它配置缺了不该连累报警本身。
- 手动自检一条链路：`bun services/runner/src/alert-cli.js self-test "测试"`（真发一封；6h 内重复调用会被限频拦下，属预期）。
- **新链接自检**（`src/invite-watch-cli.js` + 纯逻辑 `src/invite-selftest.js`）：每个 tick 拉 Worker `GET /people`（共享密钥，返回打码邮箱+token），对比本地「已见」（`~/Library/Application Support/searchx-runner/invites-seen.json`）；发现新增/换钥授权 → 自动验证（主端点 /verify + 站点首页 + 备用域参考）→ 邮件告知作者「✅ 可发（附可转发链接）/ ❌ 先别发」。首次运行只纳管存量不发信；通知失败下个 tick 自动重试；撤销的授权自动掉出。admin 页新增授权时页面还会当场打一次 /verify 显示即时结果（徽章即时、邮件留档，互补）。

## 定时无人值守（Mac mini LaunchAgent）

以下是恢复周期执行后的行为与旧 LaunchAgent 操作参考；**当前迁移尚未部署，原服务仍 disabled，不能按本文直接恢复**。单条真实内容、发布和通知链路验收完成并得到启停授权后，Mac mini 才每 5 分钟轮询 approved 队列。

**组成：**
- `services/runner/scheduled-run.sh` —— launchd 调用的包装（补 PATH、cd 仓库根、落日志）。
- `services/runner/launchd/com.searchx.runner.plist` —— LaunchAgent 模板（`StartInterval=300` 即 5 分钟）。
- 日志：`~/Library/Logs/searchx-runner/runner.log`（runner 输出）、`launchd.{out,err}.log`（launchd 层）。

**安装/恢复参考（只在指定 Mac mini，另需当前启停授权）：**
```bash
chmod +x services/runner/scheduled-run.sh
cp services/runner/launchd/com.searchx.runner.plist ~/Library/LaunchAgents/
launchctl bootout  "gui/$(id -u)/com.searchx.runner" 2>/dev/null   # 幂等：先卸旧
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.searchx.runner.plist
launchctl enable   "gui/$(id -u)/com.searchx.runner"
launchctl print    "gui/$(id -u)/com.searchx.runner" | grep -E "state|run interval"   # 确认
```
改间隔：编辑 plist 的 `StartInterval`（900=15 分、1800=30 分、3600=1 小时），重新 `bootout` + `bootstrap`。
卸载：`launchctl bootout "gui/$(id -u)/com.searchx.runner"` 并删 `~/Library/LaunchAgents/com.searchx.runner.plist`。

> 前提：Mac mini 保持**开机、不休眠、已登录 GUI**（ChatGPT CLI 鉴权 / git push / 钥匙串依赖登录态）。睡眠期间错过的 tick，launchd 会在唤醒后补跑一次（合并）。

**手动立刻跑（手机/远程触发，与定时器共用同一把锁，绝不冲突）：**
```bash
bun run runner:now    # = launchctl kickstart …：让 launchd 立即跑一次；若已在跑则自然不重复
bun run runner:log    # 看最近 80 行日志
```

## 并发 / 互斥语义（定时 + 手动如何不冲突）

三重保护，保证「定时器自动跑」与「你手机手动触发」永不并发、永不重复处理、永不丢活：

1. **runner 全局单实例锁**（`src/index.js`）：锁文件 `~/Library/Application Support/searchx-runner/runner.lock`，用 `O_EXCL` 原子地创建锁文件并同时写入持有者 pid（创建和标记身份是同一步完成，避免「检查与抢占之间出现竞态」即 TOCTOU 被钻空子）。任何入口启动 runner 时先抢锁，抢不到就打印 `⏭ 已有一轮在运行` 干净退出。回收分四种情形：①确证已死的 pid（超 1 分钟即回收，不必等满一小时）；②pid 损坏且锁超 1 小时；③持有者仍判活、但锁龄超过「Codex workflow 超时 + 30 分钟」——防 pid 被 OS 复用造成的假活；④**绝对封顶**：持有超过 8 小时一律回收，与定期更新无关。**这是核心防线，连直接 `bun run runner` 也受它保护。**

锁文件写两行：第一行 pid，第二行建锁时刻。批次期间有**定期更新锁时间戳**每 60 秒刷新锁文件 mtime——一轮会串行跑完整个队列，没有定期更新锁时间戳的话「锁龄」会把合法长批次误判成残锁被下一 tick 抢走。但定期更新锁时间戳也意味着「进程活着却卡死」时锁龄永远刷新不上去，所以才需要上面第 ④ 条按建锁时刻算的绝对封顶。释放锁前会核对锁里的 pid 仍是自己，避免删掉接管者的锁。

「跳过」本身也被监控：连续 36 个 tick（约 3 小时）都因抢不到锁而跳过时，runner 以非零码退出触发报警——否则「持有者卡死」造成的永久停摆会因为跳过是 `exit 0` 而完全静默。
2. **launchd 单实例**：同名 LaunchAgent 任意时刻只跑一个实例；`runner:now` 走 `launchctl kickstart`，若任务在跑则不会再起一个。
3. **定时器保底**：即使某次触发被跳过也不会丢活——每次运行都会处理**整个** `approved` 队列；万一某条审批恰好在「上一轮取完列表之后」才进来，下一次定时触发（≤5 分钟）会自动补处理。

> 因此**不需要真 FIFO 队列**：一次运行即清空 approved 队列，不存在"多任务排队"场景。你可以随时在手机上给 Issue 贴 `approved`、随时手动触发，最坏情况也只是某次触发发现「已有一轮在跑」而自动跳过，待处理的任务照样会被跑完。

## 作者汇总邮件（每完成一篇，单独通知作者）

除了给**提交者**发「【调研完成】…」结果邮件（抄送作者）外，每成功完成一篇还会**单独再给作者发一封汇总邮件**（`composeAuthorDigest`，`src/email.js`）：
- 主题：`【searchX 已完成·今日第 N 篇】<报告名>`；
- 正文：完成了什么（主题 / 报告名 / 公开链接）+ **今日（北京时间）累计完成 N 篇**。
- 收件人 = `RUNNER_AUTHOR_EMAIL`（缺省同 `RUNNER_SMTP_USER`），无 cc；**只含公开信息，绝不含提交者邮箱等私人信息**。
- **独立、尽力而为**：与提交者邮件互不影响，作者汇总发送失败只记日志、不影响任务本身（不回滚 done、不拦后续）。

**今日计数**：按北京时间分日存计数文件 `~/Library/Application Support/searchx-runner/daily-<YYYY-MM-DD>.count`，每成功一篇 +1，纯本地、零额外 API（`bumpDailyCount`，`src/index.js`）。跨自然日自动归零（新日期=新文件）。

## 端到端验收（本次尚待生产执行）

1. 开发机完成不含 `.env` 的离线依赖注入验证；失败、超时、搁置、交付冲突、检查点恢复均不得误报完成。
2. 指定常驻机核实 6.1 Sol/high 实际回合、联网原文、Stocks 白名单只读、图片读取及进程回收，再验一篇股票和一篇非股票研究。先审查隔离产物、独立核验与 Obsidian 转换一致性。
3. 核对待处理量、失败缓存、旧服务停用及实际部署 SHA；获得单条真实队列、发布和通知授权后验完整链路：宿主精准推送、报告页可达、Issue done/评论、提交者邮件。
4. 验证同任务重试复用检查点；模拟交付或回传失败时不会重新花额度研究，也不会误提交其他改动。仅 pending 的 Issue 不处理。
5. 完成单条验收后才按启停授权恢复周期执行，再观察首个自然任务。后台退出 0、loaded 或历史“已上线”均不是本次迁移完成证据。
