# 2026-10-02 Codex 接管记录

## 范围与保存

完成本地接管入口、代码/规则/记忆阅读链路、技能适配及离线验证；保留 Claude 与原有 Codex 成果。未替换后台 Claude 调用，未启停服务、部署、发信、改队列、清理工作树或改网络/账号。操作均按北京时间记；远端快照以当次查询为准。

改动前已有 `AGENTS.md`、`.agents/`、`.codex/` 三组未跟踪文件，tracked 文件干净。本次备份原 AGENTS、三份技能、钩子、README、docs 索引和 gitignore 到系统临时目录，保留原件与 SHA-256 清单；备份位置见本地未入库的 `docs/maintenance/takeover.local.md`。不把备份中的本机配置带入公开仓库。后续回退按文件比较、定点恢复，不整树覆盖并行成果。

当前真实根目录为主工作区而非临时工作树：`.git` 是目录，git worktree 仅一个，分支 main，origin 默认 main；本聊天 artifacts 为空。适用祖先目录未发现另一个 AGENTS/CLAUDE，根目录两份规则均读取。应用可见项目聊天快照仅本聊天为 active，历史异常邮件聊天 notLoaded；这不是全平台无人并行的证明。

## 当前代码与资料核验

开始基线 `a99230b`，本机 origin/main 最初同值；实时 GitHub 与 Mac mini 为 `684adcb`。compare 确认本机落后 7 个提交、仅 17 个 research 文件变化，与原有未提交文件无交集。fetch 后再次核对，`merge --ff-only origin/main` 成功，未 stash/reset 原有文件。当前验证基线 `684adcb`。

阅读入口：README、docs 索引、ARCHITECTURE（含维护守则）、四服务与 web README；9 月 18 日 research 审计与 9 月 23 日价位/数字/档案交接；项目记忆索引及双机同步、并行会话、factcheck 审计、全文 Obsidian、重复报告展示等相关条目；Claude/Codex 技能差异、模板、hooks、CI、装配与关键编排代码。

已复核：按目录去重先于 importedIds；query_only 前设置 busy_timeout；核查 doneCache 在退休之前；后台 Bun.spawn 调用 `claude -p`；行情写入方为常驻机 importer；Pagefind 与报告清单直接匹配并存。旧文档冲突单列在 PROJECT_CONTEXT，未批量改写历史。

## 导入分别核验

| 对象 | 证据与结论 |
|---|---|
| Claude 聊天 | 精确项目编码目录含 28 个顶层 jsonl；最新相关 cwd/main 元数据与当前目录一致 |
| Codex 聊天导入 | external_agent_session_imports 有 3 条 records（9 月 28、9 月 23、9 月 18 相关历史）；另 4 条 detected_connector_records 不算成功导入；threads cwd 与 session_meta 绑定原目录 |
| 项目规则 | 接管前 AGENTS 是 CLAUDE 的平台复制版本；本次保留正文、增量增加开工与权限规则，并修正失效路径 |
| 项目记忆 | Claude memory 软链解析到本仓库 `.claude-memory`，58 个 md 条目；没有足够证据证明它们完整导入 Codex 自动记忆库。通过显式项目文件承接，不手改自动记忆 |
| Codex 技能 | .agents 三份与 Claude 原技能相比主要是平台替换；保留全部业务流程，修实际路径/共用本机配置/错误 CLI 名称，补工具语义与授权界限 |
| 钩子 | .codex hooks 与 Claude 脚本 hash 相同；用户级 hooks.state 有 4 条对应信任记录。未手动调用钩子，未认定实际触发/E2E 已验收 |
| 后台任务 | launchd/真实日志单独查，不能从聊天导入推出已迁移。两个模型 runner 未加载，仍有 Claude 耦合 |

本机 `.env` 只确认存在且已忽略，没有读取内容。CLAUDE.local 只核对路径变量及库根存在性；外部 Obsidian 本机根目录存在，没有读私人笔记或写库。用户级配置只查键/功能/项目对应信任元数据，没有输出凭据。未遍历无关项目历史。

## 实时运维证据

