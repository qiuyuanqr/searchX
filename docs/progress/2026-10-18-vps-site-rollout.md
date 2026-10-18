# searchX 国内静态站接入实施记录

更新时间：2026-10-18 22:43（北京时间）。用户已明确授权发布脚本、双域名接口、验证通过后新增DNS/站点，保护Stocks并保留回滚。

## 本地实现与部署前验证

- 独立托管工作树，任务以 b9db1f0 为基线；主工作区未用于代码编辑。
- Worker 共用精确 Origin 白名单：保留 GitHub Pages 并增加 search.qiuyuan.net；未知来源不反射，原 token/密钥/限频不变；路由 404/405 与兜底500同样适配。
- 新增 services/site-publisher：同次成功 main CI 的公开压缩静态包与身份/长度/SHA256 manifest；Mac mini仅下载已验证公开包，专用SSH强制命令接收，完整内容/路径自校验后原子提交单一 active 指针。current/previous/state同一generation生效；保留旧版，回滚幂等且held防止同次构建自动恢复坏版。
- 文件与资源子目录先fsync；gzip先按真实解压字节限制，再扫描/限制PAX和GNU元数据，最后才解析tar；不允许私有data/本机配置、链接或越界路径。
- Mac mini现有gh可以读公开workflow元数据，但Actions制品下载实测401 Requires authentication，因此改为CI同时生成公开静态下载包；未复制token、改变登录或增加GitHub账号权限。
- 最终本机全量Bun：1456 pass / 1 skip / 0 fail，4121 assertions；其中包含21项Python发布、故障注入和打包测试。完整构建232篇，Worker构建成功。
- 真浏览器本地根路径：搜索“出版传媒”命中并打开报告；无授权提交弹窗明确提示、按钮禁用。未提交真实调研任务。
- 实际GitHub Pages run 39118786786的真实tar：232篇接收成功，重复unchanged，status ok。最终公开gzip全量回放也通过，约12.2MB，内容未含私有data。
- 独立代码复审最终通过，无剩余Critical/Important。复审曾发现并已复现修复：Pagefind文件格式；中断时回滚指针撕裂；nested元数据导致后续校验失败；回滚成功但响应丢失后的幂等；资源持久化；gzip扩展头绕过展开限额。

## 真实部署与验收（2026-10-18 22:57 增量）

本次授权范围已完成部署。以下是本轮实测快照，不是永久健康保证。

| 对象 | 实测结果 |
|---|---|
| 实现提交 | `9d28aa6d666b347be0b9c4ccc69b9df3ea3a592e`，main已推送，Mac mini在共享gitsync/importer锁保护下快进到该提交；工作区干净 |
| Pages | run `39137277469`，run_number `1791`，build/deploy/smoke均success；公开manifest绑定上述commit/run，包长12,206,691字节，SHA256 `fdadddcb67d082719580cb2487abaab3b958eaad50511643c5f9408751d200f6` |
| VPS静态版本 | `/srv/searchx/releases/1791-9d28aa6d666b347be0b9c4ccc69b9df3ea3a592e/`，466个公开文件、232篇报告；根metadata为发布器另外生成。Mac mini真实发布返回published，重复检查unchanged |
| 发布权限 | root所有接收程序 `/usr/local/lib/searchx-site/receiver.py`，SHA256 `ffdce19c7572db03fdff7fdc6cf7b1bc49902f6bad6dd5d6cd14a667ea85f1bb`；`searchx-publish`只拥有静态发布根。home/.ssh/authorized_keys均由root管理，`restrict,command=...`；传入`id`仍只能执行接收协议，未得到shell |
| 专用key | 私钥仅在Mac mini `~/.ssh/id_ed25519_searchx_publish`，未读取/输出/复制私钥；只将公钥传入VPS。未修改任何既有SSH配置、root key或其他账号 |
| Mac mini服务 | 新增`~/Library/LaunchAgents/com.searchx.site-publisher.plist`，与仓库模板hash一致；300秒，RunAtLoad=false，已bootstrap并首轮kickstart与22:58自然定时轮询均退出0（runs=2），两次日志均unchanged/run1791。日志在`~/Library/Logs/searchx-site-publisher/`，state/锁在`~/Library/Application Support/searchx-site-publisher/`。此前不存在此服务，无旧配置被覆盖 |
| Worker | 原版本`98a352f0-e02d-4341-9917-b708837a5de0`；新版本`3335e0ef-618c-4d79-992d-d3dfdec0c64b`，22:46部署成功，stamp为实现commit。两个合法Origin和相似恶意域名，8条浏览器路由共24个真实OPTIONS检查通过，未知来源无ACAO |
| DNS | 阿里云DNS控制台只新增`search` A→`8.148.234.233`，默认TTL600秒；记录数6→7，原`@`、ntf和邮件记录保留。权威DNS已返回新记录。曾因标签页跳往非DNS的轻量服务器控制台被Codex自动审批拒绝读取，未绕过；后续仅在独立DNS页面执行已授权操作 |
| Caddy | 备份`/var/backups/searchx/20261018-224412/`；原file与活动配置一致。新增host前后逐项对照旧配置，只允许新路由和Caddy自动生成的新host日志排除项；validate通过，再平滑reload。PID前后796，启动时间仍2026-09-28 22:17:02 CST，未restart |
| 新站 | https://search.qiuyuan.net/ HTTPS200，证书校验正常。真浏览器搜索出版传媒、打开报告与判断档案图表、无授权提交禁用、核查页密钥门禁均通过 |
| Stocks | 部署前、证书等待、回退和成功加载后反复检查`/api/health`均200/ok；未改其代码/数据库/服务/隧道。未登录业务或检查私人数据，不扩大为全业务验收 |

