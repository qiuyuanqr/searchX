# searchX Intake Worker（M2a + 授权自助放行）

这是系统对外开放的唯一写入口：站内提交表单把内容 POST 到这个 Cloudflare Worker。**只有持「专属链接」的授权用户能提交**——链接里带一个只属于本人的 token，Worker 凭它反查邮箱、确认身份。干净内容直接建 `approved` Issue（runner 自动跑、无需人工）；命中安全初筛红旗的可疑件降级 `pending`，等作者手动核对后再放行。授权名单由作者在 `admin.html`（凭 `ADMIN_KEY`）管理。

```
专属链接打开站点 (?k=<token>) → 站内表单
   │  POST JSON {k, title, focus, message}
   ▼
Cloudflare Worker (本目录)
   ├─ emailForToken(k)     token 反查邮箱（无效→403 unauthorized，不建 Issue）
   ├─ validateContent      必填/长度/清洗（失败→400）；email 不来自表单
   ├─ screenSubmission     安全初筛红旗（命中→降级 pending）
   ├─ peek/commitRateLimit 每 IP/邮箱每日上限（KV，超限→429）
   ├─ createIssue          干净→`approved` / 可疑→`pending`，指派+@作者（失败→502）
   └─ INTAKE_KV.put(`sub:<issue号>`, 真实邮箱)   ← 私密保存，留给 runner 发信
   ▼
GitHub Issues → runner 取 approved 自动跑 /research（pending 等作者手动批）
```

**其它路由：** `GET /verify?k=`（提交前确认 token、回显打码邮箱）、`GET|POST /admin/*`（授权名单增/查/删/轮换，凭 `ADMIN_KEY`）、`GET /sub/<n>`（runner 取邮箱，凭 `SUB_READ_SECRET`）。

## 授权白名单 / 专属链接 / 管理页

- **授权 = 持有专属链接**。作者在 `admin.html` 加一个邮箱 → Worker 生成该人专属 token、双向存 KV（`invite:<token>→email`、`allow:<encEmail>→{token,addedAt}`，**永不过期**），返回链接 `<站点>/?k=<token>`。作者私发给本人。
- **撤销 / 轮换**：删 `allow:`+`invite:` 双键即让链接立即失效；轮换 = 撤旧发新。
- **邮箱不由用户输入**：提交时邮箱来自 token 映射，杜绝冒充他人 / 往邮箱字段塞注入。
- **管理页访问控制**：`admin.html` 是纯密钥闸（输对 `ADMIN_KEY` 前不加载任何数据）；真正鉴权在 Worker 服务端逐次 `safeEqual` 校验；错误密钥按 IP 计数、超 `ADMIN_MAX_FAILS_PER_HOUR` 临时 429 锁定；管理凭证与提交 token 完全隔离（提交 token 对 `/admin/*` 无效）。

## 隐私红线（务必理解）

- **仓库是公开的，Issue 也公开。** 提交者的**真实邮箱绝不进 Issue 正文**——`formatIssue` 内部调 `maskEmail`，Issue 里只出现 `a***@gmail.com`（定长掩码：星号个数固定，不靠它透露本地名长度；单字符本地名连首字母也不露，输出 `***@gmail.com`）。
- 真实邮箱由 Worker 写进**私有 KV**（提交记录键 `sub:<issue号>`，60 天过期；授权名单键 `allow:<email>` 长期有效），只有持 Cloudflare 凭据的人能读。
- **任何密钥永不入库**：`GITHUB_TOKEN` / `SUB_READ_SECRET` / `ADMIN_KEY` / `CHECK_KEY` / `CHECK_RUNNER_SECRET` 只作为 Worker 机密存在 Cloudflare；仓库里只有 `wrangler.toml` 的公开 `[vars]` 和注释。`site.config.json` 里只放**公开值**（Worker URL）。

## 文件

