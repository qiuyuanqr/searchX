# searchX

通用深度调研引擎，跑在 Claude Code 上——丢进一个**对象**（概念 / 人物 / 方法论 / 事件 / 板块 / 单只股票），它检索、剖析、挖案例，产出离线可读的 HTML 报告 + 来源清单，在 Obsidian 落一份带双链的笔记，并**自动上线**到公开信息流站。

🌐 公开站：**https://qiuyuanqr.github.io/searchX/**

围绕这个引擎还长出一条**半自动流水线**：朋友在站内提交选题 → 作者手机上一键审核 → 常驻机自动跑调研 → 自动上线 + 邮件通知。花 Claude 额度的只有「跑一次调研」本身，其余全是确定性脚本。

## 仓库结构（各目录职责）

```
searchX/
├── .claude/skills/          ← 两个核心能力（skill）
│   ├── research/            通用深度调研：SKILL.md + templates/report.html（报告模板）
│   └── stock/               单只股票深度投研（13 周情景 + 条件触发）；research 判定股票时自动路由，也可直接 /stock
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

把整个 `searchX/` 放到 `/Users/yangqiuyuan/Coding/`，在该目录下启动 Claude Code 即生效——`.claude/skills/` 下的 skill 被识别为 `/research`、`/stock` 命令，`CLAUDE.md` 自动加载为项目约定。确认：输入 `/`，应能看到 `research`、`stock`。

依赖：跑测试 / 本地构建 / runner 前先 `bun install`。

## 用法

```
/research <对象>
/research <对象> | <侧重点>
/stock <名称或代码>          # 单只股票；research 判定为股票类时也会自动路由到它
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

同时在 Obsidian `<OBSIDIAN_VAULT>/Research/<主题>.md` 落一份带 `[[双链]]` 的笔记，并自动 `git push` 触发 Pages 部署、上线到公开站。

## 半自动流水线（朋友提交 → 自动上线）

```
朋友：站内表单 submit.html
   │  POST
   ▼
intake-worker (Cloudflare)   人机验证 + 校验 + 限频 → 建 GitHub「pending」Issue + 私存提交者邮箱
   ▼
作者：手机上给 Issue 贴「approved」          ← 唯一人工闸，也是唯一花 Claude 额度的开关
   ▼
runner (常驻机，每 15 分钟自动跑)   取 approved 未 done → 跑 /research（含自动上线）→ 贴 done → 发结果邮件
   ▼
公开站更新 + 提交者收到「调研完成」邮件（抄送作者）
```

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

- **X/Twitter 时间线拉不全**：免费 API 已关、强反爬。人物类调研给的是「观点体系 + 被引用的代表性言论 + 外界分析」，不是逐条推文，报告里会显式标注。
- **报告是时间切片**：内容定格在生成那一刻，不自动刷新。要更新就重跑，生成带新日期的新版本，旧版本保留作研究痕迹。
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
