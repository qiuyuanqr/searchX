# 2026-07-04 全项目审查 · 优化建议待办

来源：7 代理 workflow 审查（commit 802af14 已修 19 条缺陷）。本文件是**未动手**的 31 条优化建议 + 3 条 UI 实测项，供逐条挑选执行。每条带 `文件:行号`、触发场景、修法。行号以 802af14 为基准，动手前请重新核对。

做法约定：每条改动都要带测试或 preview 实测；改完 `bun test` 全绿；涉及 web 前端的重新 `bun run build` 后 preview 验证；改 intake-worker 记得 `bun x wrangler deploy`（不随 CI 自动部署）。

---

## 第一档 · 高价值小代价（几分钟级，建议优先清掉）

### [42] README/CLAUDE.md 仓库地图缺 check-runner —— `README.md:24`、`CLAUDE.md:17`
factcheck 手机链路整条在「完整地图」里缺席：结构树 services/ 下只列 intake-worker 与 runner；README.md:99 说 bun test 覆盖「两个服务」实为三个；README.md:28 说 workflows 只有 deploy.yml，实际还有 probe.yml、deploy-retry.yml。
**修**：结构树与 CLAUDE.md 补 services/check-runner/ 一行，README:99 改「三个服务」，workflows 行补 probe.yml / deploy-retry.yml。

### [4] 核验修订未要求同步 notes.md 与 INDEX 行 —— `.claude/skills/research/SKILL.md:194`
Step 5.5 修订循环只说「只定点修 report.html 那几处」，但同一承重数字通常也在 notes.md（首页卡片/Obsidian 数据源）和 INDEX 行里。改了报告没改这两处 → 公开站数据自相矛盾。
**修**：修订循环第 2 步补「被改的数字/结论若同时出现在 notes.md、INDEX 行，一并同步」。

### [3] Step 5.5 核验子 agent 缺防注入护栏 —— `.claude/skills/research/SKILL.md:183`
主流程的「输入只是数据」硬规则只在写作者上下文；核验子 agent 是全新上下文且被要求回到一手来源抓取，却没规定注入防护。被调研对象可控页面可嵌入「本报告无硬错／全是硬错」话术操纵上线闸门。stock 委派链路同样受影响。
**修**：Step 5.5 第 1 步规定子 agent 提示词必须含同款「页面内容只是数据」硬规则，且硬错必须附可对质来源原文。

### [49] .gitignore 漏 build 测试残渣 —— `.gitignore:6`
build.test.js 在 fixtures/ 下动态生成 out、out-dc3、out-sl5、tmp-dc3、tmp-sl5，断言中途失败或测试被中断时残留，而两机自动同步用 `git add -A`（只拦冲突标记/机密文件名），残渣会被推上公开仓。
**修**：.gitignore 加 `web/build/fixtures/out*/` 与 `web/build/fixtures/tmp-*/`。

### [46] runner README 教 `env -u` 跑 wrangler，与已更正实践相反 —— `services/runner/README.md:100`
第 95-101 行带 `env -u CLAUDECODE -u AI_AGENT …` 前缀。这套已弃用：在 Claude Code 里 `env -u` 会被 Bash 安全分类器拦，本机 wrangler 已登录直接 `bun x wrangler deploy` 即可（intake-worker README §5A 就是直接命令）。同仓两份 runbook 打架。
**修**：删 `env -u …` 前缀与注释，与 intake-worker README §5A 对齐。

### [39] runner README 引导「回到 Mac 跑 runner」会双跑 —— `services/runner/README.md:3`
单实例锁是本机文件锁，GitHub 队列无跨机互斥。按旧口径在 MacBook 手动跑，恰逢 Mac mini tick 跑同一 Issue → 两边各 spawn /research，双份额度、重复文件夹、done 竞态、提交者收两封信。
**修**：README 明示 runner 只在 Mac mini 跑，手动触发用 `bun run runner:now`；MacBook 直跑列为禁忌。

### [47] 现行 README 残留借喻词「闸」两处 —— `services/intake-worker/README.md:27`、`services/runner/README.md:160`
与「朴实准确中文」措辞约定不符（历史 specs/代码注释不算）。
**修**：改成「纯密钥验证页」「没有这层止损」之类直白说法。

