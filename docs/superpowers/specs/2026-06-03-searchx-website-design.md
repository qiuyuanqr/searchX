# searchX 网站化 · 设计稿（spec）

- 日期：2026-06-03（北京时间）
- 状态：M1 已上线；自动上线已打通（SKILL Step 6）；**M2 设计已与用户敲定（2026-06-03），待写实施计划**
- 关联：`CLAUDE.md`、`.claude/skills/research/SKILL.md`、记忆 `searchx-website-plan`

---

## 1. 背景与目标

searchX 目前是跑在 Claude Code 上的本地深度调研引擎：`/research <对象>` 产出 `research/<日期>_<slug>/` 下的三件套（`report.html` / `sources.md` / `notes.md`），并维护 `INDEX.md`。

目标：把它扩成一个**可上线、可分享给朋友**的网站——

1. 一个**信息流 + 搜索**的站点，每条目链到已生成的 `report.html`；
2. 能上线到 **GitHub Pages**，朋友凭链接即可阅读；
3. 朋友能**直接提交想调研的题目**，经作者审核后**自动**跑研究、自动上线，并把结果**以易读方式推送到提交者邮箱**。

核心原则：**分层增量**——每一期都能独立上线、独立产生价值；不一上来就建复杂基础设施。

## 2. 范围与非目标

分三期：

- **第 1 期 · 信息流站（地基）**：静态站，从现有 `research/` 自动生成可浏览、可搜索的信息流。**这是其余两期的前提。**
- **第 2 期 · 半自动流水线**：朋友提交 → 作者审核 → 自动跑 → 自动上线。
- **第 3 期 · 邮件触达**：跑完自动发邮件给提交者。

**非目标（本期不做）**：云端常驻无人值守 runner（B 模块，见 §11）；自然语言语义检索的完整实现（先打底，见 §5.4）；多用户账号体系；评论/社交。

## 3. 总体架构

关键边界：**公开面是纯静态文件（无服务器可被搞崩）；唯一对外可写入口是一个只负责"入队"的瘦函数；任何花钱/危险的动作都锁在作者人工审批闸之后。**

```
            公开区（任何人可达，碰不到额度与线上发布权）
  ┌───────────────────────────────────────────────────────────┐
  │  信息流站 (GitHub Pages, 静态)        提交表单 (静态页)        │
  │  index + 搜索 + report.html 们   →    POST                   │
  └───────────────────────────────────────────┬───────────────┘
                                               │ (Turnstile+限频+长度校验)
                                               ▼
                                    Cloudflare Worker（瘦·只入队）
                                               │ 用受限 token 建 Issue
  ─────────────────────────────────────────────┼──────────────────────────
            作者私有区（仅作者；API key/额度只在这里）
                                               ▼
                            GitHub Issues = 待审队列  ──🔔通知作者
                                               │
                                  作者审批：贴 `approved` 标签   ← 审批闸（花钱前）
                                               │  💸 额度只从这里起消耗
                                               ▼
                          本机 Mac runner（Claude Code 跑 /research）
                                               │ 产出三件套写入 research/
                                               ▼
                              git push  ──►  GitHub Action：构建+部署 Pages
                                               │
                                               ▼
                                  Emailer（Gmail）→ 提交者 + 抄送作者
```

## 4. 组件拆解（职责 / 接口 / 依赖）

> 每个单元单一职责、接口清晰、可独立理解与测试。

| 单元 | 职责 | 输入 → 输出 | 依赖 |
|---|---|---|---|
| **内容库** `research/` | 真相源；每主题一个文件夹（已存在） | — | 现状 |
| **Feed Builder** `build/` | 扫内容库 → 生成静态站 | `research/*/` → `site/`（index.html、报告副本、`feed-index.json`、Pagefind 索引） | Node/bun（仅 CI）、Pagefind CLI |
| **Feed UI** | 信息流前端（视觉/交互/筛选/搜索） | 消费 `feed-index.json` + Pagefind | 纯浏览器 |
| **提交表单** | 收集朋友的调研请求 | 表单 → POST 到 Worker | 静态页 |
| **Intake Worker** | 唯一公开写入口：校验 + 入队 | POST → 建 GitHub Issue | Cloudflare（免费）、受限 GitHub token、Turnstile |
| **队列** | 待审/已批/已拒/已完成 状态机 | GitHub Issues + 标签 | GitHub |
| **Runner** | 监听 `approved`，跑研究，回写，发布 | Issue → `research/` 新文件夹 + push | 本机 Claude Code、git |
| **Publisher** | 构建并部署站点 | push → Pages 上线 | GitHub Action |
| **Emailer** | 发结果邮件 | 完成事件 → 邮件 | Gmail |

