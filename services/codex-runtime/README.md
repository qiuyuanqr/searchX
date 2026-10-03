# Codex 隔离执行与工作流（测试阶段）

为 searchX 提供 GPT-6.1 Sol 的受控调用。**runner / check-runner 已接入此执行层，代码已部署到 Mac mini，生产服务仍未启用。隔离测试不消费队列、发布、发信或写真实 Obsidian。** 2026-10-03 的验证记录见 `docs/progress/2026-10-03-codex-runtime-tests.md`。

## 固定契约

- 所有调用固定 `gpt-6.1-sol`，默认 `high`；可设 `SEARCHX_CODEX_EFFORT=high|xhigh|max|ultra`，须经实时模型目录确认。其他模型、低档或未知档立即拒绝，不降级、不回退 API。
- 复用常驻机已有 ChatGPT 登录。子进程仅继承必要系统、证书与代理变量；业务/API 密钥不继承。忽略个人配置、仓库隐式指令、插件、Hooks 和 Apps。
- 使用独立工作目录、只读沙箱、关闭 Shell/补丁/子代理；全新写作和核验会话由外层逐个启动。每个调用必须明确完成回合、exit 0、有最终结果，失败与超时回收整个子进程组。
- 模型经只读 MCP 读取任务文件和白名单市场查询。模型返回 JSON，宿主校验完整字段和路径后写三件套/原始网页摘录；不会把写工具伪装成只读以绕过 `approval_policy=never`。
- Stocks 查询固定 `research` + `user=none`，使用 Stocks 自己的 `query_for_agent.py`；无任意 SQL、私人账户查询。每次原始返回单独归档，重复调用不覆盖，核验员也存到自己的临时目录。每份原始返回另存 `.meta.json`，记录函数、查询参数、scope/user、北京时间和内容哈希，避免复用同行财务时丢失股票归属。
- 图片默认禁用。显式 `--image inputs/example.png` 开启视觉，仅允许已验证的 Codex CLI **0.160.0**；MCP 图片白名单 + 原生图片读取的文件沙箱共同限制。升级 CLI 必须重测边界，不能默认接受新版。
- 宿主完成落盘不代表内容合格。后续必须执行旧机械质检、来源覆盖、联网质证、独立核验与必要修订；这份 probe 没有发布路径。

## 离线测试

```sh
python3 -m unittest discover -s services/codex-runtime -p 'test_*.py'
```

## 常驻机隔离运行

只在指定常驻机执行。将本目录模块和所需技能/模板复制到独立临时目录，调用下例；`TEST_ROOT`、`CODEX_BIN`、`STOCKS_ROOT` 均由操作者显式给定，勿从生产 `.env` 读取。

```sh
python3 probe.py --root "$TEST_ROOT" --name sample-stock \
  --kind research --inputs "$TEST_ROOT/inputs" --prompt "$TEST_ROOT/prompt.txt" \
  --binary "$CODEX_BIN" --stocks-root "$STOCKS_ROOT" --timeout 1800
```

公开研究 `--kind research`，私密核查 `--kind factcheck`，独立核验 `--kind review --readonly`。名称必须唯一，不覆盖上一轮结果。`controls/` 保存审计统计、每30秒更新的纯元数据进度和最终返回；任务目录只存本轮素材与产物，禁止放凭据。`completed` 仅表示模型完成回合，**不表示研究已通过质检或可以发布**。所有材料应按相应任务隐私级别保管，真实私密核查全文不要进入 Git。

生产归档互斥、发布由宿主交付模块实现；队列回传和通知沿用原状态机。不能直接将 `probe.py` 配成 LaunchAgent。

## 分阶段隔离测试

`stage_probe.py` 将一个取证或正文阶段的结果保存为 `result.md`，检查点记录输入/输出 SHA-256 与模型审计，状态始终是 `generated_unreviewed`。每30秒记录经过秒数、输出字节数、事件计数和未完成的工具类型；不保存推理、工具参数或返回正文到进度日志。`--no-web` 用于已完成取证后的写作阶段。

同一阶段名称不能重复使用。失败不会写成功检查点；这不是生产断点续跑调度器，不能根据文件存在就标记内容验收成功。取证可分财务和事件两路；正文按 A–D、E–I、J–M 分段（J–M 读取前两段保证一致），宿主最后套用原模板，再对合并全文执行原质检和独立核验。