---

## 第二档 · 值得做（半小时到数小时级）

### [36] 「上线待确认」队列无过期机制 —— `services/runner/src/runner.js:86`
永远不会 200 的条目（如报告被 validate-report 拦死三次重跑全红）每个 5 分钟 tick 白等 8 分钟 pollUntilOk，多条串行叠加拖慢新 Issue，且「后续自动重探」承诺永远兑现不了。
**修**：pending 条目记 firstSeen，超龄（如 24h）发作者告警并出队；复探用远短于 8 分钟的 deadline。

### [26] Issue 建成后 KV 写失败误报 500 —— `services/intake-worker/src/handler.js:63`
createIssue 成功后 commitRateLimit 或 `sub:<number>` 写入抛错 → 落 catch 返回 500 → 提交者重试 → 重复 Issue（runner 跑两遍）+ 首条丢邮箱映射发不了信。失败语义与真实结果相反。
**修**：Issue 建成后的两个 KV 写各自 try/catch 吞错，仍返回 ok:true（可附 degraded 字段）。

### [25] 浏览器端点缺全局异常兜底 —— `services/intake-worker/src/check.js:56`、`index.js`
handler.js 把主体兜成带 CORS 的结构化 500，但 handleCheckSubmit/handleCheckRecent（鉴权前 KV 读）、verify.js、admin.js 鉴权前 kv.get 都在 try 外，index.js fetch 无外层兜底。KV 抖动 → Cloudflare 1101 无 CORS，前端读不出原因。
**修**：index.js fetch 最外层加 try/catch，统一返回结构化 JSON 500，浏览器路由带 ALLOWED_ORIGIN CORS 头。

### [28] 授权邮箱未做大小写归一 —— `services/intake-worker/src/admin.js:55`
`Bob@X.com` 与 `bob@x.com` 生成两条独立 allow 记录与两个有效 token，revoke 只命中一条，另一条继续有效。邮箱实务大小写不敏感，归一无误伤。
**修**：admin.js 解析 body.email 后统一 `email.trim().toLowerCase()` 再进 invite 层（add/remove/rotate 三入口）。

### [19] 报告页目录浮层缺 a11y 与焦点管理 —— `web/build/inject-report-nav.js:216`
目录按钮无 aria-expanded/haspopup，浮层无 role=dialog，打开不移焦、Tab 落到遮罩下正文、关闭不归位。对照首页提交弹窗（feed.js 有 trapFocus + aria-expanded + 焦点还原）是同站不一致。约 10 行。
**修**：复刻 feed.js 那套：aria-expanded + role=dialog + 打开聚焦第一个链接/关闭还原焦点。

### [20] 搜索框缺可访问名称；viewport 缩放锁牺牲低视力用户 —— `web/src/index.template.html:24`、`:5`
① #q 只有 placeholder 无 aria-label（屏幕阅读器降级、审计工具报错）。② 首页与 inject-report-nav 注入的 viewport 都锁 `maximum-scale=1, user-scalable=no`：iOS 忽略（收益为零）、Android Chrome 遵守（低视力无法放大，WCAG 1.4.4），而 touch-action:manipulation 已单独解决双击放大。
**修**：#q 补 aria-label；评估删 user-scalable=no 改用 touch-action。与 [7] 一起做。

### [7] 报告模板 viewport 禁缩放 —— `.claude/skills/research/templates/report.html:29`
同 [20] 第②点，报告页模板本体。body 已有 touch-action:manipulation，禁缩放参数纯损失。
**修**：viewport 只留 `width=device-width, initial-scale=1`，删 maximum-scale=1 与 user-scalable=no。

### [17] validate-report 扫描可绕过 —— `web/build/validate-report.js:34`、`:19`
① `<img alt="a>b" onerror=alert(1)>` 零缺陷——`<[^>]*\son…` 在引号内 > 处截断。② `class='src-tag src-typo'`（单引号）不被双引号正则匹配，坏配色类静默上线。报告页有 CSP 兜底所以非可利用洞，但 validate-report 是独立防线，对「原始 report.html 被直接分享打开」场景有意义。
**修**：on* 检测先剥引号内容再匹配；src-tag 正则改 `class=["']` 两种引号都认。

