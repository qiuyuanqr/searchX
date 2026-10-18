# 改动流水（Claude 与 Codex 共用）

两个维护者互相知会用的。**新的写在最上面**，和改动放进同一个提交。规则出处：`CLAUDE.md` / `AGENTS.md` 的「两个维护者怎么互相知会」。

- 什么要写：改了代码、规则、技能、钩子、CI、文档里的现行口径；**以及 Mac mini 上不进 git 的改动**（LaunchAgent 配置、服务启停、依赖、登录态、仓外状态目录）。后台自动产出的报告 / 行情提交不用写。
- 写到对方不用翻聊天记录就能接手为止：改了什么、为什么、验证到哪一步（实测 / 只跑了测试 / 没验证，照实写）、对方要注意什么、还剩什么没做。
- 这里记「发生过什么」；「现在是什么状态、接下来做什么」写在根目录 `HANDOFF.md`。
- 格式：`## 日期 时间（北京时间）· Claude 或 Codex · 一句话标题`，下面固定四行。

<!-- 新条目加在这一行下面 -->

## 2026-10-18 18:16 · Cursor · 从 Stocks 原文重导并恢复发布 601999

- **改了什么**：从 Mac mini 活库只读取出 report 196，备份残缺归档后用已修复导入器重写 `research/2026-10-16_stock-601999/report.html`，删除 `.parked`；本机 Obsidian 笔记刷新为带日期后缀的文件名。更新 `HANDOFF.md` 与本条流水、恢复记录增量。
- **为什么**：10-17 已修质检误报与导入器删公式，但正文仍是残缺 HTML，不能只删搁置标记上线。
- **验证**：原文 18 处「公式…」可抽到；新 HTML 无「公式为。/公式：。/公式应为；」；对原文反引号公式抽查对齐（质检附录里带省略号的截断样例不计）；`research-qc --dir … --strict` 退出 0；`bun run build` 232 篇，`reports.json` 含本篇；notes/sources 与重导前无 diff。未改 Mac mini 服务/配置；未重跑 LLM 独立核验。
- **没做 / 待办**：Mac mini `/Volumes/SS_SSD/obsidian` 未刷新；推送后需确认 Pages 上本篇 HTTP 200。`2026-10-05_stock-002837` 仍搁置/不恢复。

## 2026-10-17 03:46 · Codex · 修复章节误报和导入器误删财务公式

- **改了什么**：质检识别真实 J 节标题「可证伪逻辑」，仍只认章节标题，不用正文提及代替缺节；导入器保留中文/数字与数学标点构成的行内公式，SQL、内部字段元组和源码路径继续过滤。补三条回归测试。
- **为什么**：`2026-10-16_stock-601999`（Stocks report 196）已有完整逻辑链，原检查因 J 节措辞变化误报；另发现 `mapCodeSpan()` 把非英文标识符开头的公式删除，已归档正文多处只剩「公式为。」。没有原始正文不能可靠恢复，不能仅删 `.parked`。
- **验证**：先复现失败再修复；定向测试 109 pass；全量 Bun 1431 pass / 1 skip / 0 fail（4037 assertions）；231 篇存量质检硬阻断从 2 篇降为 0，差异仅本篇和 `2026-10-05_stock-002837` 的同类 J 节误报。构建 229 篇、Pagefind 99 页，两个 `.parked` 仍被排除。缺 data 的数字对账未跑，不等同全文事实验收。
- **没做 / 待办**：Mac mini SSH 两次均被对端关闭连接，生产日志、原始 report 196、生产部署版本未取得；未修改其服务/配置。两份报告均继续搁置、正文未改。恢复连接后从 Stocks 原始报告重导到隔离目录，核对公式与来源、通过检查与独立核验，再恢复发布并刷新 Obsidian。部署结果另见本次交接记录。

## 2026-10-11 17:40 · Claude · Codex 运行配置补进两份 LaunchAgent 模板