各单元只通过文件/Issue/git 这些**明确接口**通信，可分期独立实现与替换（例如 Runner 之后可整体替换成云端版，其它单元不变）。

## 5. 第 1 期 · 信息流站

### 5.1 内容模型与真相源
- 真相源 = `research/<日期>_<slug>/`。每条目的元数据从 `notes.md` 的 frontmatter 取：`date / type / tags / related / source_count / archive`；标题与一句话结论（TLDR）从 `report.html` 的 `{{TITLE}}`/`{{TLDR}}` 或 `notes.md` 首段取。
- 不改动现有 `/research` 产出格式；网站是**只读消费方**。（唯一可选增强：发布时给每份 `report.html` 顶部注入一个"← 返回档案"链接。）

### 5.2 构建流程（Feed Builder）
- 一个**精简构建脚本**（约百行，Node/bun），不引入重型 SSG——因为报告已是自包含 HTML，构建只需：①读所有主题文件夹的元数据 → 生成信息流首页 `index.html`；②把各 `report.html` 复制进 `site/`；③生成 `feed-index.json`（供前端筛选/排序）；④调用 **Pagefind CLI** 对 `site/` 建全文索引。
- 确定性：同样的 `research/` 输入产出同样的 `site/`。
- 备选：若以后维护变复杂，可换 Eleventy 等轻量 SSG；接口不变。

### 5.3 信息流 UI（视觉与交互——已定稿）
定稿原型：`.superpowers/brainstorm/sess/content/feed-paper-v4.html`。
- **气质**：纸感——暖纸底 + 衬线正文，沿用 `report.html` 调色并**整体调淡**；支持深色模式。
- **结构**：顶部（小标 → 站名 → 搜索框 → 类型/板块筛选条）随整页一起滚动；下方为卡片信息流。
- **分隔**：无硬边框；卡片仅极淡阴影做底纹；条目间用**极淡的发丝渐变线**，**留白主导**。
- **交互**：卡片 3D 倾斜跟随鼠标（"微微晃动"，≈4°）+ 悬浮上浮 + 标题浮起染印章红 + 左侧红书签条 + 按压回弹 + 入场错峰淡入；**整页滚动 + "回到顶部"按钮**（滑过首条 1/3 出现）。
- **筛选**：按 `type`（概念/人物/方法论/事件/板块）与板块标签客户端过滤 `feed-index.json`。
- **无障碍**：尊重 `prefers-reduced-motion`（关闭倾斜/动画）。

### 5.4 搜索
- **打底**：Pagefind（纯静态全文检索，零后端），用其 JS API + 纸感自定义结果样式（参考站 ai-digest.liziran.com 即此方案）。
- **路线（未来）**：叠一层**自然语言/语义检索**——预先给每篇报告算 embedding、产出紧凑向量索引（JSON），查询时在**浏览器内**做相似度匹配，仍无需服务器。第 1 期先把 Pagefind 跑通、预留接口。

### 5.5 部署
- **GitHub Pages**，**公开仓库**。push 触发 **GitHub Action**：在 CI 里跑 Feed Builder（CI 自带 Node）→ 部署 `site/` 到 Pages。
- 本机因此**不需要构建依赖**（本机只跑研究 + push）。
- 域名：先用默认 `*.github.io`，以后可挂自定义域。

## 6. 第 2 期 · 提交 → 审核 → 生产 → 上线

### 6.1 提交表单 + Intake Worker（唯一公开写入口）
- 站内**友好表单**（无需 GitHub 账号）：题目、可选侧重点、提交者邮箱、可选留言。
- 提交 POST 到 **Cloudflare Worker**（免费、无状态、**只入队、绝不触发花钱动作**）。Worker：校验 Cloudflare **Turnstile**（挡机器人）→ 限频（每 IP/邮箱每日上限）→ 输入长度上限/清洗 → 用**受限 GitHub token**（仅能在该仓库建 Issue）创建一条 Issue（标签 `pending`）。

### 6.2 队列与通知
- **GitHub Issues** 即队列；标签做状态机：`pending → approved / rejected → done`。
- 通知走 **GitHub 原生**（建 Issue 即邮件提醒作者），零额外搭建。

### 6.3 审批闸（approve-before-spend）
- **通知**：Worker 建 Issue 时 **@ 作者（或指派给作者）**，确保 GitHub 自动发邮件到作者邮箱（题目即邮件标题）。作者在**手机/电脑**上看 Issue 即可审批，**无需在 Mac 前**。
- 作者看 Issue（只是题目 + 谁提的，**不是报告**），决定 👍 / 👎。
- 同意 = 给 Issue 贴 **`approved` 标签**（**已敲定**；评论 `approve` 作为可选备选）。**额度只从这一刻起才消耗。** 驳回 = 关 Issue，0 花费、0 上线。
- 审批（任意处）与跑研究（Mac 前）**解耦**：可攒几条、回到 Mac 一次性跑。

