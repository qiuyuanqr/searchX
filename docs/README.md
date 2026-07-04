# docs — 开发文档

存 searchX **自身**的开发过程文档（与 `research/` 的调研产出无关）。

| 子目录 | 放什么 | 来源 |
|---|---|---|
| `superpowers/specs/` | 设计稿（spec）：动手前对齐的方案 | brainstorming skill 默认输出路径 |
| `superpowers/plans/` | 实现计划（implementation plan）：拆好的执行步骤 | writing-plans skill 默认输出路径 |
| `progress/` | 进度记录 / 审计：某次大改的过程与结论留痕 | 手写 |
| `backlog/` | 待办清单：审查/评估产出的、尚未动手的优化项 | 手写 |

> `superpowers/` 这层命名来自 superpowers 插件——它的 brainstorming / writing-plans 默认就把产出写到 `docs/superpowers/{specs,plans}/`。保留原路径，未来 skill 产出会自动存到对应目录、无需搬运。

## 现有文档（按时间）

**设计稿（specs）**
- [2026-06-03 searchX 网站化设计稿](superpowers/specs/2026-06-03-searchx-website-design.md)
- [2026-06-04 股票深度分析 skill 设计](superpowers/specs/2026-06-04-stock-analysis-skill-design.md)
- [2026-06-06 上线前独立核验设计](superpowers/specs/2026-06-06-上线前独立核验-设计.md)
- [2026-06-23 授权用户自助调研、自动放行设计](superpowers/specs/2026-06-23-授权用户自助调研自动放行-设计.md)
- [2026-06-25 事实核查 skill 设计](superpowers/specs/2026-06-25-事实核查-skill-设计.md)
- [2026-06-25 事实核查手机入口设计](superpowers/specs/2026-06-25-事实核查-手机入口-设计.md)
- [2026-06-27 首页与详情页重设计](superpowers/specs/2026-06-27-首页与详情页重设计-设计.md)
- [2026-07-02 核查任务状态与结论回显设计](superpowers/specs/2026-07-02-核查任务状态与结论回显-设计.md)
- [2026-07-02 factcheck 接入 akshare 行情核准设计](superpowers/specs/2026-07-02-factcheck接入akshare行情核准-设计.md)

**实现计划（plans）**
- [2026-06-03 M1 · 信息流站](superpowers/plans/2026-06-03-m1-feed-site.md)
- [2026-06-03 M2a · 提交入队流程](superpowers/plans/2026-06-03-m2a-intake-loop.md)
- [2026-06-03 M2b · Runner](superpowers/plans/2026-06-03-m2b-runner.md)
- [2026-06-23 授权用户自助调研、自动放行](superpowers/plans/2026-06-23-授权用户自助调研自动放行.md)
- [2026-06-25 事实核查手机入口阶段1](superpowers/plans/2026-06-25-事实核查-手机入口-阶段1.md)
- [2026-06-27 首页与详情页重设计](superpowers/plans/2026-06-27-首页与详情页重设计.md)

**进度记录（progress）**
- [2026-06-04 自动 runner + 全项目审计修复](progress/2026-06-04-runner-automation-and-audit.md)
- [2026-06-09 股票查重（不重复调研）+ 提交侧安全加固](progress/2026-06-09-dedup-and-intake-hardening.md)

**待办（backlog）**
- [2026-07-04 全项目审查 · 优化建议待办](backlog/2026-07-04-audit-suggestions.md) — 31 条建议 + 3 UI 实测，三档分级，未动手
