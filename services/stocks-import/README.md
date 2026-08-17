# stocks-import —— 把 Stocks 的个股深度调研搬到公开站

Stocks 是本机另一个项目（专业股票工具），它每晚自动跑个股深度调研，把 A–M 全文存在自己的
SQLite 库里。那些报告写得很完整，但**只给自己人看**：正文里到处是取数函数名、库表字段、
SQL 与执行计划、主机名、源码路径，还有「某函数跑了 45 分钟没返回」这类运行时故障叙述。

这个服务做两件事：**把它们搬过来**，以及**在搬之前把上面那些东西过滤干净**。

```
bun run stocks-import                 # 增量导入（只处理没导过的）
bun run stocks-import --dry-run       # 只看要导哪几篇
bun run stocks-import --since 2026-07-01
bun run stocks-import --id 25         # 只导一篇（排障用）
bun run stocks-import --porcelain     # 只吐新建的目录名，一行一个（定时任务用）
```

## 数据从哪来

`~/Coding/Stocks/data/stocks.db` 的 `research_report` 表（`STOCKS_DB` 可覆盖）：

| 列 | 用途 |
|---|---|
| `content_md` | A–M 全文 markdown → 过滤后成为 report.html 正文 |
| `summary_json` | 方向 / 置信度 / 驱动 / 风险 / 验证信号 / 三情景 / 操作提示 → notes.md 各小节与首页导语 |
| `generated_at` | 信息截止日（北京时间）→ 目录日期与 frontmatter |

查库一律**只读**，走 `sqlite3` CLI + `PRAGMA query_only=1`。不用 `?mode=ro`：那个在这个 WAL
库上常态打不开（CLAUDE.md 记着这条教训）。代价也写明——`query_only` 是连接级只读，
比打开级只读弱一层，它拦得住本进程的写语句，拦不住"以读写方式打开"这件事本身。

## 过滤了什么（src/sanitize.js）

三步，顺序不能反：

1. **术语映射**：`financials_recent` → 库内财务、`valuation_brief` → 库内估值……
   **不是删掉**——这些标记承担「这个数字从哪来」的溯源作用。调用参数也翻成中文
   （`recent_news(days=60)` → 库内新闻（近 60 日）），否则同一函数的两次不同窗口调用
   会合并成同一个词，原句「两者均返回空」就变成了「库内新闻与库内新闻均返回空」。
2. **整句剔除**：索引 / 执行计划 / 主机名 / 源码路径 / 「跑了 N 分钟没返回」。
   判据一律要求出现明确的系统内部词，不做「看着像技术话」的模糊判断。
3. **整节剔除**：报告末尾 Stocks 自家的「⚙️ 交付前机器质检」——那是流水线自检，不是报告内容。

删掉的句子会在导入时打到终端（`过滤系统参数句 N 条`），可以抽查删的是什么。
判据的松紧是拿 25 篇存量真跑标定出来的，两类误伤是实测抓到后才收窄的：

- 裸 `CPU` 曾把海光信息（一家做 CPU 的公司）整段业务描述删掉；
- 裸「未返回 / 不可用」曾把「库内事件日历未返回任何解禁项」这类**真实数据缺口**、
  以及「这些公司的财务数据本次未查，不对其基本面作任何陈述」这类**免责声明**删掉。

## 价位红线的逐条改写

本站对股票报告有一条硬规矩：**操作触发条件与情景走势里不得出现具体价位**（写「跌破 5.50 元」
等于变相给目标价）。Stocks 那边有几处踩线，逐条列在 `src/index.js` 的 `PRICE_REDLINE_FIXES` 里，
**只把价位换成它在原文里本来就有的定性锚**（分位筹码成本、基准日收盘价、回购方案上限），
不改判断、不改方向；每条都注明「删掉的数字对应哪个锚」。

列成明表而不是写通用正则——改的是别人报告里的字，每一处都该看得见、可复核。
新报告若出现新的踩线，会被每日任务的质检闸拦下并搁置，不会静默上线。

## 目录名与板块（src/mapping.js）

一张手工表，两个字段：

- **slug** 决定归档目录名，也就是公开站的固定网址。一旦上线就不该再变；同一只票此前已有
  归档的必须沿用同一个 slug（如 `300285` → `guoci-materials-300285`），否则同标的的多份报告
  在 `web/build/series.js` 里认不出是一个系列。
- **boards** 是「五大常关注板块」归属。这是判断不是词频——按 CLAUDE.md「仅在确有关联时挂，
  不硬凑」。空数组是有意的结论。

表里没有的新票会降级成 `stock-<代码>`、板块留空，并在导入时打一行提示提醒补表。
**降级不阻断上线**：宁可 slug 丑一点，也不能让一份真报告因为查表失败发不出去。

## 幂等

不另存状态文件，**以归档目录本身为准**：每篇 notes.md 的 frontmatter 里写
`stocks_report_id: <id>`，启动时扫一遍 `research/` 收集已导过的 id。
删掉目录＝允许重导，手工改名/挪动也不会失配，不存在「状态文件与磁盘打架」这类故障。

## 每日无人值守

`scheduled-run.sh` + `launchd/com.searchx.stocks-import.plist`，**每 5 分钟**跑一次
（`StartInterval`，想调快调慢改这一个数字）。Stocks 的自动调研窗是 20:30–06:00，但白天手工
跑的报告也要能尽快上线——从生成到公开站可见约 2 分钟，其中大头是 CI 部署（实测 38–85 秒）。

频繁轮询不花任何配额：**这条通路整个不出网**，读的是同机的 SQLite 文件，不碰 Cloudflare／KV／
GitHub API。空跑实测 0.14 秒，288 次/天合计约 40 秒 CPU。出网的 `git push` 与 CI 只在确有新报告
时发生，次数等于报告篇数、与轮询频率无关。

```
增量导入 → 逐篇机器质检 --strict → 构建自检 → 精准 git add → 提交推送 → CI 部署
```

- 一篇都没有就**安静退出**，不提交、不发信。
- 某篇没过质检就**就地搁置**（写 `.parked`，构建会跳过它），而不是整批放弃——
  一篇有问题不该拖着其它篇不上线；随后发一封限频报警（同 key 6 小时最多一封）。
- 互斥用固定路径锁（`STOCKS_IMPORT_LOCK` 可覆盖），陈旧锁 2 小时自动回收。

安装（只在 Mac mini 上做一次）：

```bash
cp services/stocks-import/launchd/com.searchx.stocks-import.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.searchx.stocks-import.plist
```

排障：

```bash
tail -n 80 ~/Library/Logs/searchx-stocks-import/stocks-import.log
launchctl kickstart gui/$(id -u)/com.searchx.stocks-import   # 立刻跑一次
```

## 搁置的报告怎么处理

```bash
bun run scripts/research-qc.js --dir <归档目录名>    # 看具体是哪条红线
```

改完正文（或往 `PRICE_REDLINE_FIXES` 里补一条改写）后删掉 `research/<目录>/.parked`，
下次构建就会收录。
