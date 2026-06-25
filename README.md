# searchX

通用深度调研引擎，跑在 Claude Code 上——给它一个**调研目标**（概念 / 人物 / 方法论 / 事件 / 板块 / 单只股票），它会自动检索、深入分析、挖掘真实案例，产出可离线阅读的 HTML 报告 + 来源清单，同时在 Obsidian 里保存一份带双向链接（`[[双链]]`）的笔记，并**自动发布**到公开信息流站。

🌐 公开站：**https://qiuyuanqr.github.io/searchX/**

围绕这个引擎还配套了一条**半自动流水线**：朋友在站内提交选题 → 作者在手机上一键审核 → 常驻机器自动跑调研 → 自动发布 + 邮件通知。其中只有「跑一次调研」会消耗 Claude 额度，其余环节都是行为固定、不调用 AI 的脚本。

## 仓库结构（各目录职责）

```
searchX/
├── .claude/skills/          ← 三个能力（skill）
│   ├── research/            通用深度调研：SKILL.md + templates/report.html（报告模板）
│   ├── stock/               单只股票深度投研（13 周情景 + 条件触发）；research 判定为股票时自动转交，也可直接 /stock
│   └── factcheck/           事实核查：核实真假 + 讲清原委 + 判断可信度（文本 / 图片 / 链接）；产出仅存本机 Obsidian，不上线
├── research/                ← 调研资产库（ARCHIVE_ROOT，也是站点数据源）
│   ├── INDEX.md             总索引（按日期倒序 + 板块标签，可检索）
│   └── <YYYY-MM-DD>_<主题>/  每次调研一个文件夹：report.html / sources.md / notes.md [+ data/]
├── web/                     ← 信息流站（GitHub Pages，详见 web/README.md）
│   ├── src/                模板源 + 前端资源 + 站点配置
│   ├── build/              构建脚本 + 单测（扫 research/ → 渲染卡片 + 报告页）
│   └── dist/               构建产物（gitignore，CI 部署用）
├── services/                ← 半自动流水线后端
│   ├── intake-worker/      Cloudflare Worker：站内提交 → 建 GitHub pending Issue（详见其 README）
│   └── runner/             常驻机脚本：取 approved Issue → 跑 /research → 上线 → 发信（详见其 README）
├── docs/                    ← 开发文档：设计稿 / 实现计划 / 进度记录（见 docs/README.md）
├── .github/workflows/       deploy.yml：push 动到 research/ 或 web/ 即自动 build + 部署 Pages
├── CLAUDE.md                项目约定（语言 / 信息源 / 时间 / 隐私红线 / 板块）——Claude Code 自动加载
└── setup-macmini.sh         常驻机（Mac mini）一次性环境配置脚本
```

> 路径变量 `ARCHIVE_ROOT`（=`research/`）与 `OBSIDIAN_VAULT` 的本机绝对值在未入库的 `CLAUDE.local.md`。

## 安装

把整个 `searchX/` 放到 `/Users/yangqiuyuan/Coding/`，在该目录下启动 Claude Code 即生效——`.claude/skills/` 下的 skill 被识别为 `/research`、`/stock`、`/factcheck` 命令，`CLAUDE.md` 自动加载为项目约定。确认：输入 `/`，应能看到 `research`、`stock`、`factcheck`。

依赖：跑测试 / 本地构建 / runner 前先 `bun install`。

## 用法

```
/research <对象>
/research <对象> | <侧重点>
/stock <名称或代码>          # 单只股票；research 判定为股票类时也会自动转交给它
/factcheck <待核实内容>       # 事实核查：真假 + 原委 + 可信度（支持文本 / 图片 / 链接）；结果存本机 Obsidian，不上线
```

例：
- `/research CPO 共封装光学`
- `/research 液冷服务器 | 哪些 A 股公司真正在出货`
- `/research serenity 选股方法 | 核心逻辑 + 公开可查的代表性持仓`
- `/stock 蓝思科技 300433`

