# searchX Check Runner（私密核查 runner）

轮询 Worker 里的待核查任务，交给本机 Claude Code 跑 `/factcheck`，结果落本机 Obsidian，最后标记该任务完成。整条流程私密——不上线、不写仓库、不 push、不查重。

```
Cloudflare KV（check:* 键）
   │  GET /check/pending（x-check-runner-secret 头）
   ▼
对每条 pending 核查任务：
   ├─ buildFactcheckPrompt     拼 /factcheck 命令（text + link）
   ├─ Bun.spawn claude -p …   跑核查，结果落本机 Obsidian（/factcheck skill 负责写文件）
   │     └─ 退出码≠0 → 不 markDone，留待下轮重跑（fail 计数 +1）
   ├─ POST /check/<id>/done   标记完成（x-check-runner-secret 头）
   └─ 可选 notify             发邮件提示"去 Obsidian 查看"（绝不含核查内容细节）
```

## 与 research runner 的区别

| | research runner | check-runner |
|---|---|---|
| 任务来源 | GitHub Issues（approved 标签）| Cloudflare KV（/check/pending 端点）|
| 产出 | 报告推 GitHub Pages 公开上线 | 笔记落本机 Obsidian，不上线 |
| 查重 | 有（30 天窗口，零 token）| 无 |
| 锁文件 | `searchx-runner/runner.lock` | `searchx-check-runner/check-runner.lock` |
| 日志目录 | `~/Library/Logs/searchx-runner/` | `~/Library/Logs/searchx-check-runner/` |

两个 runner 可在同一台机器上并存、各自独立运行，互不干扰。

## 文件

| 文件 | 职责 |
|---|---|
| `src/config.js` | `loadCheckRunnerConfig(env)` 读配置、校验必填（两个必填 + 可选 SMTP） |
| `src/poll.js` | `fetchPendingChecks` / `markCheckDone`（注入 fetch，离线可测） |
| `src/factcheck-cmd.js` | `buildFactcheckPrompt({text,link,imagePaths,verdictPath,resultPath,titlePath})` 拼 /factcheck 命令（纯函数） |
| `src/attempts.js` | 任务级失败计数（毒任务封顶用），持久化经注入 load/save，离线可测 |
| `src/runner.js` | `runOnce(config,deps)` 编排，全部副作用经 deps 注入 |
| `src/index.js` | 装配入口：抢锁、装配真实依赖（spawn claude / nodemailer / fetch / 计数文件）后跑 `runOnce` |

## 本地开发 / 测试

```bash
bun test services/check-runner   # 只跑 check-runner 单测（离线，不真 spawn claude，不真发网络）
bun test                          # 跑全部测试
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `CHECK_RUNNER_WORKER_URL` | ✅ | Worker 基址，如 `https://searchx-intake.qiuyuanqr.workers.dev`（即 intake-worker 部署地址） |
| `CHECK_RUNNER_SECRET` | ✅ | 与 Worker secret `CHECK_RUNNER_SECRET` **同值**（runner 凭它取/标任务；不一致则 `/check/pending` 静默 401，取不到任务） |
| `CHECK_RUNNER_SMTP_USER` | — | Gmail 地址（两个 SMTP 都填才启用通知邮件，缺一则 notify 关闭） |
| `CHECK_RUNNER_SMTP_PASS` | — | Gmail 应用专用密码 |
| `CHECK_RUNNER_AUTHOR_EMAIL` | — | 通知邮件收件人，默认同 `CHECK_RUNNER_SMTP_USER` |
| `CHECK_RUNNER_CLAUDE_ARGS` | — | 传给 `claude -p` 的额外参数，默认 `--permission-mode bypassPermissions` |
| `CHECK_RUNNER_MAX_ATTEMPTS` | — | 同一任务失败达此次数后停止重试（退休），默认 `3` |
| `CHECK_RUNNER_TIMEOUT_MINUTES` | — | claude 子进程硬超时（分钟），默认 `30`。到点先 TERM、宽限 10 秒再 KILL，按失败计入重试计数。没有它，一次挂死的 claude 会一直持有单实例锁、让整条管道停摆 |

写到仓库根的 `.env`（已 gitignore，bun 自动加载）：

