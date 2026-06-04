# searchX Runner（M2b · 一键跑研究 + 发信）

作者审批后回到 Mac，跑**一条命令** `bun run runner`：它取队列里 `approved` 且未 `done` 的 Issue → 喂给本机 Claude Code 跑 `/research`（含 Step 6 自动上线）→ 给 Issue 贴 `done` → 取提交者邮箱 → 发一封极简结果邮件（抄送作者）。

**唯一花 Claude 额度的地方 = 跑一次 `/research` 本身。** 取 Issue / 贴标签 / 发邮件 / 取邮箱全是确定性脚本、零 token。

```
GitHub Issues（M2a 入队的，作者已贴 approved）
   │  listApprovedIssues  （作者 fine-grained PAT，REST API）
   ▼
对每条 approved 未 done 的 Issue：
   ├─ parseIssueRequest        题目=标题、侧重点=正文围栏
   ├─ buildResearchPrompt      /research <题目> | <侧重点>
   ├─ runResearch              Bun.spawn claude -p …（跑研究 + Step6 push 上线）
   ├─ diffNewDirs              跑前/跑后扫 research/ 对比 → 新文件夹
   │     └─ 无新文件夹 / claude 退出码≠0 → 不贴 done，留待重跑
   ├─ addLabel "done"          幂等标记（再跑不会重复处理）
   ├─ fetchSubmitterEmail      GET Worker /sub/<n>（x-sub-secret 头）→ 真实邮箱
   ├─ composeEmail + sendEmail Gmail SMTP（应用专用密码，nodemailer）
   └─ commentIssue             ✅ 已上线并发信：<url>（失败则 ⚠️ 告警评论）
```

## 隐私 / 安全（务必理解）

- **唯一花钱动作锁在人工审批之后**：Runner 只处理带 `approved` 标签的 Issue。灌垃圾的最坏后果只是待审列表多几条。
- **邮件内容遵守隐私红线**：只含报告标题 / 已公开的一句话结论（TLDR）/ 公开链接，**绝不含任何用户私人信息**。
- **Cloudflare 凭据不下本机**：取提交者邮箱只经 Worker 的只读端点 `GET /sub/<n>`，用共享密钥头 `x-sub-secret` 鉴权——本机只持这把共享密钥，不持 CF API token。
- **机密永不入库**：GitHub PAT / 共享密钥 / Gmail 应用专用密码全部走未入库的根 `.env`（已 gitignore）或 `export`。`.env` / `.env.local` 已在 `.gitignore`。
- **PAT 最小权限**：仅 searchX 仓库、Issues 读写，与 M2a 建 Issue 的 bot 身份分离。

## 文件

| 文件 | 职责 |
|---|---|
| `src/config.js` | `loadRunnerConfig(env)` 从 `process.env` 读配置、校验必填、去空白 |
| `src/issues.js` | `listApprovedIssues` / `addLabel` / `commentIssue`（注入 fetch） |
| `src/parse-issue.js` | `parseIssueRequest({title,body})` → `{topic,focus}`（CRLF 归一） |
| `src/research-cmd.js` | `buildResearchPrompt({topic,focus})` → 拼 /research 命令 |
| `src/research-output.js` | `diffNewDirs(before,after)` 识别本次新产出文件夹 |
| `src/sub-fetch.js` | `fetchSubmitterEmail({workerUrl,secret,issueNumber})` 经 Worker 取邮箱 |
| `src/email.js` | `composeEmail(...)` + `sendEmail(msg,{transport})`（注入 transport） |
| `src/runner.js` | `runOnce(config,deps)` 编排，全部副作用经 deps 注入 |
| `src/index.js` | 一键启动薄壳：装配真实依赖（spawn claude / nodemailer / scanResearch）后跑 `runOnce` |

## 本地开发 / 测试

业务逻辑全是纯函数 + 注入依赖（`fetch`/`transport`/`scanDirs`/`runResearch`），**离线可测**（不碰真实 GitHub/Cloudflare/SMTP/claude）：

```bash
bun test                 # 根目录跑，递归含 services/runner/**/*.test.js
bun test services/runner # 只跑 Runner 的单测
```

`src/index.js` 是薄壳（spawn/网络/SMTP），按约定不单测——逻辑都在被它注入的纯函数里。

---

## 一次性运维 + 运行 Runbook（需作者本人操作）

> `{owner}=qiuyuanqr`、`{repo}=searchX`、`{author}=qiuyuanqr`。承接 M2a：Cloudflare 账号 `<你的 Gmail>`、Worker `searchx-intake.qiuyuanqr.workers.dev`、KV `INTAKE_KV`、四标签 `pending/approved/rejected/done` 已建、邮箱已存 KV `sub:<n>`。**凭据永不入库。**

### 1. 建作者 fine-grained PAT（仅 searchX、Issues 读写）
GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate：
- Resource owner = `qiuyuanqr`；Repository access = **Only select repositories → searchX**。
- Permissions → Repository → **Issues: Read and write**（其余 No access）。
- 复制 token（`github_pat_…`）→ 待写入 `.env` 的 `RUNNER_GITHUB_TOKEN`。
> 与 M2a 的 bot classic token 分离：本 token 仅本机 Runner 用，最小权限。贴 `done` 不需通知，身份无所谓。

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
设密钥 + 部署（**二选一**；wrangler 在 Claude Code 环境要清掉 agent 环境变量，否则吞输出）：