隔离测试证据完成后复制到本目录忽略的 `local-evidence/`，避免常驻机重启清空 `/tmp` 后丢失。此目录不参与站点构建、不进入Git；仍须按任务隐私级别保存。模型联网工具读取大型PDF失败时，本轮由宿主从明确的官方URL下载原件、提取相关完整页并交给独立核验；该PDF补取还不是生产自动兜底能力，不能把本轮人工编排说成无人值守端到端验收。

## 可恢复阶段与自动编排

`job.py` / `job_stage.py` 是后续入口：任务目录使用 OS 文件锁；总预算默认180分钟，写入固定截止时间，跨阶段与进程恢复不重置。输入、模型、原始快照或产物变化会拒绝复用。失败阶段重试时保留上次尝试，已完成阶段通过哈希复用；超时不留下成功检查点。失败的最终回答仅存私密尝试目录的 `unaccepted-result.txt`，不写正文进进度日志，不存内部推理。任务输入可以分命名空间，全部只读、禁止隐藏路径、软链和目录穿越。

`workflow.py` 在同一任务预算内调用：

1. 股票：财务与事件取证 → A–D、E–I、J–M → 封面 → 宿主 `assembly.py` 装原模板。每段在保存检查点前验证章节与静态HTML，坏片段不消耗后续阶段。宿主剥掉公开标题的内部代号，生成来源清单；不写死公司/日期/关联板块。
2. 普通研究/核查：显式读取对应项目技能，结构化交付三件套或完整六节笔记；附图只走本任务白名单。
3. `quality.mjs` 只读调用原机器质检、来源对账、联网质证、笔记转换。研究检查未完成、硬红线、模板/来源缺失阻断；网页抓取失败是“未测”，不是事实错误。核查要求完整笔记，不能只有标题。
4. 研究三路、核查一路全新上下文只读联网复核；硬错须有报告说法、来源原文及URL。最多两轮定点修订后仍有硬错/机械阻断就 `parked`，不会无限重研。

最终 `isolated_reviewed` 仅证明隔离编排按流程收到了合格产物，始终 `production_ready=false`、`published=false`，不是投研事实全量保证。`unchecked` 保留核验限制。**读取最终回执必须使用 `workflow.read_receipt()` 并核对调用退出码**；它拒绝未完成的提交标记，不能只看残留 JSON 的 status。下游不得直接把该状态映射为 runner 的“已发布”。

常驻机显式隔离入口（不能作为生产 tick）：

```sh
python3 workflow.py --root "$JOB_ROOT" --task-id "$TASK_ID" \
  --repo "$CREDENTIAL_FREE_REPO" --request "$REQUEST_JSON" \
  --slug "$TOPIC_SLUG" --binary "$CODEX_BIN" --kind auto
```

`--kind factcheck` 走私密核查；`--inputs` 为明确准备的素材目录，`--image claim.png` 相对于该目录。`--stocks-root` 配常驻机 Stocks 白名单查询，`--budget` 是全任务秒数，恢复须保持相同值。`--no-quality-web` 仅供离线测试，并在回执明确记录。Bun检查从隔离任务目录执行，避免自动加载仓库 `.env`。

自动股票及概念编排已完成常驻机隔离实测和临时宿主交付，仍保留未核事实边界；本地两个 index.js 已接共享 `adapter.js`，并要求 `SEARCHX_CODEX_DELIVERY_ENABLED=1` 才能取队列。当前未设置生产开关、未启用服务。`adapter.js` 校验真实产物全清单、哈希、模型/档位、核验与笔记回执；缓存交付重试不重复调用模型，即使生成预算已过期。

研究宿主在 `services/runner/src/codex-delivery.js` 负责互斥、归档、笔记、构建、精确提交及推送；核查宿主在 `services/check-runner/src/codex-delivery.js` 负责真实笔记与同字节 result.md。它们属于需要生产授权的边界，执行层本身不发布。新代码通过单元/临时仓库测试并不等于生产推送、邮件、同步及手机回显已通过。

