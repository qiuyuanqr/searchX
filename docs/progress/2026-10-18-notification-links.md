# 通知报告链接切换（2026-10-18，北京时间）

用户要求将通知与邮件的报告链接切换到 `search.qiuyuan.net`，旧 GitHub Pages 保留备用。

## 实现

- `services/site-links.js` 统一主站/备用站、可覆盖默认和已知报告路径迁移；只迁移已知站点公开 `/r/`，未知 URL 和核查入口保持原样。
- runner 的新报告、补发、Issue 评论、已有报告回信、作者汇总、超龄通知均使用当前主站；公开报告邮件附同篇 Pages 备用链接。
- 旧队列在探活之前转换 URL，不修改其他业务字段、时间戳、出队/发信顺序。新增回归覆盖新站不可达不发信、恢复后一次补发。
- 查重命中也先对主站短探活，不可达则保留 approved，下轮复探，不重研、不贴 done。
- 核查 Bark 默认跳到无密钥的新站 `/check.html`，私密结果仍走既有鉴权通道；未将核查内容或密钥写入公开链接。
- runner 与 check-runner 的 LaunchAgent 模板分别显式指定非敏感 `RUNNER_SITE_BASE`、`CHECK_RUNNER_CHECK_PAGE_URL`；生产安装记录待补。
- 两份研究与股票技能同步主备入口说明。GitHub Pages CI probe、发布器 `PUBLIC_BUNDLE` 与旧站部署链路保持原样，避免 CI 等待 VPS、VPS 又等待 CI 成功的循环。

## 验证

- 隔离工作树从 `1eeb372` 开始；基线定向 80 pass / 0 fail；新增回归先失败（9 fail / 1 missing-module error），实现后通过。
- 无凭据临时源码镜像 `/private/tmp/searchx-notification-validation`：全量 1466 pass / 1 skip / 0 fail、4160 assertions；最终规则/技能一致性及通知定向 96 pass / 0 fail。
- 独立代码审查：无 Critical / Important / Minor；审查代理复跑 90 项测试通过。
- 生产只读：`r/2026-10-16_stock-601999/` 新旧站均 200、99705 字节，SHA256 `07271b2136042c09c4315daa66a9ffacc9f42f64a686eaec247ed5fd4e0a9f55`；新核查页 200；Stocks `/api/health` 200 / ok。
- 未发真实测试邮件或推送；未创建队列任务。测试不代表下一次业务邮件已经送达，等待自然任务实际验收。

## 回滚

保留本次代码时，必须在两条服务空闲时显式设置旧入口并重载：`RUNNER_SITE_BASE=https://qiuyuanqr.github.io/searchX`；`CHECK_RUNNER_CHECK_PAGE_URL=https://qiuyuanqr.github.io/searchX/check.html`。原 plist 没有这两个 URL 键，**单独恢复备份 plist 仍会采用新代码的新站默认值，不能完成回滚**。如选择原 plist 恢复，必须同时回退本次代码。已知主站队列 URL 会随当前配置映射回旧站，不重研。不要撤掉旧站 CI/部署或修改 VPS 发布器的 Pages 源。

## 生产部署

代码 `05b6f8eba4c98b0d5e3545a2ace7e8be337433f2` 已推送 GitHub main（远端 ref 实核）并快进同步至 Mac mini。同步时获取 Git/importer 互斥目录与两条 runner 的 PID 锁；两条服务均空闲才停用旧定时器，没有打断真实任务。

生产 plist 私密备份：`~/Library/Application Support/searchx-codex-ops/20261018-230846-notification-links/`（目录 0700、文件 0600）。仅增两项非敏感 URL，其余配置原样保留；没有读取 `.env`、输出凭据或复制敏感配置进仓库。模板与已安装键一致，bootstrap 后用 launchctl 核对加载值：

- `com.searchx.runner`：`RUNNER_SITE_BASE=https://search.qiuyuan.net`。
- `com.searchx.check-runner`：`CHECK_RUNNER_CHECK_PAGE_URL=https://search.qiuyuan.net/check.html`。
- 两者 `RunAtLoad=false`、周期 300 秒，已恢复定时加载；未额外 kickstart 消费任务。重载后即时状态均 not running / runs 0，首个自然 tick 尚待观察。
- Mac mini 从仓外执行同组定向/一致性测试：96 pass / 0 fail、410 assertions。生产 checkout 干净，Pages 下载源不变，Stocks 健康接口再次 200/ok。

本轮没有网页或构建改动，不额外触发 Pages 部署；当前公开内容仍沿用已验证发布版本 1791。旧 GitHub Pages 入口仍保留，正常后续报告继续经原 CI→Pages→VPS 流水线更新。

当前主工作区另一会话的 hooks、AGENTS、CHANGES 条目及新增 session-end 脚本原样保留，未提交；只精准集成本任务文件与流水条目。隔离工作树成果逐文件核对进入 main 后归档，未删除分支。

未涉及 Stocks 服务、数据、DNS、代理、SSH 配置或 VPS 路由。真实下一封业务邮件和 Bark 点击仍需随自然任务验收，不以离线邮件替身或配置加载成功代替已送达。
