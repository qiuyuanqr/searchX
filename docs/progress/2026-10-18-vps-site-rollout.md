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

## 待完成的真实部署

主线CI、Worker实际双Origin、VPS受限发布账号与目录、Mac mini定时器、新DNS和Caddy备份/校验/平滑reload、真实HTTPS/浏览器和Stocks健康前后对照仍按顺序执行。不能将当前代码验证等同已上线。
