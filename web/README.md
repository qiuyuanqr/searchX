# web — 信息流站

把 `research/` 的调研产出渲染成阅读型信息流站（2026-08-26 起：暖灰底 + 圆角白卡 + 珊瑚橙主色，衬线标题 + 无衬线正文，筛选按类型配色），部署到 GitHub Pages（https://qiuyuanqr.github.io/searchX/）。

| 子目录 | 是什么 |
|---|---|
| `src/` | **源**：页面模板（`index.template.html` 含提交弹窗 / `submit.template.html` 跳转壳 / `admin.template.html` 授权管理页 / `check.template.html` 私密核查提交页）、前端资源（`assets/feed.css`、`feed.js`、`feed-filter.js`、`submit.js`、`admin.js`、`admin-page.js`、`check.js`、`check-page.js`、`md.js`）、站点配置（`site.config.json`，只放公开值 Worker URL） |
| `build/` | **构建逻辑**（注意：不是产物）：扫描 `research/` 下各 `<日期>_<主题>/` 的 `notes.md` → 渲染信息流卡片 + 报告页。含构建脚本与单元测试，入口 `cli.js` |
| `dist/` | **构建产物**：`bun run build` 的输出（已 gitignore，CI 部署时现生成） |

## 构建 / 预览

```bash
bun run build      # = bun run web/build/cli.js && bun x pagefind --site web/dist（含站内全文检索索引）
bun test           # 跑 build/ 下的单元测试
bun run serve      # 构建 + 本地预览 http://localhost:8080
```

CI（`.github/workflows/deploy.yml`）在 push 改动到 `research/**`、`web/**`、`package.json`、`bun.lock`、`services/runner/src/dedup.js` 或该 workflow 文件本身时，自动跑 `bun run build` 并部署到 Pages。卡片排序以**目录名日期**为主序（降序），同一天内才按 frontmatter 的 `created` 精确时间排——目录名里的日期写错，frontmatter 救不回来。
