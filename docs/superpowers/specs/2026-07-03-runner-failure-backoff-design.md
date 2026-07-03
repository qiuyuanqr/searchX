# Runner 失败退避（自动停跑止损）设计

日期：2026-07-03（北京时间）　状态：已实现

## 问题

runner 对「研究未产出」（claude 退出码≠0 或无新文件夹）的 Issue 不贴 `done`、留待重跑。launchd 每 5 分钟一个 tick，一个持续失败的 approved Issue 会被每 tick 全额重跑一次 `claude -p /research`（每次都真实花额度），一整天可烧上百次。已有失败报警邮件（6 小时限频）让作者知情，但没有自动止损。

## 方案权衡

- **A（选定）·连续失败 N 次自动停跑**：本地文件记每 Issue 连续失败次数，达阈值（默认 3，`RUNNER_MAX_FAILURES` 可调）即贴 `done` 停止重跑 + Issue 评论 + 作者「已停跑」专信。止损彻底（成本上限 = N 次全量研究），复用既有 `done` 幂等语义（「核验未过 park 贴 done 停重试」已有先例），零新增 GitHub API 面，GitHub 上留痕可见。
- B·纯指数退避（count + nextRetryAt，封顶 24h）：临时故障可自愈，但永不止损（封顶后每天仍烧一次全量研究直到人工干预），状态只在本机不可见。与「自动止损」目标不符。
- C·退避 + 停跑混合：只省下前 N-1 次重试的间隔（约 1–2 次研究），状态机与测试面翻倍，不值。

## 设计要点

1. **状态**：`~/Library/Application Support/searchx-runner/research-failures.json`（`{"<issue#>": 连续失败次数}`），经注入依赖 `loadFailures`/`saveFailures` 进出 `runOnce`（缺省 `()=>({})`/noop，向后兼容；装配在 `index.js`，按约定不单测）。
2. **止损闸在开跑之前**：issue 循环顶部判 `count >= maxFailures`，达阈值直接走停跑动作，**绝不 spawn claude**。覆盖「上一轮贴 done 失败、计数保留」的重试场景——必须先补止损，不能先烧一次研究。
3. **失败分支就地停跑**：计数 +1 后达阈值立即执行停跑动作，不等下一轮。
4. **停跑动作顺序**：先贴 `done`（真正的止损）→ 成功才清计数、`parked++`、发作者专信（`composeFailureStopNotice`，只发作者、无私人信息、写明恢复方式）、评论。贴 `done` 失败 → 保留计数（下一轮闸口重试停跑）、不发信不评论（每 5 分钟一 tick，重复发就是邮件轰炸；scheduled-run.sh 的 6h 限频报警兜底）、计 `failed`。
5. **连续语义**：研究成功即清零；偶发故障不累计。
6. **修剪**：每轮结束把计数收敛到「仍在 approved 队列中的 Issue」，防状态文件无限膨胀。被人工干预过的 Issue 重新 approved 后从零计数（作者已介入，给新预算）。
7. **恢复方式**：作者移除该 Issue 的 `done` 标签 → 下一轮重新排队（计数已清零，重新有完整预算）。
8. **summary 形状不变**：停跑计入既有 `parked`（语义同「搁置待人工」）；失败轮照计 `failed`（exit 1 触发既有报警链）。

## 改动清单

- `services/runner/src/config.js`：`maxFailures`（`RUNNER_MAX_FAILURES`，默认 3，空/非法/<1 回退）。
- `services/runner/src/email.js`：`composeFailureStopNotice`。
- `services/runner/src/runner.js`：`stopRetrying` 助手 + 循环顶部止损闸 + 失败分支计数/就地停跑 + 成功清零 + 收尾修剪持久化。
- `services/runner/src/index.js`：`loadFailures`/`saveFailures` 装配。
- 同名 `*.test.js` 各自新增用例（TDD，先红后绿）；`services/runner/README.md`、`scheduled-run.sh` 注释同步。
