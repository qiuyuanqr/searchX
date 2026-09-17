// scripts/fetch-article.test.js — 离线测 fetch-article.py 的解析与退出码（--html 读本地夹具，不联网）。
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SCRIPT = new URL("./fetch-article.py", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "fetch-article-test-"));

function run(url, html) {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(file, html);
  const p = Bun.spawnSync(["python3", SCRIPT, url, "--html", file]);
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const WEIXIN = `<!doctype html><html><head><meta charset="utf-8">
<meta property="og:title" content="重磅！AI信贷风险已经蔓延" />
<script>var ct = "1753056000";</script></head><body>
<h1 class="rich_media_title" id="activity-name">
  <span class="js_title_inner">重磅！AI信贷风险已经蔓延</span>
</h1>
<a id="js_name">华尔街见闻</a>
<div class="rich_media_content" id="js_content">
  <p>甲骨文曾是AI交易最耀眼的赢家，如今却成了债券市场最危险的警报之一。</p>
  <p><img data-src="https://mmbiz.qpic.cn/x.jpg"></p>
  <p>7月20日（周一），甲骨文股价再跌近4%，收于121.38美元。</p>
</div>
<div id="js_pc_qr_code">扫码关注</div>
</body></html>`;

describe("fetch-article.py", () => {
  it("公众号页：抽出标题 / 公众号名 / 发布时间（北京时间）/ 正文，二维码尾巴不进正文", () => {
    const r = run("https://mp.weixin.qq.com/s/abc", WEIXIN);
    expect(r.code).toBe(0);
    expect(r.out).toContain("标题: 重磅！AI信贷风险已经蔓延");
    expect(r.out).toContain("来源: 华尔街见闻");
    expect(r.out).toContain("发布时间: 2025-07-21 08:00 北京时间");
    expect(r.out).toContain("甲骨文曾是AI交易最耀眼的赢家");
    expect(r.out).toContain("收于121.38美元");
    expect(r.out).toContain("〔图〕");
    expect(r.out).not.toContain("扫码关注");
    expect(r.out).not.toContain("<p>");
  });

  it("公众号验证页：正文为空且带「环境异常」→ 退出码 2，stdout 不输出假正文", () => {
    const r = run("https://mp.weixin.qq.com/s/blocked",
      `<html><body><div class="weui-msg"><h2>环境异常</h2><p>当前环境异常，完成验证后即可继续访问。</p><a>去验证</a></div></body></html>`);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain("验证页");
  });

  it("普通新闻页：og:title + article 正文 + 发布时间 meta", () => {
    const r = run("https://news.example.com/a/1",
      `<html><head><title>站名 - 标题</title><meta property="og:title" content="某公司宣布重启二厂建设">
<meta property="og:site_name" content="第一财经"><meta property="article:published_time" content="2026-08-11T10:00:00+08:00">
<meta name="description" content="摘要一句"></head><body><nav>导航 导航</nav>
<article><p>${"正文段落。".repeat(60)}</p></article><footer>版权</footer></body></html>`);
    expect(r.code).toBe(0);
    expect(r.out).toContain("标题: 某公司宣布重启二厂建设");
    expect(r.out).toContain("来源: 第一财经");
    expect(r.out).toContain("发布时间: 2026-08-11T10:00:00+08:00");
    expect(r.out).toContain("摘要: 摘要一句");
    expect(r.out).toContain("正文段落。正文段落。");
    expect(r.out).not.toContain("导航 导航");
  });

  it("GBK 页面按声明编码解码，不出乱码", () => {
    const gbk = Buffer.from(
      `<html><head><meta http-equiv="Content-Type" content="text/html; charset=gb2312"><title>老门户新闻</title></head><body><article>${"中文正文内容，编码为国标。".repeat(20)}</article></body></html>`,
      "utf8");
    // 用 iconv 把 UTF-8 夹具转成 GBK 字节；本机没有 iconv 时跳过（macOS / Linux 都自带）
    const p = Bun.spawnSync(["iconv", "-f", "UTF-8", "-t", "GBK"], { stdin: gbk });
    if (p.exitCode !== 0) return;
    const file = join(dir, "gbk.html");
    writeFileSync(file, p.stdout);
    const r = Bun.spawnSync(["python3", SCRIPT, "https://old.example.com/x", "--html", file]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("标题: 老门户新闻");
    expect(r.stdout.toString()).toContain("中文正文内容，编码为国标。");
  });

  it("超长正文截断到上限并注明", () => {
    const r = run("https://news.example.com/long",
      `<html><body><article>${"字".repeat(40000)}</article></body></html>`);
    expect(r.code).toBe(0);
    expect(r.out).toContain("已截断到前 30000 字");
    expect(r.out.length).toBeLessThan(31000);
  });

  it("没给 url → 退出码 4", () => {
    const p = Bun.spawnSync(["python3", SCRIPT]);
    expect(p.exitCode).toBe(4);
  });
});
