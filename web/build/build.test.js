import { test, expect, afterAll } from "bun:test";
import { build } from "./build.js";
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "fs";

const OUT = "web/build/fixtures/out";
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

// 临时造一个研究根，用完即清——用于 dc-3 / sl-5 的健壮性测试。
function makeTmpRoot(name, files) {
  const root = `web/build/fixtures/${name}`;
  rmSync(root, { recursive: true, force: true });
  for (const [path, content] of Object.entries(files)) {
    const full = `${root}/${path}`;
    mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}
const COMMON = {
  assets: "web/src/assets",
  template: "web/src/index.template.html",
  submitTemplate: "web/src/submit.template.html",
  config: "web/build/fixtures/site.config.json",
};

test("build 产出首页、报告副本、资产", () => {
  const entries = build({
    root: "web/build/fixtures/research",
    out: OUT,
    assets: "web/src/assets",
    template: "web/src/index.template.html",
  });
  expect(entries.length).toBe(2);
  expect(existsSync(`${OUT}/index.html`)).toBe(true);
  expect(existsSync(`${OUT}/r/2026-06-02_beta/index.html`)).toBe(true);
  expect(existsSync(`${OUT}/assets/feed.css`)).toBe(true);

  const home = readFileSync(`${OUT}/index.html`, "utf8");
  expect(home).toContain("Beta 板块");
  expect(home).not.toContain("<!-- CARDS -->");

  const report = readFileSync(`${OUT}/r/2026-06-02_beta/index.html`, "utf8");
  expect(report).toContain("beta 正文");
});

test("build 产出查重资产：assets/dedup.js + 精简 reports.json（含查重所需字段、不含私密）", () => {
  build({
    root: "web/build/fixtures/research",
    out: OUT,
    assets: "web/src/assets",
    template: "web/src/index.template.html",
  });
  // 查重纯函数复制到 assets（供浏览器表单 import），且确为可用的导出
  expect(existsSync(`${OUT}/assets/dedup.js`)).toBe(true);
  expect(readFileSync(`${OUT}/assets/dedup.js`, "utf8")).toContain("findFreshReport");
  // 报告清单：数组、每条含查重所需字段
  const reports = JSON.parse(readFileSync(`${OUT}/reports.json`, "utf8"));
  expect(Array.isArray(reports)).toBe(true);
  expect(reports.length).toBe(2);
  for (const r of reports) {
    for (const k of ["title", "type", "date", "slug", "tags", "href"]) expect(k in r).toBe(true);
  }
  // 不夹带正文/来源/邮箱等多余或私密字段
  expect("tldr" in reports[0]).toBe(false);
});

test("首页注入提交配置（弹窗表单）；submit.html 跳转回主页", () => {
  build({
    root: "web/build/fixtures/research",
    out: OUT,
    assets: "web/src/assets",
    template: "web/src/index.template.html",
    submitTemplate: "web/src/submit.template.html",
    config: "web/build/fixtures/site.config.json",
  });
  // 提交表单已搬进首页弹窗 → 配置注入到 index.html
  const home = readFileSync(`${OUT}/index.html`, "utf8");
  expect(home).toContain('data-worker="https://worker.test.dev"');
  expect(home).toContain('data-worker-fallback="https://fallback.test.dev"'); // 备用端点：主域被黑洞时前端自动改打
  expect(home).toContain('data-verify="https://worker.test.dev/verify"');
  expect(home).not.toContain("{{WORKER_URL}}");
  expect(home).not.toContain("{{WORKER_FALLBACK_URL}}");
  expect(home).toContain('id="submit-form"');
  // 授权改造后：不再有 Turnstile、不再让用户填邮箱
  expect(home).not.toContain("ts-widget");
  expect(home).not.toContain('type="email"');
  // 旧网址 submit.html 仍在，但只跳转回主页弹窗、不再承载表单
  expect(existsSync(`${OUT}/submit.html`)).toBe(true);
  const submit = readFileSync(`${OUT}/submit.html`, "utf8");
  expect(submit).toContain("index.html#submit");
  expect(submit).not.toContain('id="submit-form"');
  expect(existsSync(`${OUT}/assets/submit.js`)).toBe(true);
});

test("产出授权管理页 admin.html：注入 WORKER_URL、密钥闸、noindex、资产就位", () => {
  build({
    root: "web/build/fixtures/research",
    out: OUT,
    assets: "web/src/assets",
    template: "web/src/index.template.html",
    config: "web/build/fixtures/site.config.json",
  });
  expect(existsSync(`${OUT}/admin.html`)).toBe(true);
  const admin = readFileSync(`${OUT}/admin.html`, "utf8");
  expect(admin).toContain("https://worker.test.dev"); // WORKER_URL 已注入
  expect(admin).not.toContain("{{WORKER_URL}}");
  expect(admin).toContain('id="admin-key"');           // 密钥闸
  expect(admin).toContain('id="panel"');
  expect(admin).toContain("noindex");
  expect(admin).toContain("Content-Security-Policy");   // 严格 CSP
  expect(admin).not.toContain("{{WORKER_URL}}");
  expect(existsSync(`${OUT}/assets/admin.js`)).toBe(true);
  expect(existsSync(`${OUT}/assets/admin-page.js`)).toBe(true); // 外置脚本（配合 CSP）
});

test("产出事实核查页 check.html：注入 WORKER_URL、密钥闸、noindex、无残留 token", () => {
  build({
    root: "web/build/fixtures/research",
    out: OUT,
    assets: "web/src/assets",
    template: "web/src/index.template.html",
    config: "web/build/fixtures/site.config.json",
  });
  expect(existsSync(`${OUT}/check.html`)).toBe(true);
  const check = readFileSync(`${OUT}/check.html`, "utf8");
  expect(check).toContain("https://worker.test.dev"); // WORKER_URL 已注入
  expect(check).not.toContain("{{WORKER_URL}}");       // 无残留 token
  expect(check).not.toContain("{{");                   // 没有其它未替换 token
  expect(check).toContain('id="check-key"');           // 密钥闸
  expect(check).toContain('id="form-area"');           // 表单区
  expect(check).toContain("noindex");                  // 私密页
  expect(check).toContain("Content-Security-Policy");  // 严格 CSP
  expect(existsSync(`${OUT}/assets/check.js`)).toBe(true);
  expect(existsSync(`${OUT}/assets/check-page.js`)).toBe(true); // 外置脚本
});

test("报告副本注入了「返回档案 / 回到顶部」站点导航", () => {
  build({
    root: "web/build/fixtures/research",
    out: OUT,
    assets: "web/src/assets",
    template: "web/src/index.template.html",
  });
  const report = readFileSync(`${OUT}/r/2026-06-02_beta/index.html`, "utf8");
  expect(report).toContain("sx-nav-btn sx-home");
  expect(report).toContain("sx-nav-btn sx-top");
  expect(report).toContain('href="../../index.html"');
  expect(report).toContain("beta 正文"); // 原内容仍在
});

test("build 跳过缺 report.html 的半成品目录、不让整次构建崩溃（dc-3）", () => {
  const root = makeTmpRoot("tmp-dc3", {
    "2026-06-09_good/notes.md": "---\ntype: 概念\n---\n\n# 好的\n\n> 结论。",
    "2026-06-09_good/report.html": "<html><body>正文</body></html>",
    "2026-06-08_half/notes.md": "---\ntype: 概念\n---\n\n# 半成品\n\n> 结论。", // 缺 report.html
  });
  const out = "web/build/fixtures/out-dc3";
  const entries = build({ ...COMMON, root, out });
  expect(entries.length).toBe(1); // 只收录有 report.html 的，半成品被跳过、不抛错
  expect(entries[0].dir).toBe("2026-06-09_good");
  expect(existsSync(`${out}/r/2026-06-08_half/index.html`)).toBe(false);
  rmSync(root, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

test("build 拒绝发布残留 {{TOKEN}} 的报告（sl-5）", () => {
  const root = makeTmpRoot("tmp-sl5", {
    "2026-06-09_bad/notes.md": "---\ntype: 概念\n---\n\n# 坏的\n\n> 结论。",
    "2026-06-09_bad/report.html": "<html><body><h1>{{TITLE}}</h1></body></html>",
  });
  const out = "web/build/fixtures/out-sl5";
  expect(() => build({ ...COMMON, root, out })).toThrow(/TITLE/);
  rmSync(root, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});
