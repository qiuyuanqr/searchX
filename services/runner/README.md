# searchX Runner（M2b · 一键跑研究 + 发信）

Runner **只在 Mac mini 上跑**（见下文「定时无人值守」，每 5 分钟自动 tick 一次）。作者审批后无需手动做任何事；急的话可手动立刻触发一次：`bun run runner:now`（与定时器共用同一把锁，绝不重复）。**MacBook 等其它机器禁止直接 `bun run runner`**——单实例锁是本机文件锁，不跨机器互斥，若恰好撞上 Mac mini 当轮 tick 处理同一 Issue，会两边各 spawn 一次 `/research`，造成双份额度消耗、重复文件夹、`done` 标签竞态、提交者收两封邮件。它会依次：取出队列里已 `approved` 且尚未 `done` 的 Issue，交给本机 Claude Code 跑 `/research`（其中第 6 步会自动把报告发布上线），给 Issue 打上 `done` 标签，读取提交者邮箱，最后发一封简短的结果邮件（抄送作者）。

**唯一消耗 Claude 额度的就是跑一次 `/research` 本身。** 取 Issue、打标签、发邮件、取邮箱都是写死的脚本逻辑，不调用大模型、不消耗 token。

```
GitHub Issues（M2a 入队的，作者已贴 approved）
   │  listApprovedIssues  （作者 fine-grained PAT，REST API）
   ▼
对每条 approved 未 done 的 Issue：
   ├─ parseIssueRequest        题目=标题、侧重点=正文围栏
   ├─ findFreshReport          查重：同标的且 30 天内已有报告 → 不重复调研
   │     └─ 命中 → 取提交者邮箱、发「已有报告」回信（抄作者）、评论、贴 done、跳过（零额度）
   ├─ buildResearchPrompt      /research <题目> | <侧重点>（未命中查重才走到这）
   ├─ runResearch              Bun.spawn claude -p …（跑研究 + Step6 push 上线）
   ├─ diffNewDirs              跑前/跑后扫 research/ 对比 → 新文件夹
   │     └─ 无新文件夹 / claude 退出码≠0 → 不贴 done，留待重跑（同一 Issue 连续 3 次自动停跑止损）
   ├─ addLabel "done"          幂等标记（再跑不会重复处理）
   ├─ fetchSubmitterEmail      GET Worker /sub/<n>（x-sub-secret 头）→ 真实邮箱
   ├─ composeEmail + sendEmail Gmail SMTP（应用专用密码，nodemailer）
   └─ commentIssue             ✅ 已上线并发信：<url>（失败则 ⚠️ 告警评论）
```

## 隐私 / 安全（务必理解）

- **唯一花钱动作锁在人工审批之后**：Runner 只处理带 `approved` 标签的 Issue。恶意大量提交的最坏后果只是待审列表多几条。
- **邮件内容遵守隐私红线**：只含报告标题 / 已公开的一句话结论（TLDR）/ 公开链接，**绝不含任何用户私人信息**。
- **Cloudflare 凭据不下本机**：取提交者邮箱只经 Worker 的只读端点 `GET /sub/<n>`，用共享密钥头 `x-sub-secret` 鉴权——本机只持这把共享密钥，不持 CF API token。
- **机密永不入库**：GitHub PAT / 共享密钥 / Gmail 应用专用密码全部走未入库的根 `.env`（已 gitignore）或 `export`。`.env` / `.env.local` 已在 `.gitignore`。
- **PAT 最小权限**：仅 searchX 仓库、Issues 读写，与 M2a 建 Issue 的 bot 身份分离。

## 查重——已调研过的不重复做（30 天时效窗口）

每条 Issue 在 spawn `claude` **之前**先查重（`src/dedup.js` 的 `findFreshReport`，纯脚本、零 token）：扫 `research/` 已有报告，按**股票代码**或**公司全名**比对，**同一只票且报告生成日期在 30 天内**就判为重复。

- **命中**：不重复调研——取提交者邮箱，发一封「已有调研报告」回信（含报告标题 / TLDR / 公开链接，抄送作者）、在 Issue 上评论留痕、贴 `done`，跳过本条。**不 spawn claude、零额度**。
- **报告已超过 30 天**（行情、基本面大多已变动）或**查无报告**：照常跑研究。
- 窗口可调：环境变量 `RUNNER_DEDUP_WINDOW_DAYS`（默认 30）。
- 只查**股票类**（`type=股票`）报告；概念 / 人物 / 板块类不参与（它们的"再调研"通常是有意刷新）。
- 匹配偏「宁可漏拦也少误拦」：漏拦最多多跑一次研究（会正常产出文件夹，不会死循环），误拦会把别的票报告硬塞给提交者更糟，故名称匹配以精确为主。
- 回信失败（取邮箱 / SMTP 出错）：仍贴 `done` 防重判，评论提示「请手动告知提交者」。
- 同样的查重规则也写进了 `/stock` skill（`.claude/skills/stock/SKILL.md` §0.1）作为手动调用与兜底。

