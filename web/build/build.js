import {
  rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, existsSync,
} from "fs";
import { join } from "path";
import { scanResearch } from "./scan.js";
import { renderIndex } from "./render-index.js";
import { injectConfig } from "./inject-config.js";
import { injectReportNav } from "./inject-report-nav.js";
import { findReportDefects } from "./validate-report.js";
import { fingerprintAssets } from "./fingerprint.js";
import { annotateSeries } from "./series.js";

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
  const scanned = scanResearch(root).filter((e) => {
    if (existsSync(join(root, e.dir, ".parked"))) {
      console.warn(`⚠️ 跳过 ${e.dir}：带 .parked 标记（上线前独立核验未过，已搁置）`);
      return false;
    }
    if (existsSync(join(root, e.dir, "report.html"))) return true;
    console.warn(`⚠️ 跳过 ${e.dir}：缺 report.html（半成品文件夹，本次不收录）`);
    return false;
  });

  // 同一标的的多份报告归成系列，给每条补 series 字段（第几次 / 间隔天数 / 更新版链接）。
  // 必须在上面的过滤之后算：被跳过的半成品不该占掉一个序号，否则线上会出现「第 3 次」却只有两篇。
  // 信息流卡片与 reports.json（搜索结果卡片读它）都用这一份，不各算一套。
  const entries = annotateSeries(scanned);

  // 报告副本：注入站点导航（回到顶部 + 返回档案首页）+ 页尾「继续阅读」（最近三篇、排除本篇），
  // 原始 report.html 不动
  const byDateDesc = [...entries].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  for (const e of entries) {
    const destDir = join(out, "r", e.dir);
    mkdirSync(destDir, { recursive: true });
    const reportHtml = readFileSync(join(root, e.dir, "report.html"), "utf8");
    // 发布前校验：拦住残留 {{TOKEN}} / 非法来源标签类流向公开站（让构建直接失败，而非静默上线）
    const defects = findReportDefects(reportHtml);
    if (defects.length) {
      throw new Error(`report.html 有问题，拒绝发布 ${e.dir}：\n  - ${defects.join("\n  - ")}`);
    }
    const related = byDateDesc
      .filter((x) => x.dir !== e.dir && !(x.series && x.series.newerHref))  // 继续阅读也不推旧版
      .slice(0, 3)
      .map((x) => ({ dir: x.dir, date: x.date, title: x.title }));
    // series 传给注入器：旧报告页挂「已有更新版」横幅并退出全文索引
    writeFileSync(join(destDir, "index.html"), injectReportNav(reportHtml, { related, series: e.series }));
    // data/ 已被 .gitignore（research/*/data/）排除在仓库外：CI 用干净 checkout 构建，
    // 该目录在那里根本不存在，这行只在本机 `bun run serve` 时（本机磁盘上确有 data/）生效，
    // 纯本机预览用途，不会把 data/ 带上公开站。
    const dataDir = join(root, e.dir, "data");
    if (existsSync(dataDir)) cpSync(dataDir, join(destDir, "data"), { recursive: true });
  }

  // 首页：注入卡片 + 提交配置（弹窗表单用 WORKER_URL / WORKER_FALLBACK_URL）
  // 先注模板占位符、再渲染卡片：反过来的话，笔记标题/导语里若出现 {{WORKER_URL}} 这样的
  // 字面字样，会被 injectConfig 一并替换成真实配置值（配置值本身不敏感，但内容被悄悄改写了）。
  const tpl = injectConfig(readFileSync(template, "utf8"), cfg);
  writeFileSync(join(out, "index.html"), renderIndex(entries, tpl));
  cpSync(assets, join(out, "assets"), {
    recursive: true,
    filter: (src) => !src.endsWith(".test.js"),
  });

  // 提交表单的"提交即查重"用：复制查重纯函数 + 产出精简报告清单。
  // dedup.js 与 runner 同一份源（无依赖、浏览器可直接 import），复制到 assets/ 供表单加载。
  cpSync(dedup, join(out, "assets", "dedup.js"));
  // reports.json：表单 fetch 后本地比对，判断"这只票是否已有报告"。只放查重所需字段，邮箱等私密信息绝不出现。
  // 旧报告（已有更新版）不进清单（2026-08-28）：搜索直配与查重都只看最新篇——查重按标的
  // 匹配最近一篇，最新篇本就比旧篇新，剔除旧篇不改变判定。
  const slim = entries
    .filter((e) => !(e.series && e.series.newerHref))
    .map((e) => ({
      title: e.title, type: e.type, date: e.date, slug: e.slug, tags: e.tags, href: e.href,
      ...(e.series ? { series: e.series } : {}),   // 搜索结果卡片据此出同样的角标
    }));
  writeFileSync(join(out, "reports.json"), JSON.stringify(slim));
  // reports.json 没有内容指纹（它是被 fetch 的数据文件、不是被引用的资源），新报告上线后
  // 短时窗口内浏览器仍可能用旧缓存清单，前端查重会漏掉最新那篇。给它一个短缓存声明帮不上忙
  //（Pages 不读这个），故由调用方 fetch 时带上构建版本号——见 assets/feed.js 的 loadReports。

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

  // 所有页面与资源都写完后，给静态资源引用打「内容版本号」（cache-busting）：内容一变版本就变、
  // 浏览器必然重载新脚本；不变则继续用缓存。根治「固定文件名脚本被浏览器长期卡在旧缓存」。
  fingerprintAssets({ out });

  return entries;
}
