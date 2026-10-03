# searchX 项目背景与维护上下文

> 2026-10-02 整理。事实依据为本地代码、配置元数据、Git 与只读运行快照；旧记忆用于寻找证据。当前状态先看根目录 HANDOFF。

2026-10-03 本地接线更新：两个 runner 的模型入口已改接 `services/codex-runtime/adapter.js`，固定 `gpt-6.1-sol`、最低 `high`；研究宿主负责归档/构建/精准提交，核查宿主负责规范笔记路径和同字节回传。生产常驻机尚未同步或启用，下面涉及 Claude 后台的描述属于接管时快照。隔离全流程证据与剩余验收见 HANDOFF 和当日测试记录。

## 目标、边界、入口

searchX 产出中文深度调研报告与来源，并发布为静态信息流站。`research` 是通用研究，`stock` 是单一上市公司 A–M 分析，复用研究的模板与独立核验；`factcheck` 核实消息、截图和链接，结果只在外部 Obsidian 与凭密钥的 Worker KV 流转，KV 7 天过期，绝不进公开研究目录。

| 入口 | 职责与消费者 |
|---|---|
| `.agents/skills/{research,stock,factcheck}/SKILL.md` | Codex 项目能力；平台适配段解释工具映射，业务流程保留 |
| `.claude/skills/` | Claude 项目能力，仍是两条生产模型任务的来源；保留 |
| `research/<日期>_<slug>/` | `report.html`、`notes.md`、`sources.md`，站点数据源；`INDEX.md` 给人读，构建不依赖它 |
| `web/build/cli.js` → `build.js` | 扫档案、校验、生成首页/报告/标的判断档案/配置/缓存指纹 |
| `web/src/` | 首页、提交、授权管理、私密核查页面；搜索有 Pagefind 与 `reports.json` 两条通路 |
| `services/intake-worker/src/index.js` | Cloudflare 写入口：token 授权、校验、限频、公开 Issues、私密核查 KV |
| `services/runner/src/index.js` | approved Issue → 股票查重 → Claude 研究 → done → 确认发布 → 邮件；副作用集中装配层 |
| `services/check-runner/src/index.js` | 私密任务 → 附图/前作 → Claude 核查 → result.md → 回传；失败缓存/退休与通知 |
| `services/stocks-import/src/index.js` | 只读 Stocks → 清洗系统术语 → 价位改写 → 三件套；定时包装负责质检、构建、精准提交推送 |
| `services/stocks-import/src/series-prices.js` | 常驻机唯一写 `research/_series/prices.json`；其他机器不得用过期副本回写 |
| `scripts/` | Obsidian 全文转换、来源检查、机械质检、联网数字回链、锚名分诊、网页直抓与一次性回填 |
| `.github/workflows/` | Pages 部署、失败有限重试、海外探活；Worker 另走常驻机自动部署 |

## 已落实的重要决策

- **静态站与快照报告**：目录即数据库，Git 保存版本；不按当前行情自动改旧结论。首页/搜索展示最新报告，历史报告保留入口。标的档案回看未复权收盘和历次判断，不给判断打分。
- **公开/私密分流**：研究排队用公开 Issues，真实邮箱放私有 KV；核查任务与结果不进 Issues/研究目录。管理/核查页不放公开入口链接，真正鉴权在 Worker。
- **质量检查两类并存**：模板/脚本注入/CSP/机械规则由代码检查，事实错配由 research Step 5.5 的独立只读联网核验负责。联网数字回链只提供质证清单，不替代独立核验。
- **副作用注入、离线测试**：业务逻辑注入 fetch、transport、spawn 等，装配层才碰真实服务。成功单测不能替代接线与异常路径验收。
- **幂等是至少一次语义**：研究 done 是防重标记，done 不等于上线成功；失败预算默认 3 次，上线待确认超过 24 小时要人工处理。核查完成回传失败优先补缓存，不能再次花额度跑核查。
- **股票查重默认 20 天**：权威为 `services/runner/src/dedup.js` 的常量，前端与 runner 共用。通用研究仍靠技能判断重复，不能宣称全部类型有代码查重。
- **来源抓取顺序**：事实核查优先 `scripts/fetch-article.py` 抓原文，摘要仅兜底。状态量、否定或独占性表述要当日补检索；一次查空不能证明不存在。

