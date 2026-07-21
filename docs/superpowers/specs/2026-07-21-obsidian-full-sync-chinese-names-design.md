# Obsidian 同步：全文 + 中文文件名

**日期**：2026-07-21　**状态**：已定稿（无人值守自主执行）

## 背景与需求

`/research`、`/stock` 每次调研在 `research/<日期>_<slug>/` 落三件套（`report.html` 全文、`sources.md`、`notes.md` 精简），并把 **精简版 `notes.md`** 复制到 Obsidian（`<OBSIDIAN_VAULT>/Research/<英文 slug>.md`）。用户反馈两点：

1. Obsidian 里同步的内容太简单（只是概要），**要同步完整全文**。
2. Obsidian 里文件名都是英文/拼音 slug，**要改成中文**方便查看。

## 关键约束（不能碰）

- **网站数据源是 `research/<folder>/notes.md` + `report.html`**（`web/build/scan.js` 只读仓库内文件，**从不碰 Obsidian**）。所以：
  - `notes.md` 内容、格式**保持不变**（首页卡片/tldr 抽取依赖它）。
  - 归档**文件夹 slug 保持英文**（它是公开站 URL `r/<slug>/`，改了会断链）。
- 本次改动只影响 **Obsidian 一侧的文件**（本地，仓库外）。网站零改动。
- 私有路径 `OBSIDIAN_VAULT` 定义在未入库的 `CLAUDE.local.md`，**不得硬编码进任何入库文件**——脚本一律通过参数/环境变量接收库路径。

## 范围

- **In**：research + stock（两者共用 research Step 5 落 Obsidian）。
  1. 建一个 `report.html + notes.md → 完整 Obsidian Markdown` 的转换器。
  2. **存量回填**：把现有 40 个归档文件夹全部生成「中文名 + 全文」的 Obsidian 笔记，删掉旧的 36 个英文名精简笔记。
  3. **前向**：改 research SKILL Step 5 / stock §5，以后新调研落 Obsidian 用转换器出全文 + 中文名。
- **Out**：factcheck（用户未提，本就是全文、存 `Factcheck/` 子目录）；网站/notes.md/文件夹 slug 一律不动。

## 转换器（`scripts/report-to-obsidian.js`，无依赖）

report.html 是固定模板产物，标签集有界且**块级不嵌套**（列表不套列表；仅 `div.case/callout/limitation` 内含 p/ul）。故用一个**无第三方依赖**的小型 DOM 解析 + 渲染器（CI `bun install --frozen-lockfile` 免锁文件改动、`bun test` 可跑，且不依赖 pandoc）。

**输入**：一个归档文件夹（读其 `report.html` + `notes.md`）。
**输出**：一段完整 Obsidian Markdown：

```
---
<notes.md 的 frontmatter 原样搬运>   # 保留 date/created/type/tags/related([[…]])/source_count/archive
---

# <report h1 标题>
> **核心结论** <TLDR>
## 先说人话
<plain>
## 关键发现
- …
<正文全文：h2/h3→##/###，p、ul/ol、table→GFM 表、
 div.case→> [!example] 案例、div.callout→> [!note]、div.limitation→> [!warning] 数据局限>
## 名词小抄
- **术语**：解释
## 风险与争议
- …
## 来源清单
1. [类型] [标题](url) — 日期 — 摘要
## 关联笔记
<从旧 notes.md 收集的所有 [[…]] 双链（去重、去掉已在 frontmatter 的），保证 Obsidian 图谱不掉边>
```

- frontmatter 取自 `notes.md`（`gray-matter` 已是 devDependency），保证 `related` 板块双链与 tags 不丢。
- 正文取自 `report.html`（唯一的全文来源）。
- report.html 无 `[[]]`，为不丢图谱边，把旧 `notes.md` 里的 `[[…]]` 收集进「## 关联笔记」。
- 行内：`a→[]()`、`strong/b→**`、`em/i→*`、`code→\``、`small.src-note` 取纯文本、表格单元格内 `<br>` 原样保留（Obsidian 表格内可渲染）、实体解码。

**导出**：纯函数（`parseHtml`/`renderInline`/`renderBlocks`/`extractReport`/`collectWikilinks`/`buildObsidianNote`）+ `writeObsidianNote({folder, vaultResearchDir, name})`。CLI：`bun run scripts/report-to-obsidian.js <folder> --vault <VAULT> --name "<中文名>"`。测试 `scripts/report-to-obsidian.test.js`（内联 fixture，CI 可跑、hermetic）。

## 中文文件名

- 来源：`research/INDEX.md` 的「对象」列（人工维护、已是中文可读，如 `海光信息 688041.SH`、`CPO 共封装光学`）。回填按「文件夹」列匹配；前向由 skill 传入它写进 INDEX 的同一「对象」名。
- 消毒：`/`→`／`、ASCII `:`→`：`、去掉 `\ * ? " < > |`、并列空白折叠。
- 冲突：同名（如「国瓷材料」研究过两次）→ 各自追加 ` · <日期>` 去重，**两份都留**（不丢信息）。

## 回填（`scripts/backfill-obsidian.js`，一次性本地）

1. 先把 `<VAULT>/Research/` 整体备份到 scratchpad（安全网）。
2. 遍历 `research/*/`（含 3 个 runner 产出、从未落 Obsidian 的：燃气轮机行业 / 江丰电子 / 经纬辉开），跳过缺 `report.html` 或 `notes.md` 的。
3. 每个：从 INDEX 取中文名（冲突加日期）→ 转换 → 写 `<VAULT>/Research/<中文名>.md`。
4. 删除旧英文名文件：仅删「slug == 该文件夹 slug」的那些（36 个），不碰其它无关笔记。孤儿/未映射一律只记录不删。

## 前向（SKILL 改动）

- **research SKILL Step 5**：落 Obsidian 从「复制精简 notes.md」改为「跑转换器出全文 + 中文名」。保留库路径护栏（找不到 `OBSIDIAN_VAULT`/根不存在→无人值守跳过、不猜、不写仓库、不改 CLAUDE.local.md；仅 `Research/` 缺则 `mkdir -p`）。`notes.md` 仍照写进归档文件夹（网站要）。
- **stock §5**：继承 research Step 5，注明 Obsidian 文件名用中文对象名（与 INDEX「对象」列一致）。
- runner（Mac mini）挂不到外置 SSD 库，Obsidian 步本就 no-op，不受影响。

## 验证与上线

- `bun test` 全绿；`bun run build` 全绿（证明网站零影响）。
- 抽查若干中文笔记：全文完整、中文名、frontmatter/图谱双链在、无横向溢出的表格。
- 无孤儿旧文件；入库文件不含私有路径。
- 提交并推送**代码改动**（转换器 + 回填脚本 + 两个 SKILL + 本 spec）到 `main`——即用户说的「上线」。`.claude/skills/**`、`scripts/**` 不在 deploy.yml 路径过滤内，不触发站点重建（符合预期，网站不动）。Obsidian 库迁移是本地动作、已在回填时完成。
```
