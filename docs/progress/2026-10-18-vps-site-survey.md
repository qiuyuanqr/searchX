# searchX 国内服务器接入勘察与拟定方案

日期：2026-10-18（北京时间）。状态：**只读勘察和隔离构建完成，尚未接入或上线新域名。**

用户要求：“按第二种方案继续，先看看现有服务器怎么接，别影响 Stocks。”本轮仅核对生产现状、解析候选配置和在本机临时目录构建。DNS、VPS 文件和配置、Mac mini 服务、Worker 均未修改。以下接入步骤为待确认方案，不是已完成部署。

## 实测现状

| 对象 | 本轮结果 | 适用限制 |
|---|---|---|
| 仓库 | MacBook 和 Mac mini 均为 `main`，HEAD `91410a41605f9648e1f19a682800fbf70dd3bf3b`，检查时工作区干净 | 是检查时的快照 |
| 国内入口 | `qiuyuan.net` 指向现有广州 VPS；运行 Ubuntu 内核 6.8、Caddy 2.6.2 | 未升级任何软件 |
| Stocks 路由 | 活动 Caddy 配置精确匹配 `qiuyuan.net`，反代 `127.0.0.1:8000`，由反向 SSH 隧道连 Mac mini | 本次未查询 Stocks 数据库或私人接口 |
| 其他站点 | 同一 Caddy 还承载 `ntf.qiuyuan.net`，反代 `127.0.0.1:18820` | 接入方案也保护这条现有路由 |
| 其他服务 | DERP 使用 8443/TCP、3478/UDP；tinyproxy 只监听本地 8888；Caddy 使用公网 80/443、管理口仅本地 2019 | 不新增监听端口或防火墙规则 |
| 容量 | 根盘可用约 39 GB；内存 available 约 2.9 GB，swap 未使用 | 仅证明当前静态站规模有余量，不是压力测试 |
| 新域名 | VPS 递归 DNS 与 `dns21.hichina.com` 权威查询均返回 `search.qiuyuan.net` NXDOMAIN；权威 NS 为 dns21/dns22.hichina.com | 本轮未登录 DNS 控制台或修改记录 |
| 健康 | 从 MacBook 直连公网、从 VPS 公网和反向隧道检查 `/api/health`，均 HTTP 200、`{"status":"ok"}` | 不等于已登录页面、实时行情或全部业务验收 |
| Worker | `check.dumplingwild.com` 的 OPTIONS 返回 204；新域名 Origin 请求仍返回 `access-control-allow-origin: https://qiuyuanqr.github.io` | 新域名的浏览器跨域调用会被阻断，需要适配 |

本机一次 `dig` 查询超时后，改从 VPS 及域名权威 DNS 取证；没有将本机查询失败解释成域名不存在，没有修改本机 DNS 或代理。

## 隔离验证

从 Git HEAD 导出仅入库源码到系统临时目录，不含 `.env`、本机路径配置或未入库研究数据；复用已有 node_modules 后执行完整 `bun run build`：

- 退出码 0；232 篇报告，287 个 HTML 文件，Pagefind 索引 99 页。
- 最终产物 466 个文件、28,453,410 字节（约 28.5 MB）。
- 产物中 `data/` 目录数量为 0；未发现 `.env`、`CLAUDE.local.md`、`result.md`、`state.json` 这些本机/运行状态文件名。
- `2026-10-05_stock-002837` 仍按既有 `.parked` 排除。
- 临时证据目录：`/private/tmp/searchx-vps-review-cuq6ehlw/`，是可再生构建结果，不应上传整个目录。

这不是全文事实复核、浏览器验收或私密接口鉴权验收。没有代码改动，未重跑全量测试或真实模型任务。

还在 VPS 上用**当前已安装**的 Caddy 做候选配置语法解析：读取现有 Caddyfile，在内存追加下述站点，通过 `/dev/stdin` 传给 `caddy adapt`。解析后原 Stocks、通知站点的路由对象逐项相同，顶层全局配置相同，新增 host 仅为 `search.qiuyuan.net`。没有执行 validate、reload、启动新服务或申请证书。

初次使用新版文档的 `--config -` 形式被服务器旧版 Caddy 拒绝；使用 `/dev/stdin` 后成功。后续部署脚本必须适配现场 2.6.2，不能照新文档假设参数兼容。

勘察前后 `/etc/caddy/Caddyfile` SHA256 均为 `e9c589dfba21819b3759f9349ecc3e47a457aef3961f5c81a20a85df12ec8a44`；Caddy PID 均为 796，启动时间仍为 2026-09-28 22:17:02 CST，状态 active/running；结束时 Stocks 健康仍为 HTTP 200/ok。

