# Stocks→searchX 报告同步停用 + 旧报告撤下

时间：2026-11-07 01:10–02:10（北京时间）。由 Stocks 项目会话经用户同意转达，用户随后在本会话里明确要求撤下旧报告。

## 为什么停（用户的理由）

Stocks 的调研 skill 正在根本重做：不再判断涨跌（旧报告 93% 是「震荡」，分不出好坏），改成每只票一份检查清单草稿——上涨靠什么、跟哪些外部因素联动、哪些事件会直接打破这个理由、什么时候该兑现成收入——直接驱动持仓的卖出提醒。公开站导入、追踪的那套方向判断逻辑已经不存在。**主要原因不是要不要公开展示。**

## 做了什么（都已完成）

| 项 | 状态 | 证据 |
|---|---|---|
| Mac mini `com.searchx.stocks-import` 停用 | 已完成 | bootout 后 `launchctl list` 无此项、`launchctl print` 找不到服务；plist 移出 `~/Library/LaunchAgents`，备份在 Mac mini `~/Library/Application Support/searchx-codex-ops/20261107-stocks-import-retired/` |
| 防止被装回后再跑 | 已完成 | `services/stocks-import/scheduled-run.sh` 开头直接退出（`e5ea59e`）；autopull 只拉代码不装 plist |
| 判断档案页行情快照 | 已停更 | `research/_series/prices.json` 只由这条任务刷新，停在 20261106；裁到剩下 3 只票 |
| `stocks-import-*` 三类报警 | 随之停 | 只由该脚本发出 |
| 已发布的 Stocks 报告 | 已撤下（用户决定） | `39c59aa`：删 220 篇 + 19 个 `.dropped` 目录，INDEX 删 220 行；CI 部署 success；GitHub Pages 与 search.qiuyuan.net（site-publisher release 1847）实测旧报告/档案页 404、自有报告 200、`reports.json` 52 篇 |
| 本机积压的 Codex 提交 | 已推送 | `40f0406`（Codex 10-18「会话结束只读检查」，10-25 被收工钩子自动打包）+ 说明提交 `45fcbc3`；后台 runner 调 Codex 时 `features.hooks: False`，不受影响 |
| Stocks 仓库 | 没动 | — |

## 留给以后的注意事项（不是待办，只是说明）

- **恢复导入前必须先改「已导」判据**：导入器靠扫 `research/` 判断哪篇导过，现在一篇都不在，直接恢复会把 Stocks 库里的旧报告整批重新上线。原文仍在 Stocks 库和 git 历史里。
- 剩下 3 个判断档案页（300285 国瓷 / 300476 胜宏 / 688521 芯原，都是 searchX 自己 /stock 的报告）行情停在 2026-11-06，页面写着「数据截至」日期，不会再更新。若以后 searchX 自己的 /stock 还要档案页行情，需要另起一个只刷新行情的任务。
- MacBook 上 Obsidian 里这些报告的私人全文笔记没动。
- Codex 应用里下次开 searchX 可能提示重新信任新的 SessionEnd 命令，需用户点信任。
