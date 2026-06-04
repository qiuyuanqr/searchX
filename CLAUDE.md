# searchX — 项目约定

通用深度调研引擎，并自动上线为公开信息流站。两个核心能力：`/research`（通用调研，`.claude/skills/research/SKILL.md`）与 `/stock`（单只股票深度投研，`.claude/skills/stock/SKILL.md`；research 判定股票类时自动路由）。围绕它有一条半自动流水线（站内提交 → 审核 → runner 自动跑 → 上线 → 邮件），代码在 `services/` 与 `web/`。完整地图见 `README.md`。

## 路径变量（SKILL 引用）

> 两个变量的**本机绝对路径**定义在未入库的 `CLAUDE.local.md`（Claude Code 自动加载、不进公开仓库）。下面只说明用途。

- `ARCHIVE_ROOT` — 调研资产根（仓库内 `research/`）。每次调研在此下建独立主题文件夹（`<YYYY-MM-DD>_<topic-slug>/`），存全部资产。
- `OBSIDIAN_VAULT` — 本机 Obsidian 库根。精简笔记落到其 `Research/` 子目录，带 frontmatter 与 `[[]]` 双链。

## 仓库结构速览

- `.claude/skills/{research,stock}/` — 两个 skill（能力本体 + `research/templates/report.html` 报告模板，stock 复用同模板）。
- `research/` — 调研资产库（= `ARCHIVE_ROOT`），每主题一文件夹（三件套）+ `INDEX.md` 总索引；也是站点数据源。
- `web/` — 信息流站（`src` 源 / `build` 构建逻辑 / `dist` 产物，CI 自动部署）。
- `services/intake-worker/` · `services/runner/` — 半自动流水线（提交 worker / 自动跑研究 + 发信），各有独立 README。
- `docs/` — 开发文档（设计稿 / 计划 / 进度，见 `docs/README.md`）。

## 全局约定（所有任务适用）

- **输出语言**：中文。科技/学术对象优先检索英文一手来源，再用中文消化。
- **信息源优先级**：监管/交易所 ＞ 公司披露/官方 filing ＞ 权威媒体 ＞ 机构研究 ＞ 社区。
- **时间**：所有时点用北京时间。
- **隐私红线（绝对）**：任何可导出文档（HTML / md / 来源清单）中，永远不写入用户私人信息（持仓规模、负债与还款、财务状况、健康、家庭）。涉及买卖/持有用条件化表述。
- **数据完整性**：让数据直接说话；数据与既有结论冲突时立即修正解读，不为维护结论而扭曲。
- **不预设深层意图**：只处理用户明确指定的对象，不擅自外延。
- **X/Twitter 局限**：无法稳定拉取账号完整时间线（免费 API 已关闭+强反爬）。人物类调研主攻被引用/转载/整理的代表性观点与方法论，并在产出中显式声明此局限。

## 五大常关注板块（双链与关联判断用）

光模块 · 机器人 · 算力 · AI应用 · 航天。仅在确有关联时挂 `related` / 双链，不硬凑。