## 文件

| 文件 | 职责 |
|---|---|
| `src/config.js` | `loadRunnerConfig(env)` 从 `process.env` 读配置、校验必填、去空白 |
| `src/issues.js` | `listApprovedIssues` / `addLabel` / `commentIssue`（注入 fetch） |
| `src/parse-issue.js` | `parseIssueRequest({title,body})` → `{topic,focus}`（CRLF 归一） |
| `src/research-cmd.js` | `buildResearchPrompt({topic,focus})` → 拼 /research 命令 |
| `src/research-output.js` | `diffNewDirs(before,after)` 识别本次新产出文件夹 |
| `src/dedup.js` | `findFreshReport({topic,entries,today,windowDays})` 查重：同标的且窗口内已有报告则命中（纯函数） |
| `src/sub-fetch.js` | `fetchSubmitterEmail({workerUrl,secret,issueNumber})` 经 Worker 取邮箱 |
| `src/email.js` | `composeEmail(...)` + `sendEmail(msg,{transport})`（注入 transport） |
| `src/runner.js` | `runOnce(config,deps)` 编排，全部副作用经 deps 注入 |
| `src/index.js` | 一键启动的装配入口（thin wrapper）：装配真实依赖（spawn claude / nodemailer / scanResearch）后跑 `runOnce` |

## 本地开发 / 测试

业务逻辑全是纯函数 + 注入依赖（`fetch`/`transport`/`scanDirs`/`runResearch`），**离线可测**（不碰真实 GitHub/Cloudflare/SMTP/claude）：

```bash
bun test                 # 根目录跑，递归含 services/runner/**/*.test.js
bun test services/runner # 只跑 Runner 的单测
```

`src/index.js` 是只做装配的入口（spawn/网络/SMTP），按约定不单测——逻辑都在被它注入的纯函数里。

---

## 一次性运维 + 运行 Runbook（需作者本人操作）

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

### 5. 确认 headless 自动化放行标志
```bash
claude --help | grep -iE "permission|dangerous"
```
确认本机 `claude` 支持的非交互放行标志（很可能是 `--permission-mode bypassPermissions`，或 `--dangerously-skip-permissions`），据此设 `RUNNER_CLAUDE_ARGS`（默认 `--permission-mode bypassPermissions`）。
> **安全前提**：Runner 只跑**已审批**的 Issue；`/research` Step 6 本身有「精准 `git add`（绝不 `-A`）+ 推送前隐私最终检查」两道检查。放行标志只为让一条命令无人值守跑通。

### 6. 写本机 `.env`（未入库）
在仓库根创建 `.env`（已 gitignore，bun 自动加载）：
```
RUNNER_GITHUB_TOKEN=github_pat_…
RUNNER_WORKER_URL=https://searchx-intake.qiuyuanqr.workers.dev
RUNNER_SUB_SECRET=<第 2 步的密钥>
RUNNER_SMTP_USER=<你的 Gmail>
RUNNER_SMTP_PASS=<Gmail 应用专用密码>
# 可选覆盖：RUNNER_CLAUDE_ARGS / RUNNER_SITE_BASE / RUNNER_AUTHOR_EMAIL / RUNNER_OWNER / RUNNER_REPO
```
确认未被跟踪：`git status --porcelain | grep -E '\.env$'` 应无输出。

### 7. 运行
在仓库根、`main` 分支、工作区干净时：
```bash
bun run runner
```
它会逐条：spawn `claude -p "/research <题目> …"`（跑研究 + Step 6 `git push` 上线）→ 检测到新文件夹后贴 `done` + 评论链接 → 给提交者发「【调研完成】…」邮件（抄作者）。终端打印 `完成：处理 N、上线 N、发信 N、失败 N`。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `RUNNER_GITHUB_TOKEN` | ✅ | 作者 fine-grained PAT（searchX、Issues:RW） |
| `RUNNER_WORKER_URL` | ✅ | Worker 基址，如 `https://searchx-intake.qiuyuanqr.workers.dev` |
| `RUNNER_SUB_SECRET` | ✅ | 与 Worker secret `SUB_READ_SECRET` 同值 |
| `RUNNER_SMTP_USER` | ✅ | Gmail 地址 |
| `RUNNER_SMTP_PASS` | ✅ | Gmail 应用专用密码 |
| `RUNNER_CLAUDE_ARGS` | — | 传给 `claude -p` 的额外参数，默认 `--permission-mode bypassPermissions` |
| `RUNNER_SITE_BASE` | — | 站点基址，默认 `https://qiuyuanqr.github.io/searchX` |
| `RUNNER_DEDUP_WINDOW_DAYS` | — | 查重时效窗口（天），默认 `30`；空/非法/负数回退 30 |
| `RUNNER_MAX_FAILURES` | — | 失败停跑阈值：同一 Issue 连续「研究未产出」达此次数即自动贴 `done` 停跑止损，默认 `3`；空/非法/小于 1 回退 3 |
| `RUNNER_AUTHOR_EMAIL` | — | 抄送地址，默认同 `RUNNER_SMTP_USER` |
| `RUNNER_OWNER` / `RUNNER_REPO` | — | 默认 `qiuyuanqr` / `searchX` |