- **改了什么**（用户要求）：`services/runner/launchd/com.searchx.runner.plist` 和 `services/check-runner/launchd/com.searchx.check-runner.plist` 各加 `EnvironmentVariables`，8 项非敏感配置：两个 `*_OBSIDIAN_VAULT`、`SEARCHX_CODEX_BIN`、`SEARCHX_CODEX_DELIVERY_ENABLED`、`SEARCHX_CODEX_EFFORT`、`SEARCHX_CODEX_MODEL`、`SEARCHX_CODEX_STATE_ROOT`、`TZ`。值照 Mac mini 已安装的那份原样抄。此前这些只存在于已安装的 plist 里，按 README「拷模板 → bootstrap」重装会全丢。
- **验证**（实测）：两份模板 `plutil -lint` 通过；逐项与 Mac mini 已安装的 plist 比对，除下面那一项外完全一致。**没有重装或重载服务**——已安装的本来就是这些值。`bun test` 全量通过。
- **对方（Codex）要知道**：
  1. 模板现在**装上即生效**（`SEARCHX_CODEX_DELIVERY_ENABLED=1`），拷到别的机器加载就会真实取队列、发布、通知。
  2. Mac mini 已安装的两份 plist 里还各有一项 `CLAUDE_CODE_OAUTH_TOKEN`（登录令牌），**没进模板，也不该进**。它是后台还调 `claude -p` 时留下的；现在的代码不读它，`runtime.py` 的 `child_env` 也不会把它传给 Codex 子进程。我没删，等用户定。
  3. 以后改已安装 plist 的非敏感项，请同步改模板，两边再比一次。
- **没做 / 待办**：上一条里「是否补进模板待定」「重装会丢这几项」已由本条解决。`CLAUDE_CODE_OAUTH_TOKEN` 是否从已安装 plist 和 `searchx-codex-ops/` 下两份备份里清掉，待用户定。

## 2026-10-11 17:25 · Claude · Mac mini 两个 runner 的 Codex 执行器路径钉死（服务配置改动，不在 git 里）

- **改了什么**（用户要求）：给 Mac mini 已安装的 `~/Library/LaunchAgents/com.searchx.runner.plist` 和 `com.searchx.check-runner.plist` 各加一项环境变量 `SEARCHX_CODEX_BIN=/Users/yangqiuyuan/.local/share/stocks/codex-0.160.0/node_modules/.bin/codex`，其余项没动。两服务 `bootout` → `bootstrap` → `kickstart` 重载。仓库里的 plist 模板没改（Codex 10-03 加的那几项 `SEARCHX_CODEX_*` 也只在已安装的 plist 里）。
- **为什么**：这台机器上有两个 codex——`/opt/homebrew/bin/codex` 是 0.144.6（模型目录没有 `gpt-6.1-sol`），`~/.local/bin/codex` 是指向 0.160.0 的软链。之前靠 `scheduled-run.sh` 里 PATH 的先后顺序选中后者。钉的是**带版本号的真实目录**而不是 `~/.local/bin/codex` 软链：软链被改指到新版本时生产会悄悄换版本，而 README 写明只验证过 0.160.0、升级必须重测。
- **验证**（实测）：改前无锁、无在跑进程；钉的路径可执行、`--version` 为 0.160.0；`launchctl print` 两服务都读到新变量、仍为 enabled；重载后首轮 runner 17:24:37、check-runner 17:24:33 均 exit=0（每轮启动预检都会用这个路径做 `Bun.which`）；`Bun.which` 对不存在的绝对路径返回 null，即路径失效时预检会报「执行器不可用：SEARCHX_CODEX_BIN」并拒绝取队列。plist 权限仍为 0600。**没验证**：用这个路径跑一条完整真实任务（队列为空）。
- **对方（Codex）要知道**：
  1. **升级 codex 时要同时改这两个 plist 的这一项**，否则旧目录一删，两条 runner 每轮都会在预检失败（会响，不会静默）。那个目录在 `~/.local/share/stocks/` 下，看名字是 Stocks 那边装的——Stocks 侧升级或清理时会连带影响 searchX。
  2. 改前的 plist 备份在 Mac mini `~/Library/Application Support/searchx-codex-ops/20261011-172433/`（目录 0700、文件 0600）。回退：拷回去再 `bootout` / `bootstrap`。
  3. 重装服务（`setup-macmini.sh` 或手动拷模板）会丢掉这一项和 10-03 那几项，因为模板里都没有。