- 常驻机 main `684adcb`，当时工作区干净。Stocks/worker-deploy/autopull 已加载，周期 300/300/600 秒，最近退出码 0；研究/核查 runner 在当前 GUI 域未加载。MacBook 五个项目 agent 均未加载。
- 导入日志 22:11、22:16、22:21 三轮均无新报告；同票同日碰撞目录 id=149，旧 id 未重新出现。行情 asOf=20260930，与日常更新提交一致。
- Pages 最新部署 run `37010256984` 完成 success，对应 `684adcb`；前两次可见部署也 success。没有触发新的部署。
- Worker 日志可见最后成功为 9 月 18 日 `3fd5930`，近期自动部署 agent exit=0；由于脚本无变化可空跑，此证据不等于云端当前版本已核实。
- runner 日志最后 tick 为 10 月 1 日 12:11:15，check-runner 为 12:10:19，都是无任务成功空跑。未加载原因、替代调度与意图需进一步核对，未启动它们。
- 进一步只读检查：两个 plist 均保留，间隔 300 秒，配置环境键含 `CLAUDE_CODE_OAUTH_TOKEN`（不回显值，不验证有效性）；`launchctl print-disabled` 明确两者 disabled。无对应锁文件，crontab 没有 searchX 项。停用原因仍未知。
- 公共 `site-probe.sh 1 0` 退出 0：首页可达、注入配置与仓库一致、Worker 主端点与备用端点响应；没有使用 token/密钥，没有提交任何任务。

## 验证结果

测试在无凭据的临时源文件镜像中执行，避免 Bun 自动读根 .env；复用本机已安装依赖，不更新锁文件。镜像含完整当前 research 文本，排除私有 data、历史记忆、本机配置与凭据；镜像/log 位置见本机 takeover.local.md。

| 验证 | 退出/结果 | 限制 |
|---|---|---|
| `bun test` | exit 0；1270 pass、1 skip、0 fail；74 个测试文件、3253 assertions | 默认未启用 SX_SLOW_TESTS，跳过真实锁冲突慢测 |
| `bun run build` | exit 0；195 entries；Pagefind 98 pages | 全量当前档案构建，不是模型事实核验 |
| `bun run build:worker` | exit 0；13 modules，41.64 KB | 构建成功，没有部署 |
| `bun run scripts/research-qc.js --strict` | exit 0；195 篇，0 硬红线，0 未跑成 | data 未带入镜像，数字对账与取数覆盖明确未跑；存在需人工判断的软项 |
| `bun run check:anchors` | exit 0；195 篇，无待补锚名 | 仅两类触发价位范围 |
| `bun run check:sources` | exit 0；195 个归档无清单文件缺失；报告漏列 35 条，额外来源 145 条 | 此命令默认不以差异失败；不能宣称来源检查全绿 |
| `bash .github/scripts/site-probe.sh 1 0` | exit 0；公共主备链路可达 | 不含鉴权、私密任务/邮件/手机 E2E |
| 文档与适配复审 | 入口链接存在，旧 AGENTS 正文增量保留；剥除平台说明后技能正文仅指定路径/CLI 替换；模板与 Claude 原版相同，Codex 钩子 hash 未变 | 元数据/语法检查不代表钩子触发验收 |
| `bash -n` / `git diff --check` | 12 个 shell 语法通过，tracked diff 无空白错误；新入口/技能也单独复核 | 不执行有副作用脚本 |

来源差异明细：8 条仍是旧导入报告的清单差异，27 条集中在 `2026-10-01_haiguang-xinxi-688041`。9 月 23 日用户已决定不在 stocks-import 追加 check-sources，本次不新增这道门禁、不改既有报告；后续若授权修来源清单，先逐篇核实。extra 是查过但未引用，可接受。

适配内容：更新 AGENTS 开工/边界与路径；更新三份 `.agents/skills/*/SKILL.md` 平台说明/交叉引用/共用本机配置/后台 CLI 描述；新增 HANDOFF、本背景文档与本日期记录；README/docs 索引/架构头部增入口；gitignore 排除本机备份记录。原 `.codex/`、Claude 文件、业务代码、锁文件与部署配置均未更改。

## 剩余工作

详见根 HANDOFF 的优先级列表。本次本地接管文件未主动提交/推送，原自动同步钩子保留；其触发与自动推送行为要与当前授权单独核对。恢复 runner、后台改 Codex、手机 E2E、凭据/SMTP/私密队列验证和域名迁移均不应在此次本地整理中悄然执行。
