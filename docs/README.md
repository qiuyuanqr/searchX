# docs — 开发文档

**切换审批入口**：[Codex 后台切换步骤](maintenance/CODEX_RUNTIME_SWITCH.md) — 先同步代码并保持停用，单条生产及周期启用分别验收。

**当前维护入口**：根 [HANDOFF.md](../HANDOFF.md)、[项目背景与维护上下文](maintenance/PROJECT_CONTEXT.md)、[2026-10-02 Codex 接管证据](progress/2026-10-02-codex-takeover.md)。旧设计/计划/进度保留原文；当前状态与已标出的冲突先看这三个文件。

存 searchX **自身**的开发过程文档（与 `research/` 的调研产出无关）。

> **动手改代码前先读 [ARCHITECTURE.md](ARCHITECTURE.md)**——全仓库架构决策与维护手册（系统全景 / 设计决策 / 高危区 / 技术债 / 隐蔽陷阱 / 耦合点 / 维护守则）。

| 子目录 | 放什么 | 来源 |
|---|---|---|
| `superpowers/specs/` | 设计稿（spec）：动手前对齐的方案 | brainstorming skill 默认输出路径 |
| `superpowers/plans/` | 实现计划（implementation plan）：拆好的执行步骤 | writing-plans skill 默认输出路径 |
| `progress/` | 进度记录 / 审计：某次大改的过程与结论留痕 | 手写 |
| `backlog/` | 待办清单：审查/评估产出的、尚未动手的优化项 | 手写 |

> `superpowers/` 这层命名来自 superpowers 插件——它的 brainstorming / writing-plans 默认就把产出写到 `docs/superpowers/{specs,plans}/`。保留原路径，未来 skill 产出会自动存到对应目录、无需搬运。

## 现有文档（按时间）

**设计稿（specs）**
- [2026-10-03 Codex 后台迁移：实测现状与方案](superpowers/specs/2026-10-03-codex-runtime-migration-design.md) — 固定 6.1 Sol / 至少 high；Stocks 导入已接住 Codex 报告，两条 searchX runner 尚待迁移
- [2026-06-03 searchX 网站化设计稿](superpowers/specs/2026-06-03-searchx-website-design.md)
- [2026-06-04 股票深度分析 skill 设计](superpowers/specs/2026-06-04-stock-analysis-skill-design.md)
- [2026-06-06 上线前独立核验设计](superpowers/specs/2026-06-06-上线前独立核验-设计.md)
- [2026-06-23 授权用户自助调研、自动放行设计](superpowers/specs/2026-06-23-授权用户自助调研自动放行-设计.md)
- [2026-06-25 事实核查 skill 设计](superpowers/specs/2026-06-25-事实核查-skill-设计.md)
- [2026-06-25 事实核查手机入口设计](superpowers/specs/2026-06-25-事实核查-手机入口-设计.md)
- [2026-06-27 factcheck 图片上传（手机入口阶段2）设计](superpowers/specs/2026-06-27-factcheck-image-upload-design.md)
- [2026-06-27 首页与详情页重设计](superpowers/specs/2026-06-27-首页与详情页重设计-设计.md)
- [2026-07-02 核查任务状态与结论回显设计](superpowers/specs/2026-07-02-核查任务状态与结论回显-设计.md)
- [2026-07-02 factcheck 接入 akshare 行情核准设计](superpowers/specs/2026-07-02-factcheck接入akshare行情核准-设计.md)
- [2026-07-03 Runner 失败退避（自动停跑止损）设计](superpowers/specs/2026-07-03-runner-failure-backoff-design.md)
- [2026-07-06 factcheck 网页查看结果设计](superpowers/specs/2026-07-06-factcheck网页查看结果-设计.md)
- [2026-07-21 Obsidian 全文同步 + 中文文件名设计](superpowers/specs/2026-07-21-obsidian-full-sync-chinese-names-design.md)

**实现计划（plans）**
- [2026-10-03 Codex 后台隔离测试计划](superpowers/plans/2026-10-03-codex-runtime-isolated-test.md)
- [2026-06-03 M1 · 信息流站](superpowers/plans/2026-06-03-m1-feed-site.md)
- [2026-06-03 M2a · 提交入队流程](superpowers/plans/2026-06-03-m2a-intake-loop.md)
- [2026-06-03 M2b · Runner](superpowers/plans/2026-06-03-m2b-runner.md)
- [2026-06-23 授权用户自助调研、自动放行](superpowers/plans/2026-06-23-授权用户自助调研自动放行.md)
- [2026-06-25 事实核查手机入口阶段1](superpowers/plans/2026-06-25-事实核查-手机入口-阶段1.md)
- [2026-06-27 首页与详情页重设计](superpowers/plans/2026-06-27-首页与详情页重设计.md)
- [2026-07-06 factcheck 网页查看结果](superpowers/plans/2026-07-06-factcheck网页查看结果.md)

**进度记录（progress）**
- [2026-10-03 Codex 执行层隔离测试](progress/2026-10-03-codex-runtime-tests.md) — 真实模型、图片、Stocks、失败边界与生产未迁移事项
- [2026-06-04 自动 runner + 全项目审计修复](progress/2026-06-04-runner-automation-and-audit.md)
- [2026-06-09 股票查重（不重复调研）+ 提交侧安全加固](progress/2026-06-09-dedup-and-intake-hardening.md)
- [2026-08-16 机器质检补第二条腿：联网数字回链核验](progress/2026-08-16-web-number-verification.md) — 挂了外链的数字回到那页搜一遍；不是闸，只出待质证清单喂给 Step 5.5
- [2026-09-18 research skill 审查：核查路径修 4 处 + PDF 抓取兜底](progress/2026-09-18-research-skill-audit.md) — runner 半成品崩溃 / 数字粘连 / billion 口径 / --strict 闸；Mac mini 装 poppler、cninfo https 403 改走 http
- [2026-09-23 质检补「位置式触发价位」+ 09-18 数字核查修复实效核对](progress/2026-09-23-position-price-redline.md) — 「股价回到成本 X 元上方」类漏网写法入质检与导入改写器，存量 11 篇真违规已改；09-18 修复实测生效但带出 3 条假命中（待修）

**待办（backlog）**
- [2026-07-04 全项目审查 · 优化建议待办](backlog/2026-07-04-audit-suggestions.md) — 31 条建议 + 3 UI 实测，三档分级，已全部完成，存档
- [2026-07-07 架构盘点 · 修复清单](backlog/2026-07-07-architecture-audit-fixes.md) — ARCHITECTURE.md 盘点出的 6 bug + 2 技术债，已全部完成，存档