| 文件 | 职责 |
|---|---|
| `src/validate.js` | `validateContent(input)` 必填/长度/清洗（不含 email）+ `screenSubmission` 安全初筛 |
| `src/issue-format.js` | `formatIssue(clean,{author,flags,approved})` + `maskEmail`；按 approved/pending 分流标签与措辞 |
| `src/invite.js` | token 生成 + 白名单 KV 读写（`mintInvite`/`emailForToken`/`listPeople`/`revoke`/`rotate`） |
| `src/admin.js` | `handleAdmin` —— `/admin/*` 鉴权（`ADMIN_KEY`）+ 失败限流 + 增/查/删/轮换 |
| `src/verify.js` | `handleVerify` —— `GET /verify?k=` 提交前确认 token、回显打码邮箱 |
| `src/safe-equal.js` | `safeEqual(a,b)` 定长时间比较（admin / sub-read 共用） |
| `src/ratelimit.js` | `peek/commitRateLimit(kv,{...})` + `dayKey(date)` KV 每日计数 |
| `src/github.js` | `createIssue({...},fetchImpl)` 调 GitHub Issues API |
| `src/sub-read.js` | `handleSubRead` —— `GET /sub/<n>` 取提交者邮箱（`SUB_READ_SECRET`） |
| `src/handler.js` | `handleIntake(request,env,deps)` 提交编排（token 鉴权/校验/限频/建 Issue/存邮箱） |
| `src/index.js` | Cloudflare 入口：路由 `/sub`、`/admin`、`/verify`、提交 |
| `wrangler.toml` | Worker 配置（KV 绑定、公开 `[vars]`；机密走 secret） |

## 本地开发 / 测试

全部纯函数 + 注入 `fetch`/假 KV，**离线可测**（不碰真实 Cloudflare/GitHub）：

```bash
bun test                     # 根目录跑，递归含 services/**/*.test.js
bun run build:worker         # 打成单文件 services/intake-worker/dist/worker.js（dist/ 已 gitignore）
```

> Bun 打包的默认导出形如 `export { src_default as default }`——这是合法 ESM 默认导出，Cloudflare module Worker 能正确解析。

---

## 一次性运维 + 部署 Runbook（需作者本人操作）

> `{owner}=qiuyuanqr`、`{repo}=searchX`、`{author}=qiuyuanqr`。**凭据永不入库。**

### 1. 建四个状态标签
GitHub 网页 → `qiuyuanqr/searchX` → Issues → Labels → New label，建：
`pending`、`approved`、`rejected`、`done`。
（`createIssue` 带 `labels:["pending"]`，标签须先存在；这四个也给 M2b 用。）

### 2. 建受限 GitHub token（fine-grained）
Settings → Developer settings → **Fine-grained tokens** → Generate：
- Resource owner = `qiuyuanqr`；Repository access = **Only select repositories → searchX**。
- Permissions → Repository → **Issues: Read and write**（其余全 No access）。
- 复制 token（形如 `github_pat_…`）。**只贴进 Cloudflare 机密，绝不入库。**

### 3. 生成三把随机密钥 `ADMIN_KEY` / `CHECK_KEY` / `CHECK_RUNNER_SECRET`
```bash
openssl rand -hex 24   # ADMIN_KEY：admin.html 授权管理页的唯一钥匙，只有你一个人持有
openssl rand -hex 24   # CHECK_KEY：作者提交私密核查任务（POST /check）
openssl rand -hex 24   # CHECK_RUNNER_SECRET：check-runner 取/标任务，与 runner 侧 .env 同值
```
各记下输出 → 第 5 步设为对应 Worker secret。
- `ADMIN_KEY` / `CHECK_KEY` / `CHECK_RUNNER_SECRET` 都漏配则相应路由静默 401：`/admin/*` 进不去、`/check` 提交失败、check-runner 取不到任务。
- `CHECK_RUNNER_SECRET` 须与 check-runner 本机 `.env` 里的同名变量**同值**（见 [check-runner README](../check-runner/README.md)）。
（授权改造后**不再需要 Turnstile**——提交由专属链接 token 鉴权；`TURNSTILE_SECRET` 已作废，旧版若配过可直接删。）

### 4. 建 KV namespace
- wrangler：`bun x wrangler kv namespace create INTAKE_KV` → 把回显的 `id` 填进 `wrangler.toml` 的 `[[kv_namespaces]] id`。
- 或 dashboard：Workers & Pages → KV → Create namespace（名 `INTAKE_KV`），记 id 填 `wrangler.toml`。

### 5. 部署 Worker（二选一）