**A · wrangler**
```bash
cd services/intake-worker
env -u CLAUDECODE -u AI_AGENT -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_AGENT_SDK_VERSION bun x wrangler secret put SUB_READ_SECRET   # 粘第 2 步的密钥
env -u CLAUDECODE -u AI_AGENT -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_AGENT_SDK_VERSION bun x wrangler deploy
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
> **安全前提**：Runner 只跑**已审批**的 Issue；`/research` Step 6 本身有「精准 `git add`（绝不 `-A`）+ 隐私终检」两道闸。放行标志只为让一条命令无人值守跑通。

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
| `RUNNER_AUTHOR_EMAIL` | — | 抄送地址，默认同 `RUNNER_SMTP_USER` |
| `RUNNER_OWNER` / `RUNNER_REPO` | — | 默认 `qiuyuanqr` / `searchX` |

## 失败 / 重跑语义（幂等）

- **幂等标记 = `done` 标签**：再跑 `bun run runner` 只处理 `approved` 且未 `done` 的 Issue，已完成的跳过——不二次花费、不二次发信。
- **研究未产出**（claude 退出码≠0 或没出新文件夹）：**不贴 `done`**，计入 `失败`，留待修好后重跑。
- **发信失败**（取邮箱/SMTP 出错）：报告**已上线且已贴 `done`**，Runner 在 Issue 上留一条 `⚠️ …发信失败…请手动补发` 评论。**注意**：再跑不会重发该条邮件（它已 `done`）——按评论手动补发即可。
- **贴标签/评论本身失败**（如 PAT 过期、限频）：当次 `bun run runner` 会带可见错误中止（`main()` 已 catch → 退出码 1）。修好凭据后重跑；极少数情况下若恰好在「push 成功后、贴 done 前」中断，重跑可能对同一题目再跑一次研究（低概率、可手动删掉重复文件夹）。
- **必须在仓库根、`main`、工作区干净时跑**：薄壳会预检 `research/`+`.git`+`claude` 是否就位，缺则带中文报错退出。

## 定时无人值守（Mac mini LaunchAgent）

让 Mac mini 每 15 分钟自动跑一次 runner，你只需在手机上给 Issue 贴 `approved`，剩下全自动上线 + 发信。

**组成：**
- `services/runner/scheduled-run.sh` —— launchd 调用的包装（补 PATH、cd 仓库根、落日志）。
- `services/runner/launchd/com.searchx.runner.plist` —— LaunchAgent 模板（`StartInterval=900` 即 15 分钟）。
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
改间隔：编辑 plist 的 `StartInterval`（1800=30 分、3600=1 小时），重新 `bootout` + `bootstrap`。
卸载：`launchctl bootout "gui/$(id -u)/com.searchx.runner"` 并删 `~/Library/LaunchAgents/com.searchx.runner.plist`。

> 前提：Mac mini 保持**开机、不休眠、已登录 GUI**（claude 鉴权 / git push / 钥匙串都依赖登录态）。睡眠期间错过的 tick，launchd 会在唤醒后补跑一次（合并）。

**手动立刻跑（手机/远程触发，与定时器共用同一把锁，绝不撞车）：**
```bash
bun run runner:now    # = launchctl kickstart …：让 launchd 立即跑一次；若已在跑则自然不重复
bun run runner:log    # 看最近 80 行日志
```

## 并发 / 互斥语义（定时 + 手动如何不撞车）

三重保护，保证「定时器自动跑」与「你手机手动触发」永不并发、永不重复处理、永不丢活：

1. **runner 全局单实例锁**（`src/index.js`）：锁目录 `~/Library/Application Support/searchx-runner/runner.lock`，内含持有者 pid。任何入口启动 runner 时先抢锁，抢不到就打印 `⏭ 已有一轮在运行` 干净退出。死进程残留锁按 pid 自动回收。**这是核心防线，连直接 `bun run runner` 也受它保护。**
2. **launchd 单实例**：同名 LaunchAgent 任意时刻只跑一个实例；`runner:now` 走 `launchctl kickstart`，若任务在跑则不会再起一个。
3. **定时兜底**：跳过是无损的——一次运行处理**整个** `approved` 队列；若某条审批恰好卡在"上一轮取完列表之后"进来，下个 tick（≤15 分钟）自动补上。

> 因此**不需要真 FIFO 队列**：一次运行即清空 approved 队列，不存在"多任务排队"场景。你尽管在手机上随时 `approved` + 随时手动触发，最坏结果只是某次触发发现"已有一轮在跑"而跳过，活照样被跑完。

## 端到端验收（M2b「完成」定义）

1. 准备一条 `approved` 且邮箱在 KV 的 Issue（可复用 M2a 测试 Issue #2：给它贴 `approved`）。
2. `bun test` 全绿。
3. `bun run runner` → 报告自动上线（`https://qiuyuanqr.github.io/searchX/r/<日期>_<slug>/`，Pages 约 1–2 分钟生效）+ Issue 变 `done` + 评论链接 + 提交者收到邮件（抄作者）。
4. 再跑 `bun run runner` → `处理 0`（幂等）。
5. 驳回路径：仅 `pending`（未 `approved`）的 Issue 不被处理——0 花费。