## 推荐接法

采用独立子域名、独立静态目录，复用现有 Caddy：

```text
浏览器 → search.qiuyuan.net → VPS Caddy → /srv/searchx/current
浏览器 → 现有 searchX Worker → 现有研究/核查队列
```

候选新增站点块如下，**尚未写入服务器**：

```caddyfile
search.qiuyuan.net {
    root * /srv/searchx/current
    encode gzip
    file_server
}
```

使用独立子域名可以精确匹配站点，不需要在 Stocks 的 URL 路径和鉴权路由里插入 `/search`。单独加 HTTP 应用进程后仍需 Caddy 转发，反而增加端口与进程，因此静态文件直接由 Caddy 提供。

该方案与 Stocks 共用 VPS 和 Caddy，仍有共享故障边界。首次接入需要平滑 reload，不能承诺绝对零影响；通过配置校验、旧路由差异检查、健康前后对照、失败回退缩小风险。后续只切换静态版本目录，不再 reload Caddy。

## 更新与权限方案

建议保留现有 GitHub Pages，同时让 Mac mini 新增一条**仅负责静态发布**的流程：取得 main 最新且成功的 `Deploy site` 对应 `github-pages` 构建制品，核对 run/commit 身份、完成状态与制品文件边界，上传 VPS 的独立版本目录；验证后原子切换 `current`。仅制品下载/解包/上传，不触发研究或核查 runner。

这样两站用同一份 CI 构建结果，不把 Mac mini 仓库里的私有 `research/*/data/` 复制到公网。当前 `build.js` 会复制本地存在的 `data/`，所以**不能把常驻机当前工作区直接 build 后整个 rsync 当成生产发布**。制品不可用时保持旧版本并报告失败，不降级上传私有工作区。

日常上传建议使用仅有 `/srv/searchx` 发布权限的专用账号/SSH key，不向 GitHub 配置 VPS root 凭据，不让日常内容更新拥有 Caddy 配置或 Stocks 权限。本轮只确认 Mac mini 的 Bun、gh、rsync 和既有 VPS SSH 别名存在，未读取凭据、创建账号/密钥或验证制品下载权限。

发布要防旧 run 覆盖新版本、同一时刻重复切换、残缺解包和路径越界；文件校验完成后才切换。旧版保留以便回滚，清理旧版另按容量和授权确定，不能在首轮接入顺便删除。

## 正式接入前要完成的改动和检查

1. 在 DNS 新增 `search` 的 A 记录，目标为 `qiuyuan.net` 当前这台 VPS；不改根域名记录。执行前重新确认它未被他人创建。
2. 准备专用发布目录、账号和第一版静态制品；检查新域名从根路径访问时首页、报告、档案、搜索索引和资源引用均正常。
3. Worker 增加明确的双来源白名单，保留 GitHub Pages Origin 并允许新域名；动态返回被允许的 Origin，保留 `Vary: Origin`，不改成任意来源通配。覆盖提交、管理、核查、失败响应及 OPTIONS 的全部接线。
4. 使用系统现有 Caddy 版本生成候选配置，备份原文件与活动配置；验证旧站点语义未变且新文件可被 caddy 用户读取，完成正式 validate 后才写配置和平滑 reload。证书签发、HTTPS 和旧站健康均要实测；异常则恢复备份并平滑 reload，重新验旧站。
5. 新增静态发布流程并验证第一次和后续更新、失败保持旧版、回退、重复执行、旧提交防倒退；Pages 继续作为现有入口。
6. 新域名全链路可用后，再决定通知链接和 `RUNNER_SITE_BASE` 等是否切换。未验证 VPS 发布确认前，不提前把“Pages 已上线”等同“VPS 已上线”，也不让通知先指向未发布页面。

本次只获勘察范围，以上 DNS、生产站点、账号与服务写入尚未执行，待用户确认具体接入范围后推进。后续无需修改 Stocks 代码、服务、数据库、隧道或现有站点块。

## 参考

- [Caddy file_server](https://caddyserver.com/docs/caddyfile/directives/file_server)
- [Caddy adapt / validate / reload](https://caddyserver.com/docs/command-line)
- 当前项目的 `.github/workflows/deploy.yml`、`web/build/build.js`、Worker CORS 接线，以及 Stocks 仓库的 `scripts/vps/README.md` 和 `scripts/com.stocks.cn-tunnel.plist`；现场端口和路由取代这些文档中的旧快照。