### 首次加载的真实回退

最初“移除新增站点后全配置应相同”检查发现Caddy 2.6为不记访问日志的新站自动增加`logs.skip_hosts`，在写线上前停止。确认只有新host的这一自动派生项后，仍对全部旧配置严格比较。

第一次reload后证书进入签发阶段，但40秒就绪窗口太短，检查按设计恢复了原Caddyfile并平滑reload，Stocks仍200/ok。第二次重新核对原配置并validate，允许最长180秒证书等待且持续检查Stocks；签发完成后新HTTPS200，PID始终796。原备份与`activation-result.json`留在上述root私有备份目录。

原Caddyfile SHA256：`e9c589dfba21819b3759f9349ecc3e47a457aef3961f5c81a20a85df12ec8a44`；新Caddyfile SHA256：`ddcea16230627aebd98896347d64e33d57544e83c4ec5c8b8bd8c42b9266fb27`。

## 回滚操作

**当前是首发，只有run1791这一版正文，没有上一版正文可切。** 首发撤回使用下面的Caddy配置回退；后续成功发布产生previous后，才可执行正文回滚。

正文回滚（Mac mini，仅切静态generation，不reload Caddy）：

```sh
/bin/sh /Users/yangqiuyuan/Coding/searchX/services/site-publisher/publish-cron.sh status
/bin/sh /Users/yangqiuyuan/Coding/searchX/services/site-publisher/publish-cron.sh rollback
```

回滚是幂等的，同次构建不会被下一轮重新发布；更高成功run会继续更新。如需长期停在回滚版，先bootout `com.searchx.site-publisher`，不操作其他服务。旧版本和generation均未自动清理。

首发配置回退（在VPS，以root执行；**先检查当前文件仍是本轮版本，若有其他维护者后续改动则停止，不能盲目覆盖整份旧配置**）：

```sh
python3 - <<'PY'
import pathlib, hashlib, subprocess, os, tempfile, json, urllib.request
live = pathlib.Path('/etc/caddy/Caddyfile')
backup = pathlib.Path('/var/backups/searchx/20261018-224412')
assert hashlib.sha256(live.read_bytes()).hexdigest() == 'ddcea16230627aebd98896347d64e33d57544e83c4ec5c8b8bd8c42b9266fb27', '配置已被后续修改，停止'
subprocess.run(['caddy', 'validate', '--config', str(backup / 'Caddyfile'), '--adapter', 'caddyfile'], check=True)
attrs = json.loads((backup / 'metadata.json').read_text())
fd, name = tempfile.mkstemp(prefix='.searchx-rollback-', dir=str(live.parent))
with os.fdopen(fd, 'wb') as f:
    f.write((backup / 'Caddyfile').read_bytes()); f.flush(); os.fsync(f.fileno())
os.chown(name, attrs['uid'], attrs['gid']); os.chmod(name, attrs['mode'])
os.replace(name, live)
subprocess.run(['caddy', 'reload', '--config', str(live), '--adapter', 'caddyfile'], check=True)
with urllib.request.urlopen('https://qiuyuan.net/api/health', timeout=10) as response:
    assert response.status == 200 and json.load(response)['status'] == 'ok'
print('原配置已恢复，Stocks健康正常')
PY
```

这会撤下新站Caddy路由，保留原Stocks/通知站点；不删DNS、版本、账号或key。DNS如需暂时停用，单独操作本次新增的search记录，不能删除/改根记录。Worker若需回退，新旧版本ID已记录；既有GitHub Pages Origin一直保留。

## 验收边界与下一步

- 页面/发布/接口接入已实测；未创建真实研究或核查任务、未发送通知，故不声称真实模型任务与邮件在新入口完成验收。
- 旧GitHub Pages入口和既有通知链接保留；没有读取、迁移旧站localStorage中的授权token或核查密钥。新域名仍需用户用原凭证授权。
- 手机蜂窝网络的真实访问体感尚待用户验证；这是接下来最有价值的一项检查。
- 临时目录是可再生构建/测试证据，不含私钥；未清理其他会话工作树。任务分支已合入main，托管工作树在最终交接保存后归档，不删除分支。


### 最终本地归属核对

main上本任务仅精确提交HANDOFF、CHANGES、实施记录和实施计划的交接增量。收尾时发现另有两个未跟踪文件 `scripts/session-end-status.test.js`、`scripts/test_session_end_status.py`，归属其他进行中工作；本任务没有读取内容、暂存、提交或清理它们。不要执行全目录add或会自动add -A的同步脚本来处理这些文件。
