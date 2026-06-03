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

test("build 产出提交表单页并注入配置", () => {
  build({
    root: "web/build/fixtures/research",
    out: OUT,
    assets: "web/src/assets",
    template: "web/src/index.template.html",
    submitTemplate: "web/src/submit.template.html",
    config: "web/build/fixtures/site.config.json",
  });
  expect(existsSync(`${OUT}/submit.html`)).toBe(true);
  const submit = readFileSync(`${OUT}/submit.html`, "utf8");
  expect(submit).toContain('data-worker="https://worker.test.dev"');
  expect(submit).toContain('data-sitekey="0xTESTSITEKEY"');
  expect(submit).not.toContain("{{WORKER_URL}}");
  expect(existsSync(`${OUT}/assets/submit.js`)).toBe(true);
});