- **没做 / 待办**：`SEARCHX_PYTHON_BIN`、`SEARCHX_BUN_BIN` 没钉，仍按 PATH 找（各只有一个版本，暂无同类风险）。是否把这些 `SEARCHX_CODEX_*` 项补进仓库模板，待定。

## 2026-10-11 17:23 · Claude · 修根因：自动研究的报告目录改用主题名，不再是任务号

- **改了什么**（用户要求我来修）：只动 `services/codex-runtime/workflow.py` 和它的测试、README。
  - 分类阶段多返回一个 `slug`（英文主题短名）。新增 `topic_slug()` 规整模型输出：只留小写字母 / 数字 / 连字符，最长 48，**去掉 6 位以上连续数字**，拒绝 `task-` / `stock` / `stock-` 开头。
  - 新增 `stock_code()`：股票目录名的代码从**取证之后的封面标题**取（A 股 6 位、港股补 5 位），不用分类阶段模型凭记忆给的。
  - 新增 `Workflow.archive_slug()`：目录名只定一次，写进任务目录 `archive-slug.json`，恢复 / 重试 / 重新校验都读回同一个。定名时若 `research/<日期>_<名>` 已存在，追加 6 位短哈希。主题名不可用就退回适配器传的 `task-<哈希>`（即原行为）。
  - `adapter.js` 没动：它传的 `--slug task-<哈希>` 现在只是兜底值。任务身份哈希、回执校验、宿主交付都没改——交付层本来就是从产物目录名取 `folder`。
- **为什么不止是好看**：`services/runner/src/dedup.js` 的 `extractCodes` 会把目录名里任何 6 位数字当成股票代码。`task-ecd329686721…` 这种哈希里的「329686」就成了那篇报告的候选代码，哈希撞上真代码时会把别人提交的股票误判成「已调研过」。
- **验证**：
  - Python 104 项、Bun 1428 项全过（退出码都是 0）。新增 8 项测试，含走真实 `generate` / `run` 的整条传递（分类结果 → 生成提示里的归档路径 → 回执里的产物目录）。
  - **Mac mini 真实模型实测**（生产同款 `~/.local/bin/codex` 0.160.0、`gpt-6.1-sol/high`，独立临时目录，只跑分类这一步，跑完已删）：「华为和问界的分家了吗」→ `huawei-aito-cooperation`；「芯原股份」→ stock / `verisilicon`；「CPO、NPO、LPO…」→ `cpo-npo-lpo`。新的输出结构被真实 CLI 接受。
  - **没验证**：整条真实研究从分类跑到上线（要花一次完整研究的额度和 1–3 小时）。股票「封面标题取代码」这一步只有替身测试，没有真实模型产出验证。下一条自然任务上线后看目录名。
- **对方（Codex）要知道**：
  1. 分类阶段的提示和输出结构变了，旧任务目录里的分类检查点不会被复用。当时队列为空、无在途任务。
  2. 试跑时我先误用了 `/opt/homebrew/bin/codex`（0.144.6，模型目录里没有 `gpt-6.1-sol`），报「Pinned model/effort unavailable」。生产不受影响（`scheduled-run.sh` 的 PATH 里 `~/.local/bin` 排在前面，用的是 0.160.0）。**但这台机器上有两个版本的 codex，谁要是调了 PATH 顺序，生产会在第一步直接失败**，要不要把绝对路径用 `SEARCHX_CODEX_BIN` 钉死，你定。
  3. `archive_slug` 打印的那行进度不带 `stage` 字段，`adapter.js` 的日志过滤会丢掉它，所以 runner 日志里看不到定名结果，只能从交付日志的目录名看。
  4. Obsidian 笔记文件名仍是 `调研-<标题>-<目录名>.md`（交付层定的，我没动），目录名可读之后它也可读了；但和 research SKILL Step 5 写的「`<中文对象名>.md`」仍不一致，哪个为准待你和用户定。
