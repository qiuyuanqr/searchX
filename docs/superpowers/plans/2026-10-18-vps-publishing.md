# searchX 国内静态站接入实施计划

> 本会话按用户已确认的勘察方案执行。实现由主代理负责，合并前按 requesting-code-review 技能独立审查。

**Goal:** 将已验证的公开静态制品发布到 search.qiuyuan.net，保留 GitHub Pages 和可执行回滚，保护 Stocks。

**Architecture:** Worker 使用明确双 Origin 白名单；Mac mini 从成功的 main Deploy site 下载 github-pages 制品，通过专用 SSH key/强制接收程序发布到 VPS。接收程序校验归档、哈希、序号、锁和必需站点文件后，原子切换 current。Caddy 只新增独立域名站点。

**Tech Stack:** JavaScript/Bun、Python 3.9+ 标准库、GitHub CLI、OpenSSH、Caddy 2.6.2、launchd。

## 1. Worker 双域名

- [ ] 新建 `services/intake-worker/src/cors.test.js`，对两个 Origin 逐条测试真实路由 OPTIONS、正常/鉴权失败/405/404/500；恶意域名与 null 不得被反射。
- [ ] 先运行 `bun test services/intake-worker/src/cors.test.js`，确认新域名用例失败。
- [ ] 新建共享 `cors.js`，按精确 Origin 匹配配置；原 `ALLOWED_ORIGIN` 保留兼容，新 `ALLOWED_ORIGINS` 用逗号分隔。所有 handler 与顶层失败响应共用。
- [ ] 跑全部 Worker 测试；README 和 wrangler.toml 同步双 Origin 口径。

## 2. 发布与回滚

- [ ] 新建 `services/site-publisher/test_receiver.py`，用真实临时 tar 和目录检验：完整切换、坏包不切换、越界/链接/私有文件拒绝、旧序号拒绝、重复执行、回滚和锁竞争。
- [ ] 新建 `receiver.py`：只接受标准输入的固定协议（长度有上限的 JSON 元数据行 + 有长度/sha256 的 tar），每个 release 不覆盖；`flock` 保护整次接收与切换，状态随 current 指向的 release 读取；回滚也持锁、不重置最高序号。
- [ ] 新建 `publisher.py` 与测试：通过 gh 核对 main/workflow/repo/成功状态，下载唯一 github-pages 制品；安全解包制品外层 ZIP，上传 archive.tar；超时、远端失败不写成功状态。状态目录用固定值且 CLI 可覆盖。
- [ ] 新建 launchd 模板、定时包装脚本、README 和独立 Caddy 片段；脚本不加载 .env、不调用模型或生产队列。

## 3. 验证与审查

- [ ] worktree 不含 .env，全量 `bun test`、发布 Python unittest、build/build:worker 均检查真实退出码。
- [ ] 用 CI 实际制品回放接收、重复发布和回滚；真浏览器检查根路径站点的首页/报告/搜索、未授权提交/核查和接口异常。
- [ ] 请求独立代码审查，修复重要问题并复测。

## 4. 部署

- [ ] 本任务提交合入 main、精准推送；确认 Pages CI 成功和 Worker 新版本双 Origin 生效。
- [ ] 生产先核对并备份 Caddy 原文件和活动配置、Stocks 健康；在 VPS 安装独立接收程序和固定目录，专用账号仅允许强制命令。
- [ ] Mac mini 生成专用 key（私钥不读出），在 VPS 安装其公钥；不改 ~/.ssh/config；运行一次公开制品发布。
- [ ] DNS 仅新增 search A 记录；合成 Caddy 候选，原活动站点语义逐项一致且 validate 通过后平滑 reload；异常恢复备份。
- [ ] 真实 HTTPS、Stocks 健康、站点搜索/接口浏览器验收；安装 com.searchx.site-publisher，验证自然轮询和失败保持旧版。
- [ ] 更新 HANDOFF、CHANGES 和日期记录，写明版本/备份/回滚命令/未验收边界；提交推送交接。


## 现场调整（2026-10-18）

Mac mini 无 Actions 制品下载鉴权（真实 401），但可读公开 workflow 元数据；不为此扩张账号权限。改由同一次 CI 在构建后用 bundle.py 导出公开、确定性压缩静态包与 manifest，仍绑定成功 main run 的 id/number/sha。发布端精确校验 manifest 身份、长度和 SHA256，包中仍不含私有 data。该调整保持同一 CI 静态构建来源，避免复制 token或使用带私有数据的本机工作区作为兜底。

独立审查发现并修复：真实 Pagefind 格式兼容；generation + 单一 active 提交点替代多指针更新；回滚失败重试保持幂等；上线前完整自校验；资源文件和目录先 fsync 再提交指针。对应故障与真实制品回放纳入测试。