## 必须延续的坑与处理方法

| 现象或风险 | 已确认机制/处理 | 定位入口 |
|---|---|---|
| 同票同日两份报告反复部署 | 先按目标目录保留最新时间/较大 id，再过滤已导入 id；`--id` 是诊断例外 | `latestPerDir`、对应测试；常驻机日志与 notes id |
| Stocks 查询锁冲突 | 先 busy_timeout=30000，再 query_only=1，等待失败再重试一次且仍抛错；SELECT 1 不能探测真表 | stock §2.3、导入 `sqliteJsonLines` |
| 查询为空 | 注册名/品牌名、代码后缀、日期格式、FTS 分词分别核对；白名单外私人表不能进产出 | stock §2.3 |
| 搁置报告被收尾带上线 | 两种场景均写主题 `.parked`；构建跳过，同步提交排除；runner 信号 `.parked.json` 是另一份文件 | 技能 Step 5.5、build、git-sync |
| 目录有了但 notes 缺失 | 半成品进入失败预算，不能对 undefined.entry 取 href 后整轮崩溃 | research runner 编排 |
| 成功核查被标成失败/重复跑 | 补 done 缓存必须排在退休判断之前；父截图保留到 7 天 TTL | check-runner runner、Worker check |
| 锁更新时间掩盖活进程卡死 | 心跳 mtime 与创建时刻上限都要保留；释放前核对持有者；跨机器不互斥 | 两个 runner 的锁逻辑 |
| 中文文件名漏过机密检查 | git 文件名读取用 core.quotePath=false 与合适分隔符 | git-sync 与相关测试 |
| macOS/Linux stat 不一致 | 按平台或纯数字结果选择参数，不靠 `stat -f ... || ...` | hooks/定时包装 |
| fixtures 绿但存量显示错 | 构建/导语/转换/查重改动对全部真实档案跑，输出到显式绝对临时目录 | AGENTS 改代码约定 |
| 纯函数测试无法发现 UI 接线错 | 真浏览器测正常及异常路径；源 feed 依赖构建复制的 dedup，不直接托管 src | web README/架构手册 |
| KV 列表额度被耗尽 | 列表使用 `check:idx`，新增路由 return await、鉴权/CORS/限频 | Worker README/代码 |
| 数字核查假命中 | 来源归属目前是段落级；单位、相邻数字和反爬页仍有边界，未测不能算通过 | check-web-numbers 与 9 月 23 日记录 |
| 子进程拿到机密 | 两组 RUNNER/CHECK_RUNNER 前缀剥离、SEARCHX_IN_RUNNER 与输入分隔线/路径白名单一起保留 | child-env、factcheck-cmd、技能 |

## 历史记录的冲突与时效

这些记录保留原文；有代码证据的事实按当前代码解释，授权冲突由当前明确用户要求裁决，不从旧聊天扩大授权。

| 记录 | 当前证据/处理 |
|---|---|
| 原 README 只写 Claude，原 Codex 技能引用 `.Codex/skills`、`Codex.local.md` 和 `Codex -p` | Codex 技能已经存在；本次修为 `.agents/skills`、共用 `CLAUDE.local.md`，后台仍是 Claude CLI；没有把复制当成迁移 |
| 架构手册 §5.7 旧称 markDone 连败最终退休 | 9 月 18 日实现与 check-runner README 已改为缓存优先补回传、有缓存不退休；旧段保留为历史 |
| 架构/runner 文档旧流程图写先发信后 done | 当前 dedup 成功分支先 done 再通知；以后改逻辑以代码/测试核对 |
| 质检文件头旧称“所有入口 fail-open” | `--strict` 已对检查未跑成与硬红线非零退出；不要据旧注释放行 |
| 历史记忆称两条 runner 全部在线 | 本次常驻机 GUI 域未加载且 disabled，日志停在 10 月 1 日中午；旧 E2E 仅是历史证据 |
| 早期“factcheck 仅存本机” | 现在整篇经私密 KV 回手机，7 天 TTL；仍不上公开站 |
| 早期“runner 挂不到外置 Obsidian”与后来的库目录探活 | 本机库根存在；常驻机真实挂载与写入尚未验收，分别核实，不照抄任一旧断言 |
| 架构 §8/旧记忆授权常规 commit/push/deploy；新的用户边界要求按会话授权 | 本次只做本地整理与主线快进，未主动发布。新聊天核对授权；同步钩子可能自动提交全工作区并推送，不能手动执行它代替精准收尾 |
| 历史“狗不理只写 progress、不写 HANDOFF” | 2026-10-02 用户提供的新规则要求根 HANDOFF + 日期交接并安全合入主线；AGENTS 已增量落实 |
| 老文档数量/覆盖率/测试数、自动同步约 10 分钟等 | 都是当时快照，当前统计和装载状态单独记录，不作为保证 |

