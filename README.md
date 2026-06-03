# searchX

通用深度调研引擎，跑在 Claude Code 上。丢进一个**对象**（概念 / 人物 / 方法论 / 事件 / 板块），它检索、剖析、挖案例，产出离线可读的 HTML 报告 + 来源清单，并在 Obsidian 落一份带双链的笔记。按需触发，不做后台批量。

## 安装

把整个 `searchX/` 放到 `/Users/yangqiuyuan/Coding/`（即 `/Users/yangqiuyuan/Coding/searchX`）。在该目录下启动 Claude Code 即生效——`.claude/skills/research/` 会被识别为 `/research` 命令，`CLAUDE.md` 自动加载为项目约定。

确认：Claude Code 里输入 `/`，应能看到 `research`。

## 用法

```
/research <对象>
/research <对象> | <侧重点>
```

例：
- `/research CPO 共封装光学`
- `/research 液冷服务器 | 哪些 A 股公司真正在出货`
- `/research serenity 选股方法 | 核心逻辑 + 公开可查的代表性持仓`
- `/research GENIUS Act 稳定币法案 | 对算力需求的传导路径`

## 产出

每次调研生成一个主题文件夹：

```
research/<日期>_<主题>/
├── report.html   # 双击用浏览器打开，离线自包含、阅读型成品
├── sources.md    # 全部来源（按可信度排序，带链接和摘要）
├── notes.md      # 给 Obsidian 的精简版
└── data/         # 截图/结构化数据（如有）
```

同时在 `饺子的旷野/Research/<主题>.md` 落一份带 `[[双链]]` 的笔记，自动织进你的板块知识网。

## 已知局限（重要）

- **X/Twitter 时间线拉不全**：免费 API 已关、强反爬。人物类调研给的是"观点体系 + 被引用的代表性言论 + 外界分析"，**不是逐条推文**。报告里会显式标这一条。真要逐条时间线，需另接 X 官方付费 API（见下方扩展）。
- **报告是时间切片**：内容定格在生成那一刻，不自动刷新。要更新就重跑，生成带新日期的新版本，旧版本保留作研究痕迹。

## 以后想加（暂不做）

- **B 模块：接 X 官方付费 API / 第三方数据源**，补全人物时间线。需配 key、在网络层（QClaw/代理）打通，按量付费。等纯检索版用顺了、确有逐条刚需再加。
- **结构化数据接入**：股票类主题接 Tushare 等，把行情/财务一并进报告。

## 改配置

路径、信息源优先级、板块清单在 `CLAUDE.md`；调研流程与产出格式在 `.claude/skills/research/SKILL.md`；报告样式与占位符在 `.claude/skills/research/templates/report.html`。
