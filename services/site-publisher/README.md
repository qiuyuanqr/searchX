# 国内静态站发布

浏览器通过 `search.qiuyuan.net` 读取 VPS 的 `/srv/searchx/current`。研究/核查仍由原系统处理，GitHub Pages 保留。这里的程序不调用模型、不取业务队列、不写 Stocks。

## 程序与协议

- `publisher.py`：只选 `qiuyuanqr/searchX` 的 `.github/workflows/deploy.yml`，main 分支、同仓库来源、push/workflow_dispatch、completed/success 的最高 run_number。校验该次 CI 生成的公开 `_publish/manifest.json` 的提交号、run id、run number、长度和 SHA256，再下载同一次构建导出的压缩静态包。包名含内容 SHA256，避免缓存串版；manifest 尚未匹配成功 run 时保持旧版、下轮重试。不需要 GitHub Actions 制品下载凭据。
- `receiver.py`：VPS 的 root 所有固定命令；专用账号的 SSH key 不能执行其他命令、转发端口或更改 Caddy。标准输入第一行为有长度上限的 JSON（publish/status/rollback），publish 后接指定字节数和 sha256 的 tar/gzip tar。解析失败返回非零。
- `publish-cron.sh`：Mac mini 的包装入口，固定标准 PATH，不加载 `.env`。
- launchd：`com.searchx.site-publisher` 每 300 秒轮询，仅安装到 Mac mini。

归档上限 128 MiB、文件内容展开上限 256 MiB、条目上限 20000；gzip先分块解压到临时raw tar并限制含元数据/填充在内的全部字节（256 MiB + 20000×1024 + 10240），PAX/GNU扩展头单个上限64 KiB；只允许站点页面、assets、pagefind、r、s 的静态格式。拒绝越界、符号/硬链接、设备、重复条目、私有 data、隐藏配置文件和未知顶层路径。reports.json 中的报告必须在制品内真实存在。归档身份、全部文件 hash 和完整性校验完才允许切换。

`/srv/searchx/releases/<run_number>-<commit>/` 保存不可覆盖的版本，`current`/`previous`/`state.json` 通过固定链接指向 active 选中的完整 generation，active 单次原子替换同时提交当前版、上一版和最高序号，避免中断造成状态撕裂。state.json 不对外提供。旧序号/相同序号不同身份拒绝；同制品重复发布幂等。回滚时校验上一版全部 hash，并设置 held：同一个成功 run 不会被下一 tick 自动发布回来，更高成功 run 才继续更新。旧版不自动删除。

发布状态以 VPS 为准，没有“本地先写成功 stamp”的窗口。Mac mini 与 VPS 两端均有内核文件锁，进程退出即释放；接收程序总时限 180 秒。GitHub 下载、SSH 和子进程有超时，失败保持当前站点。

## 日常命令（在 Mac mini）

```sh
cd /Users/yangqiuyuan/Coding/searchX
/bin/sh services/site-publisher/publish-cron.sh status
/bin/sh services/site-publisher/publish-cron.sh
/bin/sh services/site-publisher/publish-cron.sh rollback
```

默认专用 key `~/.ssh/id_ed25519_searchx_publish`，默认目标 `searchx-publish@8.148.234.233`。可以通过 `publisher.py --host/--identity/--state-root/--gh` 指定替身进行隔离测试。状态目录默认 `~/Library/Application Support/searchx-site-publisher`，不依赖不同触发方式下可能变化的 TMPDIR。定时器 stdout/stderr 分别在 `~/Library/Logs/searchx-site-publisher/`。

如需长期停留在回滚版本，先 `launchctl bootout gui/$(id -u)/com.searchx.site-publisher`；否则后续更高成功 run 会正常发布。恢复用 `launchctl bootstrap` 加载已安装 plist，不需要重启 Stocks。

## 首次安装约束

首次安装需已获用户授权：独立账号/发布目录、专用 key、新 DNS、Caddy 平滑 reload。不得复用日常 root key，也不得将 VPS root key 放入 GitHub Secrets。VPS 的接收程序和 authorized_keys 必须由 root 拥有、发布账号不可修改；账号仅拥有 `/srv/searchx`。authorized_keys 加 `restrict,command="/usr/bin/python3 /usr/local/lib/searchx-site/receiver.py --root /srv/searchx"`，不修改既有 SSH 配置或其他账号。

只发布 CI 制品。**不要 build 并同步常驻机工作区**：本地 build 会复制存在的 research/*/data/，可能泄露私有研究数据。CI 制品失效或下载失败时不能用这种方法兜底。首次启用前必须完成真实制品回放和独立代码审查。

新增 DNS 仅 `search` A 记录。Caddy 片段见 `search.qiuyuan.net.caddy`；修改前保存原 Caddyfile、活动配置与 Stocks 健康证据。候选配置须用现场版本 adapt/validate，移除新增站点后须与原配置逐项一致；仅允许新增独立 host。原配置/活动配置不一致时先停，不覆盖他人改动。

配置加载用现有 Caddy 的平滑 reload，不停止或重启 Stocks/Caddy。新域名证书和 HTTPS、Stocks 健康、原通知路由均要核对。失败恢复备份后平滑 reload，重新验 Stocks；日常发布和内容回滚只切换静态目录，不 reload Caddy。具体本次备份位置与上线证据写日期交接。

## 验证

```sh
python3 -m unittest discover -s services/site-publisher -p 'test_*.py'
bun test services/intake-worker/src
```

Python 测试在系统临时目录使用真实 tar/gzip tar 和接收程序，覆盖私有文件/链接/越界、截断/哈希错误、重复/冲突/旧序号、锁竞争、损坏已存版本、成功 CI 选择、失败不报成功及回滚保持。不连生产或读取凭据。上线前还要在 Mac mini 的 Python 和 VPS 上同样复测，并用真实 CI 制品回放。


## CI 公开包的来源与边界

`Deploy site` 在原有全量测试和 `bun run build` 成功后执行 `bundle.py`，从同一份 web/dist 导出确定性的 gzip tar；打包前复用 receiver 的完整路径/私有文件规则验证。`_publish` 是静态包的分发目录，不进入包本身，不会无限嵌套。原 Pages 网页和内包是同一构建中的同一批公开文件。

这样做的现场原因：Mac mini 的 gh 可读公开 workflow 元数据，但下载 Actions 制品返回 401 Requires authentication。本任务没有为此复制 token、增加账号权限或变更登录。GitHub Actions 原有 github-pages 制品仍按原流程上传/部署；新增的公开包只分发原本就公开的静态内容。新版本必须等对应 Deploy site 整体 success 才能发布到 VPS。
