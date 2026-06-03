import { test, expect, afterAll } from "bun:test";
import { build } from "./build.js";
import { existsSync, readFileSync, rmSync } from "fs";

const OUT = "web/build/fixtures/out";
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

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
  expect(home).toContain('data-sitekey="0xTESTSITEKEY"');
  expect(home).not.toContain("{{WORKER_URL}}");
  expect(home).toContain('id="submit-form"');
  // 旧网址 submit.html 仍在，但只跳转回主页弹窗、不再承载表单
  expect(existsSync(`${OUT}/submit.html`)).toBe(true);
  const submit = readFileSync(`${OUT}/submit.html`, "utf8");
  expect(submit).toContain("index.html#submit");
  expect(submit).not.toContain('id="submit-form"');
  expect(existsSync(`${OUT}/assets/submit.js`)).toBe(true);
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
