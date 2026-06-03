// services/runner/src/runner.test.js
import { test, expect } from "bun:test";
import { runOnce } from "./runner.js";

const CONFIG = {
  owner: "o", repo: "r", githubToken: "T",
  workerUrl: "https://w.dev", subSecret: "S",
  authorEmail: "me@g.com", smtpUser: "me@g.com",
  siteBase: "https://site.dev/searchX",
};

const ISSUE_LIST = [
  { number: 7, title: "稳定币清结算", body: "### 侧重点\n```\n清算所\n```", labels: [{ name: "approved" }] },
];

// 路由假 fetch：list / labels / comments / sub
function makeFetch({ subEmail = "u@x.com", subOk = true } = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes("/issues?")) return { ok: true, json: async () => ISSUE_LIST };
    if (/\/issues\/\d+\/labels$/.test(String(url))) return { ok: true, json: async () => [] };
    if (/\/issues\/\d+\/comments$/.test(String(url))) return { ok: true, json: async () => ({}) };
    if (String(url).includes("/sub/"))
      return subOk
        ? { ok: true, json: async () => ({ ok: true, email: subEmail }) }
        : { ok: false, status: 404 };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

// scanDirs：研究跑完后多出一个新文件夹（带 title/tldr/href，模拟 scanResearch 产出）
function makeWorld() {
  const dirs = [{ dir: "2026-06-01_old", title: "旧", tldr: "t", href: "r/2026-06-01_old/" }];
  return {
    scanDirs: () => dirs.slice(),
    runResearch: async () => {
      dirs.push({
        dir: "2026-06-03_stablecoin",
        title: "稳定币的清结算机制",
        tldr: "银行间记账",
        href: "r/2026-06-03_stablecoin/",
      });
      return true;
    },
  };
}

test("快乐路径：贴 done、发信（含链接+TLDR+抄送）、评论、summary 计数", async () => {
  const fetchImpl = makeFetch();
  const world = makeWorld();
  let sent;
  const summary = await runOnce(CONFIG, {
    fetchImpl, scanDirs: world.scanDirs, runResearch: world.runResearch,
    sendEmail: async (m) => { sent = m; }, log: () => {},
  });
  expect(summary).toEqual({ processed: 1, published: 1, emailed: 1, failed: 0 });
  expect(fetchImpl.calls.some((c) =>
    /\/issues\/7\/labels$/.test(c.url) && JSON.parse(c.opts.body).labels.includes("done")
  )).toBe(true);
  expect(sent.to).toBe("u@x.com");
  expect(sent.cc).toBe("me@g.com");
  expect(sent.text).toContain("https://site.dev/searchX/r/2026-06-03_stablecoin/");
  expect(sent.text).toContain("银行间记账");
});

test("研究未产出新文件夹 → 不贴 done、不发信、failed 计数", async () => {
  const fetchImpl = makeFetch();
  const dirs = [{ dir: "2026-06-01_old", title: "旧", tldr: "t", href: "r/2026-06-01_old/" }];
  let sentCount = 0;
  const summary = await runOnce(CONFIG, {
    fetchImpl, scanDirs: () => dirs.slice(),
    runResearch: async () => true, // 没新增文件夹
    sendEmail: async () => { sentCount++; }, log: () => {},
  });
  expect(summary.published).toBe(0);
  expect(summary.failed).toBe(1);
  expect(sentCount).toBe(0);
  expect(fetchImpl.calls.some((c) => /\/labels$/.test(c.url))).toBe(false);
});

test("发信失败 → 仍贴 done、评论告警、emailed 不计数", async () => {
  const fetchImpl = makeFetch({ subOk: false }); // 取邮箱 404 → 抛错走 catch
  const world = makeWorld();
  const summary = await runOnce(CONFIG, {
    fetchImpl, scanDirs: world.scanDirs, runResearch: world.runResearch,
    sendEmail: async () => {}, log: () => {},
  });
  expect(summary.published).toBe(1);
  expect(summary.emailed).toBe(0);
  expect(fetchImpl.calls.some((c) => /\/issues\/7\/labels$/.test(c.url))).toBe(true);
  expect(fetchImpl.calls.some((c) =>
    /\/issues\/7\/comments$/.test(c.url) && JSON.parse(c.opts.body).body.includes("发信失败")
  )).toBe(true);
});
