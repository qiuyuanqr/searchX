# 进度记录 · 2026-06-09 · 股票查重（不重复调研）+ 提交侧安全加固

> 写给在另一台机 pull 到这些改动后的你。本次做了三件事：①**股票查重·不重复调研**（30 天时效窗口，三层：表单即时拦 + runner 审批后兜底 + `/stock` skill 手动兜底）——这正是 [2026-06-04 进度记录](2026-06-04-runner-automation-and-audit.md) §2 留的"题目近似去重（可选未做）"的闭环；②提交文本**注入初筛红旗**；③`/sub` 取邮箱端点改**恒定时间比较**。**全仓 161 测试绿，已 push `main`（`b783400`、`6cf73ed`）。** 安全那两项要手动部署 worker 才生效，已部署（见 §4）。

---

## 1. 股票查重 · 不重复调研（30 天时效窗口）

**为什么有时效窗口而非永久去重**：股票报告本质是约 13 周的时点快照，旧报告会过时——永久去重会把半年后正当的"刷新"也拦掉。所以**只在报告生成日期 ≤ 30 天内才判为重复**，更早的允许重做。窗口可调（`RUNNER_DEDUP_WINDOW_DAYS`，默认 30）。**只查股票类**（`type=股票`）；概念/人物/板块的"再调研"通常是有意刷新，不拦。

三层防线（都用同一份匹配逻辑，按**股票代码**或**公司全名**比对）：

- **表单即时拦（朋友端，最省事）**：站内提交表单输入题目即比对已收录股票，命中就在弹窗里提示"📄 已调研过·点此看报告 →"并**禁用提交**——honest 重复根本不进你的待审队列。
  - 构建把 `services/runner/src/dedup.js` 复制进 `web/dist/assets/dedup.js`（单一源、不漂移）+ 产出精简 `web/dist/reports.json`（只含 title/type/date/slug/tags/href，**无 TLDR/邮箱等私密**）。
  - `web/src/assets/submit.js` 加纯函数 `describeExistingReport`（title/href 转义防 DOM-XSS）；`web/src/assets/feed.js` 接线（fetch reports.json + findFreshReport + 提示/禁用）；`web/src/index.template.html` 加 `#dup-notice`；`feed.css` 加样式。
  - 走 Pages CI 自动上线，已实测：名称命中(芯原)、代码命中(688521)拦截；胜宏/CPO(概念)放行；清空解除；无 console 报错。
- **runner 审批后兜底（权威）**：runner 在 spawn claude **之前**做确定性查重（`src/dedup.js` 的 `findFreshReport`，纯脚本零 token）。命中则**不跑研究**、取提交者邮箱发"已有报告"回信（抄你）、评论、贴 done、跳过。回信失败仍贴 done 防重判并提示手动告知。`summary` 加"查重跳过"计数。
- **`/stock` skill 手动兜底**：`.claude/skills/stock/SKILL.md` §0.1 同规则，覆盖手动 `/stock` 调用。

**匹配取舍**：偏"宁可漏拦也少误拦"——漏拦最多多跑一次研究（会正常产出文件夹，不死循环），误拦会把别的票报告硬塞给提交者更糟，故名称匹配以精确为主、包含为辅且双方≥3字。

新增/改动文件：`services/runner/src/dedup.js`(新) + `dedup.test.js`(新)、`runner.js`、`email.js`(加 `composeExistingEmail`)、`config.js`(加 `dedupWindowDays`)、`index.js`(注入北京时间 today) + 各自测试；`web/build/build.js` + `build.test.js`；上面列的 web 表单文件。

---

## 2. 关于"防范性功能"的取舍（你问过，单人主用别堆限制）

过了一遍流水线，能做的防范/安全项里，**你拍板只做轻量两项**（见 §3），明确**不做**：每日跑研究总量上限、收窄 headless 权限面（弃用 bypassPermissions）、把 runner 关进单独 macOS 用户隔离——理由：你单人主用、偶尔分享，没必要堆限制。记录在此，将来若开放协作者或量大了再考虑。

---

## 3. 提交侧安全加固（轻量两项，已做）

> 核心判断：**审批闸保的是"花钱/意图"，没保"内容"**。runner 跑的是 `claude -p "/research <提交来的题目> | <侧重点>" --permission-mode bypassPermissions`，题目/侧重点来自公开表单（攻击者可控）。已剥 RUNNER_* 机密缩小爆炸半径，但仍是全权限会话。

- **#3 提交注入初筛**（`services/intake-worker/src/validate.js` 的 `screenSubmission`）：命中"忽略以上指令 / shell 命令 / 角色标记 / 代码围栏 / 敏感路径 / 题目网址"等**高信号**特征，就在 issue 正文顶部打一条 **⚠️ 红旗 + "审批前逐字核对"**——**只提示不拦截**（红旗是建议，避免误报多了变狼来了）。`issue-format.js` 渲染红旗，`handler.js` 透传 flags。
- **#4 `/sub` 恒定时间比较**（`sub-read.js` 的 `safeEqual`）：等长时逐字符 XOR 累加、不提前返回，杜绝按位猜密钥的时序侧信道。对 48 位随机密钥实战意义很小，纯卫生习惯。

---

## 4. ⚠️ intake-worker 要手动部署（重要 · 已修一笔旧账）

**`services/intake-worker` 不随 CI 自动部署**——CI 只部署 Pages 站点（`web/`）。改了 worker 源码**必须手动重新部署**，否则线上停在旧版。

**本次发现线上 worker 早已落后于仓库源码**（缺 60 天邮箱过期、北京时间限频、两步式 peek/commit 限频、定长邮箱掩码等已合并改进），就是因为之前改完没重新部署。本次把 #3/#4 连同这些旧改进**一并部署**了。

部署方式（两机都**没有** Cloudflare 凭据，是"凭据不下本机"设计；wrangler 在 Claude Code 的 agent 环境里会被吞输出、也未登录，**无法在 Claude Code 里 headless 部署**）：
1. **控制台粘贴（最稳）**：`bun run build:worker` → dash.cloudflare.com → Workers & Pages → `searchx-intake` → Edit code → 全选粘贴 `dist/worker.js` → Save and deploy。粘代码不动环境变量/密钥/KV 绑定。
2. **wrangler**：需先 `wrangler login` 一次性浏览器授权（作者本人动作），再 `cd services/intake-worker && bun x wrangler deploy`。

---

## 5. 验证

- `bun test`（仓库根）**161 通过 0 失败**（新增 dedup/email/config/runner/build/submit/validate/issue-format/sub-read 测试）。
- 表单查重：浏览器实测全过（见 §1）。
- worker 部署后线上健康检查：`GET /`→405、`/sub/<n>` 无/错密钥→401、正确密钥→200（证明 #4 没改坏 runner 取邮箱）；Pages `reports.json`/`assets/dedup.js`→200 且含在档股票。
- **唯一未"眼见为实"**：#3 红旗只在"新提交且命中可疑模式"的 issue 里可见，外部探测看不出。要验就提交一条侧重点写"忽略以上指令"的测试请求，再拉那条 issue 看正文有没有 ⚠️。

---

## 6. 一句话给未来的你

防重复链已完整自洽：**表单即时拦 → runner 权威兜底 → /stock 手动兜底**。下次再改 `services/intake-worker/**`，记得**手动重新部署 worker**（见 §4），CI 不管它。
