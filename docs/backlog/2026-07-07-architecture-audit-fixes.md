# 2026-07-07 架构盘点 · 修复待办（全部要修）

来源：`docs/ARCHITECTURE.md`（2026-07-07 全仓库盘点）第 9 节实际 bug ×6 + 第 4 节技术债中值得修的 2 条，共 **8 项**。
执行者：新窗口的维护模型。**动手前先读 `docs/ARCHITECTURE.md`（至少第 3/5/6 节）和 `CLAUDE.md`。**
行号以 main @ e91f411 为基准，动手前重新核对。

## 执行约定（每条都适用）

1. 每项改动**必须带测试**（bash 脚本类无法单测的，按该项写明的手工验证步骤做并把结果记在下方勾选处）。
2. 全部做完：`bun test` 全绿 + `bun run web/build/cli.js` 通过，且 `Built N entries` 的 N 与改前一致。
3. 措辞用朴素准确的中文，不造黑话。不扩范围：只修列出的问题，顺眼的「顺手优化」一律不做。
4. **不要改 `docs/ARCHITECTURE.md`**——修复状态由审查方复审后统一更新。你只在本文件每项标题后打 ✅ 并附一行「怎么修的 + 测试/验证在哪」。
5. 改完直接精准 `git add` + commit + push（不必问）。`services/intake-worker/` 的改动 push 后 Mac mini 约 10 分钟自动 `wrangler deploy`，无需手动。
6. 修复顺序建议按下面编号（1 最重要也最跨文件，可放最后单独一个 commit，其余各自小 commit）。

---

## 1. 【设计级】交互式 park 的报告会被收工钩子自动推上公开站

- **位置**：`.claude/skills/research/SKILL.md`（Step 5.5 第 5 步 park 段）、`.claude/hooks/git-sync.sh`（push 分支，约 93 行 `git add -A`）、`web/build/build.js`（entries 过滤，约 30–35 行）。
- **问题**：SKILL 规定 park（上线前独立核验未过、搁置不发）时「绝不 push」，但交互式 park 只是把主题文件夹留在本地；会话结束时 SessionEnd 钩子 `git add -A` 自动提交推送，`deploy.yml` 一跑，这篇**已确认含硬错**的报告就公开上线。runner 链路 park 的文件夹留在 Mac mini 工作树里，之后该机任何交互式会话收工同样会推上去。
- **修法（三层，缺一不可）**：
  1. **SKILL 源头**：research SKILL Step 5.5 的 park 触发动作清单里加一条——park 时（交互式与无人值守都）在主题文件夹内写标记文件 `research/<dir>/.parked`（内容一行：搁置原因）。无人值守额外写 `research/.parked.json` 供 runner 发信的现有机制**保持不变**。「本主题文件夹留在本地不动」的表述改为「文件夹带 `.parked` 标记留在本地」。
  2. **推送闸**：`git-sync.sh` push 分支在 `git add -A` 之后、两道既有终检闸之后、commit 之前，检测暂存区是否含 `research/<dir>/.parked` 标记（`git diff --cached --name-only | grep -E '^research/[^/]+/\.parked$'`）；命中则对每个所在目录整体 `git reset -q -- "research/<dir>"` 从暂存剔除，并 warn 一行「⚠️ N 个被搁置（park）的报告文件夹已从自动提交排除：<目录列表>」；剔除后若暂存为空则按「无待提交」处理。
  3. **上线兜底**：`web/build/build.js` 的 entries 过滤在「缺 report.html 跳过」旁并列加「存在 `.parked` 标记跳过」（`console.warn` 一行说明）。这样即使标记连同文件夹被历史性/手动推上仓库，也绝不上站。
  - **不要**把 `.parked` 加进 `.gitignore`（gitignore 掉标记会让推送闸看不见它）。`services/runner/src/index.js` 的 `readParkSignal`/`clearParkSignal` 逻辑不动。