**A · wrangler（若 `bun x wrangler` 可用）**
```bash
cd services/intake-worker
bun x wrangler secret put GITHUB_TOKEN          # 粘 fine-grained PAT
bun x wrangler secret put ADMIN_KEY             # 粘第 3 步生成的管理密钥
bun x wrangler secret put SUB_READ_SECRET       # runner 取邮箱用（见 runner README）
bun x wrangler secret put CHECK_KEY             # 作者提交核查任务（第 3 步生成）
bun x wrangler secret put CHECK_RUNNER_SECRET   # check-runner 取/标任务（第 3 步生成，与 runner 侧同值）
bun x wrangler deploy
```
记下 Worker URL（形如 `https://searchx-intake.<subdomain>.workers.dev`）。

**B · dashboard 粘贴（本机无 node/wrangler 时的备用方案）**

> ⚠️ `dist/worker.js` 是构建产物、**已 gitignore（不入库）**，仓库里可能根本没有、或是过期版本。粘贴前**务必先重新构建**——否则会把旧代码贴上线（例如旧版打码逻辑会按星号个数泄露邮箱长度）。用下面这条「构建 + 拷进剪贴板」一步到位，避免贴到旧文件：

```bash
# 在仓库根目录跑：重建产物，并直接拷进剪贴板（macOS）
bun run build:worker && cat services/intake-worker/dist/worker.js | pbcopy
```
Workers & Pages → Create Worker → 编辑器**粘贴刚拷贝的内容**（即最新构建的 `dist/worker.js`）→ Settings：
- **Variables**：加 `GITHUB_OWNER=qiuyuanqr`、`GITHUB_REPO=searchX`、`AUTHOR_LOGIN=qiuyuanqr`、`ALLOWED_ORIGIN=https://qiuyuanqr.github.io`、`MAX_PER_EMAIL_PER_DAY=5`、`ADMIN_MAX_FAILS_PER_HOUR=10`（与 `wrangler.toml [vars]` 一致）。
- **Secrets（加密变量）**：加 `GITHUB_TOKEN`、`ADMIN_KEY`、`SUB_READ_SECRET`、`CHECK_KEY`、`CHECK_RUNNER_SECRET`（后两把见第 3 步；漏配则 `/check` 路由静默 401）。
- **KV Namespace Bindings**：绑 `INTAKE_KV` → 第 4 步建的 namespace。
- 部署，记下 Worker URL。

### 6. 回填站点配置并上线
把真值写入仓库根的 `web/src/site.config.json`（授权改造后只需 Worker URL）：
```json
{
  "WORKER_URL": "https://searchx-intake.<subdomain>.workers.dev"
}
```
隐私最终检查（无任何用户私人信息）后：
```bash
bun test && bun run build
git add web/src/site.config.json
git commit -m "chore: wire live worker url; publish submit + admin pages"
git push origin main          # 触发既有 Action 部署
```
约十几秒后首页与 `admin.html` 上线。

> ⚠️ **先部署 Worker（带 `ADMIN_KEY` 等机密）再让前端上线**——否则 `admin.html` 验证密钥、`/verify` 都连不通。

### 7. 端到端验收（「完成」定义）
1. 打开线上 `admin.html`，输 `ADMIN_KEY` → 进管理面板（错密钥→提示、连错多次→临时锁定）。
2. 加一个**你自己的测试邮箱** → 复制生成的专属链接。
3. 无痕窗口打开专属链接 `…/?k=<token>` → 提交弹窗显示「已授权（打码邮箱）」→ 填题目提交 → 成功文案。
4. 仓库 Issues 出现一条 **`approved`** Issue：标题=题目，正文含**打码**邮箱、状态标「自动放行」；runner 下一轮自动跑。
5. 反向①：去掉 `?k=` 直接打开站点 → 提交被禁用、提示「需要专属链接」。
6. 反向②：把题目写成命中红旗（如含 ```` ``` ````）→ 建的是 **`pending`**（降级人工），不自动跑。
7. 清理：`admin.html` 撤销测试邮箱（链接立即失效）、关掉测试 Issue。

---

## 接口（给 runner / 站点）
- 状态机：`approved`（自动/手动）→ `done`；可疑件 `pending → approved → done`。
- KV：`sub:<issue号>`=提交者邮箱（runner 取，60 天）；`invite:<token>`/`allow:<email>`=授权名单（永久，admin 管理）。
- `/admin/*`（`ADMIN_KEY`）、`/verify?k=`、`/sub/<n>`（`SUB_READ_SECRET`）。
- runner 用受限 token 拉 `approved` 未 `done` 的 Issue（不变）。