## 开发验证与运维方式

本机已有依赖时先验证再决定是否安装；缺依赖使用锁文件 `bun install --frozen-lockfile`。不要直接运行安装常驻机的脚本：它有拉取、安装、记忆软链等副作用。

正常命令：`bun test`、`bun run build`、`bun run build:worker`、`bun run serve`。来源检查 `bun run check:sources` 默认只报告差异，严格模式才非零；质检使用 `bun run scripts/research-qc.js --strict`；锚名用 `bun run check:anchors`。联网 `check:web` 与模型独立核验另行核实原文与能力。没有改 UI 时不扩展视觉验收。

本次为避免 Bun 自动加载根 `.env`，将当前源文件与全部 research 复制到不含凭据/记忆/本机配置的临时镜像，只读复用现有 node_modules，再在那里执行上述离线检查。测试退出码直接记录，不经输出管道；不启动生产装配入口。此方法不修改主工作区或外部笔记。

部署：Pages 由指定 paths 的 main push 触发；Worker 走单独 deploy-cron/launchd。部署成功要看 Actions/Worker 版本及实际探测，HEAD 不等于上线。MacBook 不直接跑两个 runner、Stocks 活库更新或定时包装；常驻机 kickstart 也属于运行操作，需授权。

凭据仅确认文件存在、代码要求的键名和进程环境中是否设置，不读取 `.env` 或测试密码。研究配置键见 runner README（RUNNER_GITHUB_TOKEN/SUB_SECRET/SMTP_USER/SMTP_PASS 等），核查见 check-runner README（CHECK_RUNNER_SECRET/OBSIDIAN_VAULT 等），Worker 见其 README（GITHUB_TOKEN/ADMIN_KEY/CHECK_KEY 等）。配置文件存在不证明值已配置，更不证明鉴权有效。

## 上下文来源与延续方式

- 根 AGENTS/CLAUDE、README、架构手册、模块 README；9 月 18/23 日进度记录；按主题读取的本地 `.claude-memory`。
- Claude 项目目录 memory 是指向本仓库 `.claude-memory` 的软链；58 个 Markdown 条目，未批量复制到公开文档。只整理项目工程规则，不搬私人内容。
- Claude 项目历史定位到 28 个顶层会话文件；只查最新相关会话的元数据及收尾。Codex 导入有 3 个已导入记录，另有 4 个检测记录（部分重复，检测不等于导入）。后端 threads 和 session_meta 可验证目录绑定。
- `.codex/hooks.json` 已存在，用户级配置有 4 条该项目钩子的信任记录；脚本与 Claude 原版逐字节相同。只证明配置/信任元数据存在，未执行实际同步来证明触发。它们使用脚本目录作为 CLAUDE_PROJECT_DIR 缺失时的回退，因此变量名本身不证明失效。
- 没发现项目 `.claude/commands`、自定义 agents 或 `.mcp.json`；用户级 Codex 有工具配置，但没有据此认定 Claude 全局工具配置已迁入。现有通知配置也未执行。

后续更新本文件写代码位置、决策原因与适用限制；实时状态写 HANDOFF；执行证据写带日期交接。无需依赖本次聊天或修改自动记忆库。

修改共享业务规则时对照 AGENTS/CLAUDE 与两边 SKILL 的差异，按主题同步有效内容，保留平台适配差异；不要整份互相覆盖。本次没有改 Claude 原规则/技能/钩子或 Codex 钩子。
