import {
  rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, existsSync,
} from "fs";
import { join } from "path";
import { scanResearch } from "./scan.js";
import { renderIndex } from "./render-index.js";
import { injectConfig } from "./inject-config.js";
import { injectReportNav } from "./inject-report-nav.js";

export function build({
  root = "research",
  out = "web/dist",
  assets = "web/src/assets",
  template = "web/src/index.template.html",
  submitTemplate = "web/src/submit.template.html",
  config = "web/src/site.config.json",
} = {}) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const entries = scanResearch(root);
  const cfg = JSON.parse(readFileSync(config, "utf8"));

  // 报告副本：注入站点导航（回到顶部 + 返回档案首页），原始 report.html 不动
  for (const e of entries) {
    const destDir = join(out, "r", e.dir);
    mkdirSync(destDir, { recursive: true });
    const reportHtml = readFileSync(join(root, e.dir, "report.html"), "utf8");
    writeFileSync(join(destDir, "index.html"), injectReportNav(reportHtml));
    const dataDir = join(root, e.dir, "data");
    if (existsSync(dataDir)) cpSync(dataDir, join(destDir, "data"), { recursive: true });
  }

  // 首页：注入卡片 + 提交配置（弹窗表单用 WORKER_URL / TURNSTILE_SITE_KEY）
  const tpl = readFileSync(template, "utf8");
  writeFileSync(join(out, "index.html"), injectConfig(renderIndex(entries, tpl), cfg));
  cpSync(assets, join(out, "assets"), {
    recursive: true,
    filter: (src) => !src.endsWith(".test.js"),
  });

  // submit.html：保留旧网址，跳转回主页并打开提交弹窗（#submit）
  const submitTpl = readFileSync(submitTemplate, "utf8");
  writeFileSync(join(out, "submit.html"), injectConfig(submitTpl, cfg));

  return entries;
}
