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
  adminTemplate = "web/src/admin.template.html",
  checkTemplate = "web/src/check.template.html",
  config = "web/src/site.config.json",
  dedup = "services/runner/src/dedup.js", // 查重纯函数：复制给浏览器表单用，单一源、不漂移
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

  // 提交表单的"提交即查重"用：复制查重纯函数 + 产出精简报告清单。
  // dedup.js 与 runner 同一份源（无依赖、浏览器可直接 import），复制到 assets/ 供表单加载。
  cpSync(dedup, join(out, "assets", "dedup.js"));
  // reports.json：表单 fetch 后本地比对，判断"这只票是否已有报告"。只放查重所需字段，邮箱等私密信息绝不出现。
  const slim = entries.map((e) => ({
    title: e.title, type: e.type, date: e.date, slug: e.slug, tags: e.tags, href: e.href,
  }));
  writeFileSync(join(out, "reports.json"), JSON.stringify(slim));

  // submit.html：保留旧网址，跳转回主页并打开提交弹窗（#submit）
  const submitTpl = readFileSync(submitTemplate, "utf8");
  writeFileSync(join(out, "submit.html"), injectConfig(submitTpl, cfg));

  // admin.html：授权管理页（纯密钥闸，注入 WORKER_URL）。noindex + data-pagefind-ignore，
  // 站内任何位置不放入口链接（安全不靠藏网址，但也不主动暴露）。
  const adminTpl = readFileSync(adminTemplate, "utf8");
  writeFileSync(join(out, "admin.html"), injectConfig(adminTpl, cfg));

  // check.html：私密事实核查提交页（纯密钥闸，注入 WORKER_URL）。noindex + data-pagefind-ignore，
  // 站内不放入口链接；真正的锁在 Worker 端（CHECK_KEY 校验）。
  const checkTpl = readFileSync(checkTemplate, "utf8");
  writeFileSync(join(out, "check.html"), injectConfig(checkTpl, cfg));

  return entries;
}