## 失败 / 重跑语义（幂等）

- **幂等标记 = `done` 标签**：再跑 `bun run runner` 只处理 `approved` 且未 `done` 的 Issue，已完成的跳过——不二次花费、不二次发信。
- **研究未产出**（claude 退出码≠0 或没出新文件夹）：**不贴 `done`**，计入 `失败`，留待下轮重跑；同时在本机记一次**连续失败计数**（`~/Library/Application Support/searchx-runner/research-failures.json`）。**同一 Issue 连续失败达 `RUNNER_MAX_FAILURES`（默认 3）次即自动止损**：贴 `done` 停止重跑 + Issue 评论说明 + 给作者发「已停跑」专信——没有这层止损，定时 runner 每 5 分钟会全额重跑一次 /research（每次都真实花额度），一整天可烧上百次。研究一旦成功计数即清零（只累计「连续」失败，偶发故障不算账）。**恢复方式**：人工排查修复后移除该 Issue 的 `done` 标签，下一轮自动重新排队（计数已清零，重新有完整重试预算）。若停跑时贴 `done` 失败（如 PAT 瞬断），计数保留，下一轮会**先补做停跑、绝不先重跑研究**；专信也留到止损真正落地那轮才发（防每 5 分钟一封的邮件轰炸，期间由限频报警兜底知会）。
- **发信失败**（取邮箱/SMTP 出错）：报告**已上线且已贴 `done`**，Runner 在 Issue 上留一条 `⚠️ …发信失败…请手动补发` 评论。**注意**：再跑不会重发该条邮件（它已 `done`）——按评论手动补发即可。
- **可访问性检查失败 / 未确认上线**（Pages 偶发 5xx 等导致 push 后报告页一直非 200）：报告**已上线且已贴 `done`**（贴 `done` 是为防下一轮重跑研究），但 Runner 暂缓给提交者发信（免得发出打不开的 404 链接），并留一条 `⚠️ …暂未确认上线…` 评论。同时把该条记进本机「上线待确认」队列（`~/Library/Application Support/searchx-runner/pending-publish.json`）：**后续每轮 runner 会自动重新检查，一旦确认上线就自动补发提交者邮件，无需人工**。（急的话也可在 Actions → deploy.yml → Run workflow 手动补跑部署。）
- **贴 `done` 失败**（如 PAT 过期、被限制请求频率）：研究已上线但标签没贴上——Runner 会计入 `失败`、留一条 `⚠️ …贴 done 失败…请手动补贴` 评论、并**继续处理同批后续 Issue**（不再让整轮中止）。请按评论手动补贴 `done`，否则下一轮会对它重跑一次研究（重复消耗额度 + 造重复文件夹）。
- **取 `approved` 列表本身失败**（首个 GitHub 请求就 4xx/5xx，如 PAT 失效）：本轮没做任何事就带可见错误退出（退出码 1）；修好凭据后重跑即可，无副作用。
- **必须在仓库根、`main`、工作区干净时跑**：这个装配入口会预检 `research/`+`.git`+`claude` 是否就位，缺则带中文报错退出。

## 自检报警（探活 + 失败邮件，防「坏了不吭声」）

2026-07-03 巨轮智能提交静默丢失（workers.dev 被墙内 SNI 阻断、无任何一方报警）后加的一层。三个部件：