```
CHECK_RUNNER_WORKER_URL=https://searchx-intake.qiuyuanqr.workers.dev
CHECK_RUNNER_SECRET=<与 Worker CHECK_RUNNER_SECRET 同值>
# 可选（都填才发通知邮件）：
CHECK_RUNNER_SMTP_USER=<Gmail 地址>
CHECK_RUNNER_SMTP_PASS=<Gmail 应用专用密码>
```

> Worker 侧（intake-worker）须配两把 `/check` 路由密钥才能跑通：`CHECK_KEY`（作者提交核查任务）与 `CHECK_RUNNER_SECRET`（runner 取/标任务，与本机 `.env` 同值）。生成与设置见 [intake-worker README](../intake-worker/README.md) 的部署步骤；漏配则 `/check` 路由静默 401。
>
> 另：`/factcheck` 核对 A 股行情类声明时优先用 akshare（SKILL Step 2.6），Mac mini 建议装上：`python3 -m pip install --user akshare`（`setup-macmini.sh` 会自动装）。没装不阻塞——skill 自动降级为 WebSearch 多源交叉。

## 运行

手动一次：

```bash
bun run check-runner
```

## 结论回显 / 内容标题（手机核查页显示）

- runner 为每条任务准备三个信号文件（同在 `<tmpdir>/searchx-check/<id>/` 下），并在 prompt 里让 `/factcheck` 核查完分别写入：
  - `verdict.txt` — **一行结论**（`裁定（把握度）：一句话真相`），列表那条下方的结论行。
  - `result.md` — **整篇核查笔记**（含 frontmatter，与 Obsidian 一致），供详情视图渲染。
  - `title.txt` — **一行 12–20 字中性内容标题**，当手机列表那条的标题，替代提交时自动生成的"N 张图 / 链接域名 / 长文本前 40 字"（纯图 / 长链接标题不再无信息或过长）。
- 跑完后 runner 读这些文件，随 `POST /check/<id>/done` 的 body `{ outcome, summary, result?, title? }` 上报；手机 check.html 的「最近核查」区凭 `CHECK_KEY` 拉 `GET /check/recent` 显示状态、标题与结论（详情另凭 `GET /check/<id>/result` 懒加载整篇）。
- **读不到某个信号文件就降级为不带该字段、照常 markDone**——结论 / 标题 / 详情都是增强，不是硬依赖；标题缺失时列表 fallback 回提交时的旧摘要。退休任务上报 `outcome: "failed"` + 一行原因 summary（页面显示"已失败"和"连续失败 N 次，已停止重试，请重新提交一次"）。
- **注入边界**：prompt 里用户提交的 text / link 包在 `≡≡≡待核查内容 开始/结束≡≡≡` 分隔线之内（内容里伪造的分隔线记号会被压掉）；附图路径与结论 / 结果 / 标题文件路径这些 runner 真实指令放在分隔线之外，且 skill 侧只认系统临时目录 `searchx-check/<id>/` 下的路径。
- 结论只在作者自己的私密通道流转（KV 7 天过期、凭密钥），通知邮件照旧不含内容明文。

## 失败 / 重跑语义

- **退出码≠0**（claude 崩了 / skill 报错）：不标 done，任务留在 KV 里，下轮自动重试，同时该任务的失败计数 +1。
- **失败达上限（默认 3 次，可用 `CHECK_RUNNER_MAX_ATTEMPTS` 调）**：任务"退休"——不再跑 claude，直接标 done 让它从 pending 消失，并发一封"核查失败、已停止重试"的通知邮件（不含核查内容明文）。这是毒任务封顶：没有它，一条永远跑不成功的任务会在 KV 7 天 TTL 内每轮完整烧一次 claude。
- **失败计数存本机** `~/Library/Application Support/searchx-check-runner/attempts.json`，条目 8 天自动过期（略长于任务 KV 的 7 天 TTL）；文件丢失只是多重试几次，无碍。
- **标 done 之后**：任务从 `/check/pending` 消失，不会重复处理。
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
- **子进程剥掉 CHECK_RUNNER_\* 机密**：claude 子进程拿不到 Worker 凭据，缩小提示注入爆炸半径。
- **单实例锁**：锁文件 `~/Library/Application Support/searchx-check-runner/check-runner.lock`，与 research runner 的锁路径不同，两个 runner 可以同时运行、互不影响。
