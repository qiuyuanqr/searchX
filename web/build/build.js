import {
  rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, existsSync,
} from "fs";
import { join } from "path";
import { scanResearch } from "./scan.js";
import { renderIndex } from "./render-index.js";
import { injectConfig } from "./inject-config.js";
import { injectReportNav } from "./inject-report-nav.js";
import { findReportDefects } from "./validate-report.js";

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

  const cfg = JSON.parse(readFileSync(config, "utf8"));

  // scan 的收录门禁只看 notes.md，但下面要读 report.html。缺 report.html 的半成品文件夹
  // （如 runner 中断留下的）不该让整次构建崩溃——跳过它（连同它的首页卡片），其余照常产出。
  const entries = scanResearch(root).filter((e) => {
    if (existsSync(join(root, e.dir, "report.html"))) return true;
    console.warn(`⚠️ 跳过 ${e.dir}：缺 report.html（半成品文件夹，本次不收录）`);
    return false;
  });

  // 报告副本：注入站点导航（回到顶部 + 返回档案首页），原始 report.html 不动
  for (const e of entries) {
    const destDir = join(out, "r", e.dir);
    mkdirSync(destDir, { recursive: true });
    const reportHtml = readFileSync(join(root, e.dir, "report.html"), "utf8");
    // 发布前校验：拦住残留 {{TOKEN}} / 非法来源标签类流向公开站（让构建直接失败，而非静默上线）
    const defects = findReportDefects(reportHtml);
    if (defects.length) {
      throw new Error(`report.html 有问题，拒绝发布 ${e.dir}：\n  - ${defects.join("\n  - ")}`);
    }
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
