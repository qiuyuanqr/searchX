# searchX Intake Worker（M2a · 提交入队流程）

这是系统对外开放的唯一写入口（唯一能往后台写数据的公开入口）：站内提交表单把内容 POST 到这个 Cloudflare Worker，Worker 校验通过后在 GitHub 建一条 `pending` Issue 并通知作者。**整个过程不花钱、也不发布任何内容**——只有后续 M2b 跑 `/research` 才会消耗 Claude 额度。

```
站内表单 (submit.html, GitHub Pages)
   │  POST JSON {title, focus, email, message, turnstile}
   ▼
Cloudflare Worker (本目录)
   ├─ verifyTurnstile  人机验证（失败→403，不建 Issue）
   ├─ validateSubmission  必填/长度/邮箱/清洗（失败→400）
   ├─ checkRateLimit  每 IP/邮箱每日上限（KV，超限→429）
   ├─ createIssue  受限 token 建 `pending` Issue，指派+@作者（失败→502）
   └─ INTAKE_KV.put(`sub:<issue号>`, 真实邮箱)   ← 私密保存，留给 M2b Emailer
   ▼
GitHub Issues = 待审队列 → GitHub 原生邮件通知作者 → 作者贴 `approved` 才进 M2b
```

## 隐私红线（务必理解）

- **仓库是公开的，Issue 也公开。** 提交者的**真实邮箱绝不进 Issue 正文**——`formatIssue` 内部调 `maskEmail`，Issue 里只出现 `a***@gmail.com`（定长掩码：星号个数固定，不靠它透露本地名长度；单字符本地名连首字母也不露，输出 `***@gmail.com`）。
- 真实邮箱由 Worker 写进**私有 KV**（键 `sub:<issue号>`），只有持 Cloudflare 凭据的人能读，留给 M2b 的 Emailer 用。
- **任何密钥永不入库**：`TURNSTILE_SECRET` / `GITHUB_TOKEN` 只作为 Worker 机密存在 Cloudflare；仓库里只有 `wrangler.toml` 的公开 `[vars]` 和注释。`site.config.json` 里只放**公开值**（Worker URL、Turnstile **site** key）。

## 文件

| 文件 | 职责 |
|---|---|
| `src/validate.js` | `validateSubmission(input)` 必填/长度/邮箱/清洗 |
| `src/issue-format.js` | `formatIssue(clean,{author})` + `maskEmail(email)` 拼出 Issue 正文（把用户输入包进代码块，防止其中的 markdown 被当作格式渲染/注入） |
| `src/turnstile.js` | `verifyTurnstile(token,secret,ip,fetchImpl)` 调 siteverify |
| `src/ratelimit.js` | `checkRateLimit(kv,{...})` + `dayKey(date)` KV 每日计数 |
| `src/github.js` | `createIssue({...},fetchImpl)` 调 GitHub Issues API |
| `src/handler.js` | `handleIntake(request,env,deps)` 编排（CORS/方法/校验/限制提交频率/建 Issue/存邮箱） |
| `src/index.js` | Cloudflare 入口 `export default { fetch }` |
| `wrangler.toml` | Worker 配置（KV 绑定 `INTAKE_KV`、公开 `[vars]`；机密走 secret） |

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

### 3. 建 Cloudflare 账号（免费）+ Turnstile widget
Cloudflare dashboard → **Turnstile** → Add site：
- 域名填 `qiuyuanqr.github.io`，Widget mode = **Managed**。
- 记下 **Site Key**（公开，进 `site.config.json`）和 **Secret Key**（机密，进 Worker）。

### 4. 建 KV namespace
- wrangler：`bun x wrangler kv namespace create INTAKE_KV` → 把回显的 `id` 填进 `wrangler.toml` 的 `[[kv_namespaces]] id`。
- 或 dashboard：Workers & Pages → KV → Create namespace（名 `INTAKE_KV`），记 id 填 `wrangler.toml`。

### 5. 部署 Worker（二选一）

**A · wrangler（若 `bun x wrangler` 可用）**
```bash
cd services/intake-worker
bun x wrangler secret put TURNSTILE_SECRET   # 粘 Turnstile Secret Key
bun x wrangler secret put GITHUB_TOKEN        # 粘 fine-grained PAT
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
- **Variables**：加 `GITHUB_OWNER=qiuyuanqr`、`GITHUB_REPO=searchX`、`AUTHOR_LOGIN=qiuyuanqr`、`ALLOWED_ORIGIN=https://qiuyuanqr.github.io`（与 `wrangler.toml [vars]` 一致）。
- **Secrets（加密变量）**：加 `TURNSTILE_SECRET`、`GITHUB_TOKEN`。
- **KV Namespace Bindings**：绑 `INTAKE_KV` → 第 4 步建的 namespace。
- 部署，记下 Worker URL。

### 6. 回填站点配置并上线
把真值写入仓库根的 `web/src/site.config.json`：
```json
{
  "WORKER_URL": "https://searchx-intake.<subdomain>.workers.dev",
  "TURNSTILE_SITE_KEY": "0x4AAAAAAA…"
}
```
隐私最终检查（无任何用户私人信息）后：
```bash
bun test && bun run build
git add web/src/site.config.json
git commit -m "chore(M2a): wire live worker url + turnstile site key; publish submit page"
git push origin main          # 触发既有 Action 部署
```
约十几秒后 `https://qiuyuanqr.github.io/searchX/submit.html` 上线。

> ⚠️ **在第 6 步填真值之前不要把 submit 页推上线**——否则表单会 POST 到占位地址 `REPLACE_WITH_WORKER_URL`、必然失败。

### 7. 端到端验收（M2a「完成」定义）
1. 打开线上 `submit.html`，Turnstile 正常渲染（无 sitekey 报错）。
2. 填测试题目 + **你自己的邮箱**，过人机验证，提交 → 页面显示成功文案。
3. 仓库 Issues 出现一条 `pending` Issue：标题=题目，正文含**打码**邮箱、指派给你、@你。
4. 你的邮箱收到 GitHub 指派/提醒邮件。
5. 全程**无 `/research` 运行、无站点内容变更**（不花钱、不发布新报告）。
6. 反向：连发超过每日上限 → 返回限制提交频率的提示文案。
7. 清理：关掉测试 Issue。

---

## 留给 M2b 的接口
- 状态机：`pending → approved → done`（标签）。
- KV `sub:<issue号>` = 提交者真实邮箱（Emailer 取）。
- `wrangler.toml [vars]` 已定 owner/repo/author。
- M2b Runner 用同一受限 token + GitHub REST API 拉 `approved` 未 `done` 的 Issue。