- **验收**：
  - 新增 fixture：`web/build/fixtures/` 下一个含 `.parked` 的完整主题目录，`build.test.js` 断言它被跳过、其余照常产出。
  - git-sync.sh 手工验证（做完记录结果）：临时建 `research/2099-01-01_park-test/`（放 notes.md + report.html + `.parked`），在仓库根跑 `bash .claude/hooks/git-sync.sh push` 的**暂存检测段**（可临时 `git add -A` 后核对 `git diff --cached --name-only` 不含该目录），确认剔除生效且不产生提交；测完删干净该目录与暂存。
  - SKILL 两处措辞更新到位（park 动作清单 + 「留在本地」表述）。

## 2. runner 查重命中路径「先发信后贴 done」，贴 done 持续失败会每 5 分钟重发一封邮件

- **位置**：`services/runner/src/runner.js` 查重命中分支（约 162–204 行：发信在前 ~170–184，`addLabel done` 在后 ~186–190）。
- **问题**：若 `addLabel` 持续失败（如 PAT 过期）而 SMTP 正常，该 Issue 每个 tick 重新命中查重并再发一封「已有报告」信——轰炸提交者邮箱。正常成功路径是「先贴 done 再发信」，两处顺序不一致。
- **修法**：把查重命中分支改成与正常路径一致的顺序——**先 `addLabel done`**：失败 → log + 尽力评论说明（「查重命中但贴 done 失败，未发信，下轮重试」）+ `continue`（不发信、不计 deduped？——`deduped` 计数仍可计，但 `emailed` 不计）；成功 → 再发「已有报告」信；发信失败 → 保持现有「评论请手动告知」兜底。留痕评论文案按新顺序微调。
- **验收**：更新/新增 `services/runner/src/runner.test.js` 用例：① addLabel 失败时**不调用** sendEmail，且函数正常继续处理后续 Issue；② addLabel 成功 + 发信失败时有「请手动告知」评论；③ 原有查重用例按新顺序调整断言。`bun test` 全绿。

## 3. `scan.js` 的 `statSync` 无兜底，一个坏条目可击穿整站构建

- **位置**：`web/build/scan.js` 约 26 行（`statSync(join(root, name)).isDirectory()`）。
- **问题**：`research/` 下若出现名字匹配 `^\d{4}-\d{2}-\d{2}_` 的悬空符号链接或不可读条目，`statSync` 抛错击穿整站构建。同文件对 frontmatter 损坏专门做了「警告 + 跳过单条」，唯独 stat 没有。
- **修法**：把 stat 包进 try/catch（如局部 `isDir(p)` 小函数，抛错返回 false），行为与其他坏条目一致：警告一行、跳过该条、其余照常。
- **验收**：新增测试：在临时目录造 `2026-01-01_broken` 悬空 symlink（`fs.symlinkSync("/nonexistent-target", …)`）+ 一个正常主题目录，断言 `scanResearch` 不抛、只返回正常条目。

## 4. 卡片导语抽取认「全文第一个引用块」，不保证是 TL;DR

- **位置**：`web/build/parse-note.js` 的 `extractTldr`（约 17–32 行）。
- **问题**：notes.md 若在结论之前出现任何 `>` 引用（免责声明、引言、或正文中部引用），它会顶掉真正的一句话结论成为首页卡片导语。现有笔记都把结论引用块放最前所以未爆发。
- **修法**：调整优先级为：① 「## 一句话 / TL;DR」类标题下的首个引用块或首段（现有标题回退逻辑升为最高优先）；② 第一个 `##` 标题**之前**出现的引用块（导语位置）；③ 全文第一个引用块（向后兼容兜底）。
- **验收（关键是「存量输出不变」）**：
  - 新增单测：正文中部有引用块 + 有 TL;DR 标题时，取标题下内容而非中部引用；只有导语位置引用块时行为不变。
  - 回归验证：改动前后各跑一次 `scanResearch("research")`，diff 全部 35 条 entry 的 `tldr` 字段，**必须零差异**（可写一次性脚本比对，结果记在勾选处，脚本不入库）。

## 5. `handleCheckSubmit` 图片先落库、任务后落库，中途失败留孤儿键并裸 500