- **墙内探活**（`src/probe-cli.js`）：`scheduled-run.sh` 每个 tick 先探一遍「站点首页 + Worker 主端点 + 备用端点」（各 10s 超时）。站点挂或主端点挂 → 给作者发报警邮件；仅备用（workers.dev）挂不报警（主链路仍通、墙内间歇阻断是已知常态），只留日志。海外视角另有 `.github/workflows/probe.yml`（每半小时，挂了 GitHub 自动发失败邮件）——两个视角缺一不可：墙内阻断只有本机测得到。
- **runner 失败报警**：`scheduled-run.sh` 里 runner 退出码非 0 → 发报警邮件。常见失败=研究未产出，会被之后的 tick 自动重跑（每次都是真实花额度的 claude 全跑）；同一 Issue 连续失败 3 次由 runner 自动贴 `done` 停跑止损并发「已停跑」专信（见「失败 / 重跑语义」）。报警让作者及时知道「在重试」，专信让作者知道「已止损、待人工排查」。
- **限频**（`src/alert.js` + `src/alert-cli.js`）：同类报警（按 key）6 小时内最多一封，防每 5 分钟一 tick 的邮件轰炸；发送成功才落限频标记（`~/Library/Application Support/searchx-runner/alert-<key>.last`），发送失败下个 tick 重试。发信只用 `RUNNER_SMTP_USER/PASS`（+可选 `RUNNER_AUTHOR_EMAIL`），特意不走 `loadRunnerConfig`——其它配置缺了不该连累报警本身。
- 手动自检一条链路：`bun services/runner/src/alert-cli.js self-test "测试"`（真发一封；6h 内重复调用会被限频拦下，属预期）。
- **新链接自检**（`src/invite-watch-cli.js` + 纯逻辑 `src/invite-selftest.js`）：每个 tick 拉 Worker `GET /people`（共享密钥，返回打码邮箱+token），对比本地「已见」（`~/Library/Application Support/searchx-runner/invites-seen.json`）；发现新增/换钥授权 → 自动验证（主端点 /verify + 站点首页 + 备用域参考）→ 邮件告知作者「✅ 可发（附可转发链接）/ ❌ 先别发」。首次运行只纳管存量不发信；通知失败下个 tick 自动重试；撤销的授权自动掉出。admin 页新增授权时页面还会当场打一次 /verify 显示即时结果（徽章即时、邮件留档，互补）。

## 定时无人值守（Mac mini LaunchAgent）

让 Mac mini 每 5 分钟自动跑一次 runner，你只需在手机上给 Issue 贴 `approved`，剩下全自动上线 + 发信。

**组成：**
- `services/runner/scheduled-run.sh` —— launchd 调用的包装（补 PATH、cd 仓库根、落日志）。
- `services/runner/launchd/com.searchx.runner.plist` —— LaunchAgent 模板（`StartInterval=300` 即 5 分钟）。
- 日志：`~/Library/Logs/searchx-runner/runner.log`（runner 输出）、`launchd.{out,err}.log`（launchd 层）。

**安装（仅在常驻不关机的 Mac mini 上做）：**
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

> 前提：Mac mini 保持**开机、不休眠、已登录 GUI**（claude 鉴权 / git push / 钥匙串都依赖登录态）。睡眠期间错过的 tick，launchd 会在唤醒后补跑一次（合并）。

**手动立刻跑（手机/远程触发，与定时器共用同一把锁，绝不冲突）：**
```bash
bun run runner:now    # = launchctl kickstart …：让 launchd 立即跑一次；若已在跑则自然不重复
bun run runner:log    # 看最近 80 行日志
```

## 并发 / 互斥语义（定时 + 手动如何不冲突）

三重保护，保证「定时器自动跑」与「你手机手动触发」永不并发、永不重复处理、永不丢活：

1. **runner 全局单实例锁**（`src/index.js`）：锁文件 `~/Library/Application Support/searchx-runner/runner.lock`，用 `O_EXCL` 原子地创建锁文件并同时写入持有者 pid（创建和标记身份是同一步完成，避免「检查与抢占之间出现竞态」即 TOCTOU 被钻空子）。任何入口启动 runner 时先抢锁，抢不到就打印 `⏭ 已有一轮在运行` 干净退出。回收保守：只回收「确证已死的 pid」或「pid 损坏且锁超 1 小时」的残留。**这是核心防线，连直接 `bun run runner` 也受它保护。**
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

## 端到端验收（M2b「完成」定义）

1. 准备一条 `approved` 且邮箱在 KV 的 Issue（可复用 M2a 测试 Issue #2：给它贴 `approved`）。
2. `bun test` 全绿。
3. `bun run runner` → 报告自动上线（`https://qiuyuanqr.github.io/searchX/r/<日期>_<slug>/`，Pages 约 1–2 分钟生效）+ Issue 变 `done` + 评论链接 + 提交者收到邮件（抄作者）。
4. 再跑 `bun run runner` → `处理 0`（幂等）。
5. 驳回路径：仅 `pending`（未 `approved`）的 Issue 不被处理——0 花费。
