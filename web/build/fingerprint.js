// web/build/fingerprint.js — 给构建产物的静态资源引用打「内容版本号」，根治浏览器缓存旧脚本。
//
// 背景：站点资源是固定文件名（assets/check-page.js 等，无 hash）。浏览器一旦缓存，
// 即使 push 了新版，普通模式也会继续用旧脚本，直到缓存过期或手动清——每次改前端都被坑一次。
//
// 做法：算「所有 assets 联合内容」的单一 hash 当全站版本号，注入到每处引用后加 ?v=<hash>：
//   - 页面 HTML 里 <script src> / <link href> 指向的 assets/*.js|css
//   - assets/*.js 之间的相对 import（./x.js、../x.js）——漏了这层，模块间的更新照样穿不透缓存
// 内容一变 → hash 变 → 所有引用的 URL 变 → 浏览器视为新资源必然重新加载；
// 内容不变 → hash 不变 → URL 不变 → 继续吃缓存，不做无谓重下。
//
// 为何用「全站统一版本号」而非逐文件 hash：逐文件要按 import 依赖拓扑排序（改叶子的 hash 会
// 冒泡到引用方），对这个只有几个小文件的站是过度工程。统一版本号下任一文件变则全部一起重载，
// 代价可忽略，换来实现简单 + 绝不漏更新。
//
// 边界（诚实说明）：HTML 入口页自身的 URL 是用户直接输入的、无法打指纹，其更新传播仍受
// GitHub Pages 对 .html 约 10 分钟缓存约束（静态托管改不了响应头）。但只要 HTML 一刷新，
// 它引用的脚本因 ?v= 变化必定是最新的——即根治了「脚本被长期卡在旧缓存」这一核心问题。

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

// 纯函数：把 HTML 里 (src|href)="assets/X.js|css" 改写为加 ?v=<version>。
// 只动 .js/.css（favicon 等无所谓）、只动 assets/ 开头（不碰外链）、跳过已带 query 的（幂等）。
export function addVersionToHtml(html, version) {
  return html.replace(
    /((?:src|href)=")(assets\/[^"?]+\.(?:js|css))(")/g,
    (_, pre, path, quote) => `${pre}${path}?v=${version}${quote}`,
  );
}

// 纯函数：把 JS 里的相对 import（静态 from "./x.js" 与动态 import("./x.js")）改写为加 ?v=<version>。
// 只动以 ./ 或 ../ 开头、.js 结尾的相对路径；跳过已带 query 的（幂等）；裸模块名与非 .js 一律不碰。
export function addVersionToImports(js, version) {
  return js.replace(
    /(from\s*["']|import\(\s*["'])(\.\.?\/[^"'?]+\.js)(["'])/g,
    (_, pre, path, quote) => `${pre}${path}?v=${version}${quote}`,
  );
}

// 对已构建好的 dist 目录做指纹后处理：算版本号 → 改写所有 HTML 引用 + 所有 assets/*.js 的 import。
// 必须在 dist 全部写完之后调用。返回注入的版本号（供日志/测试）。
export function fingerprintAssets({ out = "web/dist" } = {}) {
  const assetsDir = join(out, "assets");

  // 版本号 = 所有 .js/.css 原始内容的联合 sha256 前 10 位（按文件名排序求稳定、可复现）。
  // 注意：先在改写 import 之前算，基于「原始内容」——改写是确定性的，原始不变则版本不变。
  const assetFiles = readdirSync(assetsDir).filter((n) => /\.(?:js|css)$/.test(n)).sort();
  const h = createHash("sha256");
  for (const n of assetFiles) h.update(readFileSync(join(assetsDir, n)));
  const version = h.digest("hex").slice(0, 10);

  // 所有页面 HTML：改写资源引用
  for (const n of readdirSync(out).filter((n) => n.endsWith(".html"))) {
    const p = join(out, n);
    writeFileSync(p, addVersionToHtml(readFileSync(p, "utf8"), version));
  }
  // 所有 assets/*.js：改写模块间 import
  for (const n of assetFiles.filter((n) => n.endsWith(".js"))) {
    const p = join(assetsDir, n);
    writeFileSync(p, addVersionToImports(readFileSync(p, "utf8"), version));
  }
  return version;
}
