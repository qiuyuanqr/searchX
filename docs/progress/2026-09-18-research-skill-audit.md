# 进度记录 · 2026-09-18 · research skill 审查：核查路径修 4 处 + PDF 抓取两处兜底

> 写给在另一台机 pull 到这些改动后的你。本次审的是 `/research` 这个 skill 的**代码实现与事实核查路径**（Step 5.4 / 5.5 用到的脚本、runner 的接线），不是报告内容。结论：SKILL 流程文字与代码接线一致，没有"文档说有、代码没有"的断裂；问题全在核查工具本身。落在 `main` 的三个提交：`7f7b5c5`（四处修复）、`91909c5`（外部程序定位兜底）、`e2cb7a0`（https 403 → http）。**全仓 1218 测试绿**；存量 175 篇 `research-qc --strict` 仍全过。同日另一会话并行审了 factcheck（`3fd5930`），两边按文件分开提交、互不混入。

---

## 1. 修了什么（每条都有复现与测试）

| # | 位置 | 缺陷 | 复现证据 | 修法 |
|---|---|---|---|---|
| 1 | `services/runner/src/runner.js` | 产出目录缺 `notes.md`、或 park 时只写了 `.parked` 没写 `.parked.json`，`entry.href` 对 undefined 取值抛 TypeError：整轮中止、exit 1 报警、Issue 不贴 done、失败计数不加，下一 tick 全额重跑，每 5 分钟烧一次直到人工干预。代码注释写着"缺 notes.md 半成品、重跑能好"，但没有对应分支 | 用桩依赖跑 `runOnce`，两种情形都抛 | 先取 `entry`，取不到走失败重跑分支；带 `.parked` 无信号的合成一个搁置信号走原有 park 流程（贴 done + 通知作者） |
| 2 | `scripts/check-web-numbers.js` `normalizePage` | 删掉**全部**空白，PDF 与英文表格里只隔空白的相邻数字粘成一串（`3,016,714,649.182,573,139,460.90`），数字边界卡不住、`pageNumbers` 抽成怪数 | 英维克半年报 PDF：1826 个独立成行的小数里 **87%** 原样搜不到，全部退成弱档「换算命中」；英文页「2024 2025 108.96 61.7」直接漏判。测试文件里早有一条注释承认这一点，只在测试里绕开 | 只在两个数字之间保留一个空格，其余空白照删。改后同一份 PDF 漏判 **0%** |
| 3 | `scripts/check-web-numbers.js` | 亿/万 只换算成 万元/千元/元，没有英文 billion/million 候选。SKILL 明写科技类优先英文一手来源 | nvidia 那篇实跑 14 条「搜不到」里 200 亿美元（$20 billion）/ 32 亿 / 40 亿 / 1300 万颗 都是这一形态 | 新增 `unitWordPatterns`：亿→billion/million，万→million/thousand，**必须带单位词**才算命中；单字母 B/M/K 只认 `$` 前缀或后接非字母（防「13 months」）；量级比对那档刻意**不加**这些倍数（它不读单位）。nvidia 那篇：已找到 34 → 39，待质证 14 → 9 |
| 4 | `scripts/research-qc.js` `--strict` | 质检本身没跑成（如 report.html 读不到）退出 0，Step 6 拿它当 push 前的闸，等于检查器炸了也放行 | `--dir 不存在 --strict` 退出码 0 | 新增 `strictShouldFail`：`!qc.ok` 同样非零退出；`.dropped` 的仍放行。SKILL Step 6 口径同步 |

## 2. 装 poppler 顺带发现的两件事（`91909c5` / `e2cb7a0`）

- **Mac mini 没装 `pdftotext`**，runner 那台机器上所有巨潮公告 PDF 一律「未测」，而披露级来源正是最该核的。已装（poppler 26.09.0）。`ssh mac-mini 'brew install poppler'` 会报 brew 找不到，因为非交互 ssh 只有系统 PATH（`/usr/bin:/bin:/usr/sbin:/sbin`），要用 `/opt/homebrew/bin/brew` 全路径。runner 自己的 `scheduled-run.sh` 早补了 `/opt/homebrew/bin`，定时任务不受影响；脚本里加了 `resolveBin`（先 PATH，再 Homebrew 固定路径，`SEARCHX_PDFTOTEXT` / `SEARCHX_ICONV` 可强制指定）给其它启动方式兜底。
- **巨潮 `static.cninfo.com.cn` 对 Mac mini 的 https 回 403、http 正常**（MacBook 两者都通）。`fetchPage` 加了「https 且 403 → 换 http 再试一次」，只降一次、结果 `note` 写明走了 http。代价：http 没有传输层完整性保证；本模块不是闸、只判「报告数字在不在页内」，被篡改成恰好等于报告数字的概率可忽略。Mac mini 裸 PATH 下用原 https 链接实跑：145,333 字符、营收数字原样命中。

## 3. 只是说明、没改（要知道的局限）

- **5.4b 的归属是段落级不是链接级**：一段挂了几条链接，数字在其中任一页出现就算找到。正确来源与挂错的来源在同一段时，「挂错」它看不出来。SKILL 5.4c 已补这个前提。
- runner 的查重只对股票类生效，非股票只靠 SKILL Step 0.5 读 INDEX 由模型自判，与代码一致，没有兜底。
- `check-sources.js` 报的 8 条「报告引了但清单缺」全在 stocks-import 导入的篇目（报告引的公告 PDF 编号与清单里的不同），不是 research skill 产出；stocks-import 那条链路没跑 check-sources。
- `research-qc.js` 文件头写的 `--all` 参数 `main()` 并不解析，不带 `--dir` 就是全量，效果一样。

## 4. 待办

1. 下一篇真跑 `/research`（非股票）时看 Step 5.4b 的质证清单是否明显变短、PDF 来源是否不再「未测」——目前只在 nvidia 那篇与英维克 PDF 上对过账，没有新产出的端到端验证。
2. stocks-import 那条链路要不要也跑 `check-sources`，那 8 条缺失是否该在导入时补进 sources.md——用户决策。
3. 5.4b 若要做到链接级归属，得改 `blocksWithLinks` 按 `<a>` 的最近邻切块，代价是数字与链接的绑定会更脆；现阶段不动。

## 5. 并行会话的教训

两个会话共用一个工作树时，`SessionEnd` 钩子的 `git add -A` 会把对方未提交的改动扫进自己的提交。本次做法：改动只落工作树、不提交、不关会话，等对方收工后按文件精准 `git add`。已记进记忆。