真实合成图片核查已完成自动生成和独立联网复核；最终回执由 JS 适配器在 Mac mini 读回通过，随后完整 JS 适配器调用、成功缓存复用也通过。手机深链定点修复后，4858 字节全文在临时 vault/result 两端完全相同，note 相对路径等于真实落盘路径，第二次交付复用同一路径。未写真 Obsidian。


核查路径由 `services/check-runner/src/factcheck-note.js` 统一生成。workflow 将去掉 `check-` 前缀后的原任务ID传给quality；quality只规范frontmatter的note字段，正文不动。宿主交付拒收路径不规范的已验收全文，避免手机深链指到另一篇或不存在的笔记。

链接核查的宿主接线由 `link_source.py` 完成：生成前先对 `request.link` 与补证父任务 `parentClaim.link` 调用原 `scripts/fetch-article.py --json`，相同 URL 只抓一次。原始 stdout 和抓取状态保存在私密任务的 `controls/link-sources.json`，以哈希冻结；生成、独立核验和定点修订均读取同一 Markdown 原文输入，恢复不重新抓取来改变已取证内容。正文可用性只按脚本生成的 JSON 顶层正文/字数判断，标题、来源、时间与摘要中的换行不能伪造抓取状态。原命令不加 `--json` 时仍返回传统 Markdown。修改显式链接或抓取实现须使用新的任务标识；已冻结失败状态也不会在恢复时偷偷换成另一份页面。宿主预检复用固定脚本的地址策略，并避免向仓库写入 Python 字节码缓存。

退出 2（验证页）、3（网络/HTTP错误）、0但空正文允许模型联网搜索/网页读取兜底，状态明确“未取得原文”，摘要不能当原文、仅凭摘要把握度封顶中。URL 策略拒绝或退出4在模型启动前阻断，未知退出码也不降级成搜索；模块不会换通路绕过拒绝地址。网页、元信息及抓取诊断都是不可信数据，夹带指令不得执行。抓到原文只证明读到发布者内容，仍须独立核验事实。URL 检查沿用原脚本的现有保证：可拒绝显式本机/内网地址，但未新增 DNS 解析后地址及重定向目标校验。当前只验证离线脚本与工作流接线，未验证真实站点或生产常驻机出口。

## 人工暂停与恢复

`Job.pause()` / `Job.resume()` 仅供宿主在用户明确暂停或继续后使用，不在队列 tick 中自动调用。先停止活动工作流并确认模型进程已回收，再用 `job_control.py pause` 冻结未花完的秒数；同一 OS 锁被活跃工作流占用时命令拒绝。暂停任务不允许执行任何生成阶段，普通错误或预算过期不能变成暂停。

恢复使用同一 root、task-id、binary、budget，通过 `job_control.py resume` 明确执行。它重新核对检查点和证据哈希，仅保留暂停时余额，将原截止时间和原 job 哈希存入暂停历史。离线暂停时间不计预算，恢复不重新给予 180 分钟；报告日期仍取最初开始日。原子写入报错后当前对象不可重试，必须重新进入锁读取实际状态。

```sh
python3 job_control.py pause --root "$JOB_ROOT" --task-id "$TASK_ID" --binary "$CODEX_BIN" --budget 10800
python3 job_control.py resume --root "$JOB_ROOT" --task-id "$TASK_ID" --binary "$CODEX_BIN" --budget 10800
```

2026-10-03 原暂停发生在接口落地前。`adopt-pause --receipt <绝对路径> --receipt-job stock|concept` 只用于导入可信宿主的历史 `user-pause.json`：要求已停止进程、目标 root 一致、旧 job 精确哈希、原 deadline/剩余秒数算术及成功检查点清单全部吻合。导入与恢复为两个明确动作；不能拿模型返回、超时记录或未知文件恢复额度。只要记录已消费或证据改变，就拒绝，不伪造成功检查点。


2026-10-03 最终隔离回归：Bun1422通过/1跳过、Python96项在本机与Mac mini镜像通过。人工暂停/链接接线/宿主交付均经独立复审；真实自动股票与概念样本保持未核事实范围。Darwin组销毁短窗口的EPERM仅在signal 0确认ESRCH后视作消失，探测最多10ms，仍存活或无法确认则失败。生产同步步骤见 `docs/maintenance/CODEX_RUNTIME_SWITCH.md`，两个runner仍未启用。