- **没做 / 待办**：定名之后、交付之前，如果别的途径在同一天发布了同名目录，交付会报「Existing archive is not owned by this job」并一直延期。改名前的哈希目录不存在这种可能；概率很低，没处理。

## 2026-10-11 17:14 · Claude · #52 报告目录从任务号改成主题名（网址变了）

- **改了什么**：用户要求。`research/2026-10-03_task-ecd329686721b6bdb25d/` → `research/2026-10-03_huawei-aito-cooperation/`（`git mv`，三件套内容没动），`notes.md` 的 `archive` 字段和 `research/INDEX.md` 那一行同步。Mac mini 的 Obsidian 笔记文件名与正文里的旧目录名、Issue #52 评论里的链接也跟着改了。
- **验证**：`bun test` 全量通过；`bun run build` 后新目录生成报告页、`reports.json` 里是新名字、旧名字 0 处。线上新旧网址的实测结果见本条所在提交之后的用户汇报。
- **对方（Codex）要知道**：
  1. **根因没修，下一篇还会是任务号**：`services/codex-runtime/adapter.js` 调 `workflow.py` 时把目录名写死成 `--slug task-<任务哈希前 20 位>`（第 331 行附近），模型开跑之前目录名就定了，所以拿不到主题名。此前所有报告都是 `<日期>_<英文主题名>`（股票是 `<公司英文名>-<代码>`）。修法需要在分类阶段产出主题名并一路传到归档与回执校验，动的是你的任务身份哈希和检查点，我没动。
  2. Obsidian 笔记文件名也带上了目录名（`调研-<标题>-<日期>_<目录名>.md`），此前的约定是纯中文对象名（`<中文名>.md`，见 research SKILL Step 5）。同一处一起看。
  3. 仓外状态目录 `searchx-codex-jobs` 里这条任务的交付记录仍指向旧目录名，我没碰。#52 已 done 不会再交付；如果你的代码有地方会回头核对已交付目录，要知道它已改名。
- **没做 / 待办**：旧网址现在是 404，站点没有旧网址跳转的机制。当时发给提交者的完成邮件里是旧链接。

## 2026-10-11 17:01 · Claude · 服务启停也放开：改完直接做

- **改了什么**：用户追加裁决「服务启停也放开，一样改完直接做」。共用节那条把 Mac mini 上 `com.searchx.*` 后台服务的启停、重启、配置调整并入常规收尾；`AGENTS.md` 开工第 6 条、`PROJECT_CONTEXT.md` 冲突表同步。
- **验证**：`bun test scripts/agent-rules-sync.test.js` 通过。只改了文字，没有动任何服务。
- **对方（Codex）要知道**：启停本项目服务不用再问用户，但**动了必须在这里写一条**（哪个服务、前后状态、原配置备份位置），否则另一方无从知道。仍要当次同意的只剩：删数据、覆盖别人可见的线上内容、改网络与账号设置、碰本项目以外的服务（如 Stocks 的）。
- **没做 / 待办**：`AGENTS.md` 开工第 7 条「不要在 MacBook 上直接跑 runner / 定时包装脚本来验收」没改——那是防止开发机误消费生产队列，与授权无关，仍然有效。

## 2026-10-11 17:00 · Claude · 推送与部署口径统一：改完直接做