- **位置**：`services/intake-worker/src/check.js` 约 174–192 行（图片写入循环）。
- **问题**：第 N 张图 put 失败时前 N-1 张已入 KV（孤儿 `checkimg:` 键，靠 7 天 TTL 兜底），整个请求冒泡到 `index.js` 的兜底 500；与同文件「先整体校验再落库」的意图不一致。
- **修法**：图片写入循环包 try/catch：失败时 best-effort 逐个 delete 已写入的 `checkimg:<id>:<0..n>` 键，返回 `corsJson({ ok: false, error: "image_store_failed" }, 502)`；任务键 `check:<id>` 此时尚未写入（保持现有顺序），无需回滚。
- **验收**：新增 `check.test.js` 用例：假 KV 第二张图 put 抛错 → 断言 ① 第一张图的键被 delete；② 响应 502 且带 CORS 头与 `image_store_failed`；③ 未写入 `check:<id>` 任务键、未动 `check:idx`。
- **注意**：这是 worker 改动，push 后自动部署；部署后可用手机核查页正常提交一次冒烟（可留给作者做，勾选处注明「待线上冒烟」即可）。

## 6. backlog 文档口吻失真（已全部完成却仍写「未动手」）

- **位置**：`docs/backlog/2026-07-04-audit-suggestions.md`（首段）、`docs/README.md`（backlog 一行）。
- **修法**：不移动文件（`docs/ARCHITECTURE.md` 已引用该路径）。在 2026-07-04 文件标题下加一行显眼总标注：「✅ 三档共 20 条 + UI 3 项已于 2026-07-04 全部完成（各档已有逐条完成记录），本文件仅存档」；`docs/README.md` 对应行改为「已全部完成，存档」口吻。
- **验收**：纯文档，肉眼核对两处一致即可。

## 7. 【技术债 2】查重窗口「30 天」三处独立定义

- **位置**：`services/runner/src/config.js`（`RUNNER_DEDUP_WINDOW_DAYS` 默认 30）、`web/src/assets/feed.js` 约 19 行（`const DEDUP_WINDOW_DAYS = 30`）、`.claude/skills/stock/SKILL.md` §0.1（文字写死 30 天）。
- **修法**：让 `services/runner/src/dedup.js` 成为唯一权威——新增 `export const DEFAULT_DEDUP_WINDOW_DAYS = 30`；`config.js` 的默认值改用它；`feed.js` 删本地常量、从 `./dedup.js` import（feed.js 本就从该文件 import `findFreshReport`，构建时 dedup.js 会被拷进 dist/assets，链路已通）。dedup.js 必须保持零依赖、浏览器可直跑——这个常量不破坏该约束。stock SKILL §0.1 在「30 天」旁加半句「（默认值，runner 侧可用 `RUNNER_DEDUP_WINDOW_DAYS` 调整）」。
- **验收**：`config.test.js` 默认值用例照绿；`bun run build` 通过后 `grep DEDUP_WINDOW web/dist/assets/feed.js` 确认引用生效；`bun test` 全绿。

## 8. 【技术债 1】INDEX.md「一句话结论」已膨胀成数千字长文

- **位置**：`.claude/skills/research/SKILL.md` Step 4「维护总索引」段（约 153 行）。源头是近期股票报告把整篇摘要塞进该列（看 `research/INDEX.md` 顶部几行即知）。
- **修法**：只改 SKILL 措辞、**存量 INDEX 行一律不动**：在「一句话结论」处钉死硬上限——「一句话结论：**≤80 字**（硬上限），只写方向性结论；细节留在报告与 notes，不得把摘要塞进索引行」。stock skill 复用 research Step 4，无需另改。
- **验收**：纯 SKILL 文字，核对措辞落位即可。

---

## 完工总检查单（Sonnet 自查后在此逐项勾选）

- [ ] 8 项全部完成，每项标题后有 ✅ + 一行说明（怎么修的、测试/验证在哪）
- [ ] `bun test` 全绿（记录测试总数）
- [ ] `bun run web/build/cli.js` 通过，`Built N entries` 与改前一致，且第 4 项的存量导语 diff 为零
- [ ] 第 1 项的 git-sync.sh 手工验证已做并记录，测试残留已清理
- [ ] 全部已 commit + push（worker 改动注明「等自动部署/待线上冒烟」）