## 产出

每次调研生成一个主题文件夹，并在 `research/INDEX.md` 置顶追加一行索引：

```
research/<日期>_<主题>/
├── report.html   # 浏览器打开，离线自包含、阅读型成品
├── sources.md    # 全部来源（带链接，按可信度排序）
├── notes.md      # 给 Obsidian 的精简版（带 frontmatter + [[双链]]）
└── data/         # 截图 / 结构化数据（如有）
```

同时在 Obsidian `<OBSIDIAN_VAULT>/Research/<主题>.md` 保存一份带 `[[双链]]` 的笔记，并自动 `git push` 触发 Pages 部署、发布到公开站。

> `/factcheck` 的产出不同：只在本机 Obsidian `<OBSIDIAN_VAULT>/Factcheck/` 存一份核查笔记（真假裁定 + 原委 + 可信度），**不进仓库、不上线**——它是仅供自己看的私人核查档。

## 半自动流水线（朋友提交 → 自动上线）

```
作者：在设置页（admin.html，凭 ADMIN_KEY）把朋友邮箱加进授权名单 → 生成专属链接，私发给本人
   ▼
朋友：用专属链接打开站点（?k=<token>）填表单提交
   │  POST（带 token）
   ▼
intake-worker (Cloudflare)   token 反查邮箱 + 校验 + 安全初筛 + 限频
   ├─ 干净内容 → 建「approved」Issue（自动放行，无需人工）
   └─ 命中安全红旗 → 建「pending」Issue（降级，等作者手动批 ← 仅可疑件需人工）
   ▼
runner (常驻机，每 5 分钟自动跑)   取 approved 未 done → 跑 /research（含自动上线）→ 贴 done → 发结果邮件
   ▼
公开站更新 + 提交者收到「调研完成」邮件（抄送作者）
```

> 授权名单与专属链接由作者在 `admin.html` 管理（凭 `ADMIN_KEY`）。没有专属链接的人无法提交。详见
> [services/intake-worker/README.md](services/intake-worker/README.md)。设计/实现见
> [docs/superpowers/specs/2026-06-23-授权用户自助调研自动放行-设计.md](docs/superpowers/specs/2026-06-23-授权用户自助调研自动放行-设计.md)。

各服务的部署 / 运维 / 环境变量见 [services/intake-worker/README.md](services/intake-worker/README.md) 与 [services/runner/README.md](services/runner/README.md)。

## 本地开发 / 测试

```bash
bun install
bun test            # 全部单测（web 构建 + 两个服务，离线可测）
bun run build       # 本地构建站点到 web/dist（= CI 所跑）
bun run serve       # 构建并本地预览 http://localhost:8080
bun run runner      # 跑一轮 runner（需配 .env，见 services/runner/README.md）
```

## 已知局限（重要）

- **X/Twitter 时间线拉不全**：免费 API 已关闭、反爬严格。人物类调研给出的是「观点体系 + 被引用的代表性言论 + 外界分析」，而不是逐条推文，报告里会明确标注这一点。
- **报告是生成时刻的快照**：内容定格在生成那一刻，不会自动刷新。需要更新就重新跑一次，生成一份带新日期的新版本，旧版本保留下来作为历史存档。
- **股票类不给目标价 / 评级**：只做未来 13 周情景判断 + 条件式触发设计，结论可溯源、可证伪。

## 改配置

| 改什么 | 在哪 |
|---|---|
| 路径 / 信息源优先级 / 板块清单 / 隐私红线 | `CLAUDE.md` |
| 调研流程与产出格式 | `.claude/skills/research/SKILL.md` |
| 股票分析框架（A–M） | `.claude/skills/stock/SKILL.md` |
| 报告样式与占位符 | `.claude/skills/research/templates/report.html` |
| 站点构建逻辑 | `web/`（见 `web/README.md`） |
| 流水线服务 | `services/*/README.md` |
