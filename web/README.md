# web — 信息流站

把 `research/` 的调研产出渲染成纸感信息流站，部署到 GitHub Pages（https://qiuyuanqr.github.io/searchX/）。

| 子目录 | 是什么 |
|---|---|
| `src/` | **源**：页面模板（`index.template.html` / `submit.template.html`）、前端资源（`assets/feed.css`、`feed.js`、`submit.js`）、站点配置（`site.config.json`，只放公开值） |
| `build/` | **构建逻辑**（注意：不是产物）：扫 `research/` 下各 `<日期>_<主题>/` 的 `notes.md` → 渲染信息流卡片 + 报告页。含构建脚本与单测，入口 `cli.js` |
| `dist/` | **构建产物**：`bun run build` 的输出（已 gitignore，CI 部署时现生成） |

## 构建 / 预览

```bash
bun run build      # = bun run web/build/cli.js && pagefind --site web/dist（含站内全文检索索引）
bun test           # 跑 build/ 下单测
bun run serve      # 构建 + 本地预览 http://localhost:8080
```

CI（`.github/workflows/deploy.yml`）在 push 动到 `research/**` 或 `web/**` 时自动跑 `bun run build` 并部署 Pages。卡片按 `notes.md` frontmatter 的 `created` 时间倒序（新内容置顶）。
