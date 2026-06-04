# 进度记录 · 2026-06-04 · 自动 runner + 全项目审计修复

> 给「另一台机 pull 后」的你看。本次会话从手机发起，做了三件事：①把"审批即自动跑"落地（launchd 定时 runner）；②加"给作者发当日汇总邮件"；③对全项目做三方代码审计并修掉真 bug。**测试 91 全绿，已 push 到 `main`。**

---

## 1. 本次新增能力

### A. 本地「审批即自动跑」（launchd 定时 runner）
- **装在 Mac mini**：LaunchAgent `com.searchx.runner`，**每 15 分钟**自动 `bun run runner`。
  - 包装脚本 `services/runner/scheduled-run.sh`（补 PATH、cd 仓库根、落日志）。
  - plist 模板 `services/runner/launchd/com.searchx.runner.plist`（`StartInterval=900`、`RunAtLoad=false`）。
  - 已 `launchctl bootstrap`+`enable`，`launchctl print` 确认 loaded。
  - 日志：`~/Library/Logs/searchx-runner/runner.log`。
- **从此你只需在手机上给 Issue 贴 `approved`**，≤15 分钟 Mac mini 自动跑全力档 `/research` → 上线 → 发信。人不用守电脑。
- **手机随时立刻跑**：`bun run runner:now`（= `launchctl kickstart`，与定时器共用同一把锁、绝不撞车）；`bun run runner:log` 看日志。
- 前提：Mac mini 保持开机 / 不休眠 / 已登录 GUI。

### B. 作者当日汇总邮件（每完成一篇单独通知你）
- 每成功完成一篇，除了给提交者发结果邮件（你被抄送）外，**单独再给你 Gmail 发一封**：写明①完成了什么（主题+链接）②今天累计完成几篇（按**北京时间**分日计数，跨天归零）。
- 代码：`composeAuthorDigest`（`services/runner/src/email.js`）+ 计数 `bumpDailyCount`（`src/index.js`，计数文件 `~/Library/Application Support/searchx-runner/daily-<日期>.count`）。
- 只含公开信息，**不含提交者邮箱**等隐私。

### #3 实跑结果（活验证通过）
- 朋友的 Issue **#3《左侧交易和右侧交易的区别》** 已端到端跑通：报告上线 `https://qiuyuanqr.github.io/searchX/r/2026-06-04_left-side-vs-right-side-trading/`（HTTP 200）、Issue 贴 `done`、提交者收到结果邮件、**作者汇总邮件已发到 qiuyuanqr@gmail.com**。
- 注：#3 是用旧代码起跑的，作者汇总是我手动补发的；从下一篇起全自动带上。今日计数已 seed=1。

---

## 2. 关于"重复跑"的结论（你问过）
- **同一条申请绝不会跑两遍**：`done` 标签幂等 + 全局锁，已完成的永远被过滤。
- **但"重新提交"是另一条新 Issue**：系统按 Issue 编号+`done` 去重，**不按题目文字**。同题重交需你**再次贴 `approved`** 才会再跑、产出第二篇。不审批就不会重复。
- 跑的途中再手动催 = 被锁挡掉跳过，不会叠第二个进程。
- （可选未做）"题目近似去重"：提交时若已有相同已完成报告就提醒你，由你决定要不要还批——需要再说。

---

## 3. 三方代码审计 + 修复（本次重点）
对 runner / intake-worker / web 构建 / 两机 git-sync / 部署做了审计，**已修的真 bug**（都带测试）：

| 级别 | 问题 | 修法 | 状态 |
|---|---|---|---|
| 🔴Critical | **git-sync `--autostash` 弹回冲突绕过"冲突即回滚"**：rebase 成功但 autostash pop 冲突时退出码仍 0 → 冲突标记被 `add -A` 提交推上**公开仓**、本地改动困死孤儿 stash（已复现） | pull 后显式检测未合并条目 → `reset --hard` 恢复干净 + 改动保留在 stash + 报警，绝不继续推 | ✅已修 |
| 🔴Critical | **收工 `git add -A`** 可能把机密/临时文件推上公开仓 + 与 SKILL"绝不 -A"红线冲突 | 提交前两道终检闸：暂存含冲突标记 / 命中机密文件名（`.env`/`*.key`/`secret`/`token`/`持仓`等）即中止 | ✅已修 |
| 🔴Critical | **runner 锁 TOCTOU**：占位后写 pid 前的窗口被第二个 runner 误判残留锁强占 → 两 runner 并发（已复现） | 改 `O_EXCL` 原子文件锁 + 即写 pid；回收策略改保守 | ✅已修 |
| 🟠High | 定时 runner 锁不覆盖 git-sync 钩子/嵌套会话 → 三方抢同一工作树、误判产出/发错邮件 | runner 跑研究期间（哨兵 `SEARCHX_IN_RUNNER` 或持锁）git-sync 自动跳过 | ✅已修 |
| 🟡Medium | `.env` 机密被继承进全权限 `claude -p` 会话环境 | spawn 时剥离所有 `RUNNER_*` 变量 | ✅已修 |
| 🟡Medium | intake-worker 限频用 **UTC** 日，违反"北京时间"约定 | `dayKey` 改 `Asia/Shanghai` | ✅改码，**待重部署** |
| 🟢Low | 限频键未编码（IPv6/含`:`邮箱污染键）；maskEmail 用 `*` 个数泄露本地名长度、单字符不打码；已发信后评论失败被误报"发信失败" | 键 `encodeURIComponent`；定长掩码；评论单独 try/catch | 前两项改码**待重部署**；评论项✅已修 |

**已评估、有意暂不改（避免破坏现有流水线，留给你定）：**
- 🟠**提示注入**：朋友可控的题目/侧重点会喂给 `claude -p --permission-mode bypassPermissions`。已用"剥离机密环境"缩小爆炸半径，主闸仍是**你的人工审批**——审批时请**通读"侧重点"全文**（注入文字常藏这里）。彻底降权（改非全权限模式）可能破坏 /research 自动上线，需你在场测过再动。
- 硬编码 `/Users/yangqiuyuan/...` 路径（plist/setup）：你在 `setup-macmini.sh` 里本就有意写死，属已接受状态，未改。

---

## 4. ⚠️ 还需你做的一件事：重部署 intake-worker
限频改北京时间、键编码、maskEmail 定长这几处改的是 **worker 源码**，要重部署才在线上生效（当前线上 worker 照常工作，只是这几个 Medium/Low 问题暂存）。**在场时一条命令**（已知该 worker 用 v3 + 清 agent 环境变量）：

```bash
cd services/intake-worker
env -u CLAUDECODE -u AI_AGENT -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_AGENT_SDK_VERSION bun x wrangler@3 deploy
```
> 我这边无人值守部署失败：非交互环境缺 `CLOUDFLARE_API_TOKEN`（你交互式 oauth 登录即可，或设该环境变量）。`dist/worker.js` 已重新打好。

---

## 5. 当前状态总览
- 测试：**91 全绿**（`bun test`）。
- 已 push `main`：`a63451e fix(runner+sync): 修审计发现的并发/安全/隐私缺陷`（含本进度文档的提交随后）。
- 自动流水线：**M1+M2a+M2b 上线运营 + 本地 launchd 定时 runner 已就位**。
- 待办：①在场重部署 worker（见 §4）；②（可选）题目去重、提示注入降权——需你拍板。