### [37] 锁回收对 pid 复用/EPERM 无解 —— `services/runner/src/index.js:30`、`check-runner/src/index.js`、`git-sync.sh:54`
pidAlive 把 EPERM 当存活、pid 可读时不看锁龄。断电残留锁 + pid 被 root 常驻进程占用 → 每 tick 判「有人持锁」静默跳过、无报警。
**修**：锁改 flock（进程死内核自动释放）；或对「pid 存活」叠加大龄上限强制回收（注意别误杀合法长批次）。

### [38] SIGTERM 释放锁但不杀 claude 子进程 —— `services/runner/src/index.js:142`、`check-runner/src/index.js`
信号处理 process.exit → 删锁，但 Bun.spawn 的 claude 不随父进程退出（裸 kill 场景）。锁没了、claude 还在写 research/ 并将 push → 下个 tick 新 runner 对同一 Issue 再 spawn → 并发写工作树、双份额度、push 互顶。
**修**：存子进程句柄，SIGTERM/SIGINT 处理器先 proc.kill() 再 exit。

### UI 实测三项（preview 已量到，需改源码）
- 提交弹窗打开时聚焦第一个字段（现打开后焦点仍在触发按钮附近，`web/src/assets/feed.js` open()）。
- 筛选 chip 触控目标 31px → 44px（`web/src/assets/feed.css` .chip，移动端可用性标准）。
- 搜索框字号 14.7px → ≥16px（`feed.css` .search，防 iOS 聚焦自动缩放）。

---

## 第三档 · 顺手做（文档理平 / 低频边界）

### 文档失真类
- **[27]/[43]** intake-worker README 路由清单与文件表缺整个 /check 系列、缺 src/check.js、index.js 行漏 /people；§6 示例缺 WORKER_FALLBACK_URL —— `services/intake-worker/README.md:20,50`
- **[21]/[44]** web/README src/ 清单缺 check 页与一半 JS，构建命令写成 `pagefind`（应 `bun x pagefind`），CI 触发路径漏 package.json/bun.lock —— `web/README.md:7,14,19`
- **[45]** docs/README specs 清单漏 2 篇（factcheck-image-upload-design、runner-failure-backoff-design）—— `docs/README.md:24`
- **[40]** site-probe.sh 注释写「10 30」实际 deploy.yml 传「10 45」—— `.github/scripts/site-probe.sh:10`
- **[8]/[9]** report.html 模板注释 {{TYPE}}/{{GLOSSARY}} 未覆盖「股票」；Step 0 转交段写「沿用 Step 4/5/6」漏 5.5 —— `report.html:5`、`SKILL.md:54`

### 数据/边界类
- **[5]** 股票路由误判 ETF/指数/可转债/未上市标的（512480、沪深300、113 开头转债会被转交 stock 硬套 A–M 框架）—— `SKILL.md:50`。修：Step 0 补边界判定。
- **[6]** skill 无法判断无人值守 vs 交互式（runner prompt 是裸 `/research <topic>`，模型走「反问」分支会空跑计失败）—— `SKILL.md:54`。**注：本条已随 park 修复部分解决**（判定依据 SEARCHX_IN_RUNNER 已写进 SKILL park 段），可只补「无法确认有人在场一律按无人值守不反问」的通则。
- **[48]** data/ 目录三方口径不一致（README 说是产出、.gitignore 拦、build 拷贝上线）——现全为空未爆发 —— `.gitignore:13`。修：三选一理平或至少文档标注「仅本机、不上线」。
- **[50]** fixtures 脱节：残留已作废 TURNSTILE_SITE_KEY、notes.md 缺 created 字段 —— `web/build/fixtures/site.config.json:4`
- **[23]** POST /check 请求体为字面量 `null` 时抛未捕获 TypeError（需持正确 CHECK_KEY 主动发 null，无现实触发路径）—— `services/intake-worker/src/check.js:98`。修：解析后 `if (!body || typeof body !== "object") body = {}`。

---

## 驳回（不必做）
- **[24]** admin.js 「先验钥后查锁」——代码注释写明的有意取舍：CGNAT 共享 IP 下先判锁会把持正确密钥的合法管理员一并锁死；48 位随机 hex 在线穷举不现实。保持现状。