- **改了什么**：用户裁决「推送口径统一成改完就推，部署也一样」。`CLAUDE.md` / `AGENTS.md` 共用节那条改成：提交、推送、Pages 部署、Worker 部署都是常规收尾，做完再汇报，不必每个会话再问。`AGENTS.md` 开工第 6 条和「狗不理」那条、`PROJECT_CONTEXT.md` 冲突表对应行同步改了。
- **验证**：`bun test scripts/agent-rules-sync.test.js` 通过（两份规则共用部分仍逐字相同）。只改了文字，没有部署任何东西。
- **对方（Codex）要知道**：以后 push 和部署不用再向用户单独确认。**不包括**启停或改配 Mac mini 后台服务、删数据、覆盖别人可见的线上内容、改网络与账号设置——这些仍要当次同意。
- **没做 / 待办**：上一条里「推送授权口径两边不一致」已由本条解决，其余三项待办不变。

## 2026-10-11 15:55 · Claude · 建立两个维护者的互相知会机制

- **改了什么**：
  - 新增 `scripts/whats-new.sh <claude|codex> [--peek]`：开工简报——自己上次开工以来的人工提交（谁、何时、哪些文件）、同步状态、本文件最新 3 条。「读到哪」记在 `.git/searchx-seen-<谁>`，各记各的。
  - `.claude/settings.json`：SessionStart 改成拉取完接着跑简报（同一条命令里串行，钩子之间是并行的）。**没动 `.codex/hooks.json`**（它在 Codex 用户级配置里有信任记录，改了可能要重新信任），Codex 侧靠 `AGENTS.md` 开工第 1 条手动跑。
  - `CLAUDE.md` / `AGENTS.md`：各加同一节「两个维护者怎么互相知会」；`CLAUDE.md` 另加开工入口，指向 `HANDOFF.md`（此前 Claude 这边没有任何地方指向它）。
  - 新增 `scripts/agent-rules-sync.test.js`：两份规则文件的共用部分、三份技能、报告模板、三个同步钩子，两边不一致就挂。
  - 两份 factcheck 技能里「后台由 `claude -p` 跑」那句已过时，改成同一句准确的。
  - 把 MacBook 上 10-03 18:25 那个没推上去的文档提交（生产恢复记录）rebase 到最新并推了。
- **验证**：`bun test` 全量 1428 通过 / 1 跳过 / 0 失败（退出码 0）；新测试故意只改一边技能后确实挂在那一行；`whats-new.sh` 在本仓库真跑过（首次无记号、有记号、`--peek` 三种）。Codex 侧是否真会在开工时跑简报，**没验证**，要等 Codex 下一次开工看。
- **对方（Codex）要知道**：
  1. 以后改技能 / 全局约定 / 钩子要两边一起改，否则测试挂、CI 不部署、新报告上不了线。
  2. 提交末尾请加一行 `Agent: Codex`，简报靠它认人；现在你的提交在简报里显示为「未署名」。
  3. 三份 `.agents/skills/*/SKILL.md` 的「Codex 平台适配」段里还写着「后台仍调用 `claude -p`」，10-03 之后已不成立。这段是你的，我没动，请你更新。
  4. `HANDOFF.md` 顶部「#52 正文生成中、尚未验收」是 10-03 16:39 的快照。我今天只读核对的结果：#52 已带 done 标签（10-03 16:57 提交 `6f11554`），报告页 HTTP 200；Mac mini 五个服务都已加载、两个 runner 为 enabled，今天 15:48 的 tick 均 exit=0、队列为空；Mac mini 与 GitHub 同为 `32ed319`、工作区干净。邮件是否送达、Obsidian 笔记是否落库我没核。
- **没做 / 待办**：
  - #52 的目录名是任务号而不是主题名——已于同日 17:14 那条改名，根因见那条。
  - 推送授权口径两边不一致：Claude 侧记忆是「提交 / 推送 / wrangler deploy 一条龙做完再汇报」，`AGENTS.md` 第 6 条是「新聊天不继承授权，push 单独核对」。本次按用户「改完要实时同步」的要求把「改完就推」写进了共用规则；部署与服务启停两边仍各按原口径，待用户统一。