### 6.4 本机 Runner（一键启动 · 已敲定）
- **不是常驻守护进程，而是「一键启动」**：作者审批后回到 Mac，跑一条命令 `bun run runner`。它：
  1. 用**受限 token** 拉取仓库里 `approved` 且未 `done` 的 Issue（本机无 `gh`，改用 **GitHub REST API + token**，bun 原生 `fetch`）；
  2. 逐条把题目喂给本机 **Claude Code 跑 `/research`**（**轻量档**，见 §6.7）；
  3. 产出三件套写入 `research/`；
  4. commit + push（**复用 SKILL Step 6 的自动上线**）；
  5. 给 Issue 贴 `done`；
  6. 触发 Emailer（§7）。
- **Claude 额度全程不出本机**；研究只在作者开机跑这条命令时发生（"先审后跑"场景足够）。
- 失败/中断要可重入：以 Issue 的 `done` 标签为幂等标记，重跑只处理未完成的。

### 6.5 自动发布（✅ 已实现 2026-06-03）
- Runner 的 push 触发 §5.5 的 Action：自动构建 + 部署，新条目自动出现在信息流。
- **`/research` SKILL 已加 Step 6**：构建门禁（`bun test && bun run web/build/cli.js`）→ 隐私终检 → 精准 `git add 本主题文件夹 + INDEX` → push main → Pages 自动部署。验证：单篇推送后约 16s 线上 200。Runner 直接复用，无需另写发布逻辑。

### 6.6 安全模型（纵深防御）
- 公开面是静态文件（CDN 托管，无服务器可崩）。
- 唯一公开写入口（Worker）：Turnstile + 限频 + 长度上限 + 可选"朋友口令/邮箱白名单"。
- **最强一道：人工审批在花钱之前。** 灌垃圾的最坏后果只是待审列表多几条，一键驳回。
- 兜底：全局**硬预算上限** + 队列长度上限。
- 密钥卫生：Claude API key 永不进任何公开前端；Worker 只持有"仅能建 Issue"的受限 GitHub token。

### 6.7 Token 模型与轻量档（已敲定 · 省 token）

> **🔄 2026-06-03 修正（用户决定）：撤销「轻量研究档」——所有朋友请求一律走全力档，Runner 不再注入任何收敛标记。本节下文及 §10.7 关于「轻量档 / 收敛规模」的内容作废；成本由「审批闸」逐条把控（每条都是完整 `/research`）。**

- **唯一花 Claude 额度的地方 = 跑一次 `/research` 本身。** 其余全是确定性脚本、零 token：
  - 网站/信息流页面/搜索索引 = `web/build/`（bun）确定性套模板生成，**零 token**（M1 已如此）；
  - 报告外壳 `templates/report.html` = 固定文件，纯字符串替换，**零 token**；
  - 报告**内容**由大模型在 `/research` 时**生成一次**，之后永远是静态文件被复用，不反复烧。
- **朋友请求默认走「轻量研究档」**：相对作者自用的「全力档」减少并行子代理数、降低检索轮次、跳过对抗式交叉验证那一层，单条成本明显更低。作者可对个别题目手动升级为全力档。
- **预算兜底**：队列长度上限 + 可选全局硬上限；审批闸已是花钱前的最强闸。
- 实现提示：轻量档可通过 Runner 给 `/research` 传一个"轻量"信号（如 Issue 题目后缀或 runner 参数），SKILL 据此收敛检索/子代理规模——具体在写 plan 时定。

## 7. 第 3 期 · 邮件触达
- 研究 `done` 后，Emailer 给提交者发一封**易读邮件**：核心结论摘要（TLDR + 关键发现）+ 网站链接（可选 PDF 附件），抄送作者。
- 发送方式：先用**已连接的 Gmail**（低量够用）；量大再换专用发信服务（Resend/Postmark）。
- **零 token（已敲定）**：Emailer 是纯 bun 脚本，读**已生成**的 TLDR + 关键发现 + 网址塞进固定模板发出，**不调用大模型**。极简邮件（一句话摘要 + 网站链接，抄送作者）即可——体验好且基本零成本。故"耗 token 就不发"这条规则下：它不耗、可以发。
- 隐私：邮件内容遵守隐私红线，不含任何用户私人信息。

## 8. 贯穿约束（来自 CLAUDE.md，全程适用）
- **隐私红线（绝对）**：任何可导出/公开文档（站点、邮件、来源清单）**绝不写入用户私人信息**；涉买卖/持有用条件化表述。
- **数据完整性**：让数据说话；冲突即修正解读，不为维护结论而扭曲。
- **时间**：所有时点用北京时间。
- **版权 / 中立措辞**：沿用 SKILL 既有规则。
- **信息源优先级 / 五大板块双链**：照旧。

## 9. 技术栈小结
- 站点：静态 HTML/CSS/JS（纸感主题，原生、无框架依赖）。
- 构建：精简脚本（Node/bun，仅 CI）+ Pagefind CLI。
- 托管/CI：GitHub Pages + GitHub Actions（公开仓库）。
- 入口：Cloudflare Worker（免费）+ Turnstile。
- 队列/通知：GitHub Issues。
- Runner：本机 Claude Code + git（本机有 bun，无 node——构建放 CI 规避）。
- 邮件：Gmail（起步）。

## 10. 已敲定的取舍（用户确认的默认）
1. 阅读端**公开**，无口令。
2. 朋友用**站内友好表单**提交（无需 GitHub 账号）。
3. GitHub 仓库**公开**。
4. 邮件先走 **Gmail**。
5. **Runner = 一键启动**（`bun run runner`），非常驻守护进程。（2026-06-03 敲定）
6. **审批 = 加 `approved` 标签**（评论 `approve` 可选备选）。（2026-06-03 敲定）
7. ~~**朋友请求默认走轻量研究档**省 token~~ → **已撤销（2026-06-03，用户决定）：所有请求一律走全力档，成本由审批闸把控。**
8. **发极简邮件**给提交者（纯脚本、零 token），抄送作者。（2026-06-03 敲定）
9. 网站构建与邮件**均为确定性脚本、零 token**；唯一花额度处 = 跑一次 `/research`。（2026-06-03 厘清）
10. **自动上线已实现**：SKILL Step 6（push main → Pages）。（2026-06-03 完成）

## 11. 推迟 / 未来
- **B 模块·云端 runner**：常驻服务/Action 用 Claude API 无人值守跑研究（要 API 计费 + 硬额度闸）。本机版跑顺后再升级，其它单元可复用。
- **自然语言/语义检索**：见 §5.4。
- **PDF 附件**、自定义域名、阅读端口令/白名单：均为可选增强，接口已预留。

## 12. 构建顺序 / 里程碑
- **M1（第 1 期）**：Feed Builder + Feed UI + Pagefind 搜索 + GitHub Pages 上线 → 朋友可浏览/搜索现有 4 篇。
- **M2（第 2 期）**：拆成两段、各自独立可上线（M2 跨多子系统，故分解）：
  - **M2a · 入队闭环**：提交表单（静态页，复用纸感主题）+ Cloudflare Worker（Turnstile + 限频 + 长度上限）+ 建 `pending` Issue + @作者。**验收**：站上提交 → 你邮箱收到通知 + 仓库出现 `pending` Issue，全程 0 花费、0 上线。
  - **M2b · Runner**：`bun run runner` 取 `approved` 未 `done` 的 Issue → `/research` 轻量档 → push（自动上线已做）→ 贴 `done` → 触发 Emailer。**验收**：贴 `approved` → 跑一条命令 → 报告自动上线 + 提交者收到邮件。
  - 顺序：**先 M2a（无花费、可独立验收）再 M2b**。自动发布已在 §6.5 完成。
- **M3（第 3 期）**：Emailer 接 Gmail。

## 13. 验收标准（每期"完成"的定义）
- **M1**：跑一遍构建（CI 或本地 bun 均可），`site/` 能在浏览器打开、信息流呈现全部条目、卡片点进是对应报告、搜索能命中正文、Pages 上线且朋友能访问。
- **M2**：从站内表单提交一个题目 → 作者收到通知 → 贴 `approved` → 本机自动跑出报告并 push → 站点自动更新出现该条目；驳回路径 0 花费。
- **M3**：M2 跑完后提交者收到含摘要 + 链接的邮件。

---

## 14. 项目目录结构（M1 执行前敲定）

为便于 M2/M3 长大后管理，做网站的东西全部归入 `web/`，并预留 `services/` 给后续服务：

```
searchX/
├── research/          # 内容档案（真相源，不动）
├── web/               # 所有"做网站"的东西
│   ├── build/         #   构建脚本 + 测试 + 夹具
│   ├── src/           #   首页模板 + assets/{feed.css,feed.js}
│   └── dist/          #   构建产物（git 忽略，CI/本地生成）
├── services/          # M2/M3：intake worker / runner / emailer（用时再建）
├── docs/              # specs / plans
├── .claude/           # research 引擎（skill）
├── .github/           # 部署 workflow
└── package.json
```

> 注：项目已是 git 仓库，远程 `git@github.com:qiuyuanqr/searchX.git`（公开仓库，项目页 `https://qiuyuanqr.github.io/searchX/`）。
