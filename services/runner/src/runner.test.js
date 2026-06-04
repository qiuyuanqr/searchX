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

test("提供 bumpDailyCount 时：除提交者邮件外，再给作者发一封当日汇总", async () => {
  const fetchImpl = makeFetch();
  const world = makeWorld();
  const sent = [];
  const summary = await runOnce(CONFIG, {
    fetchImpl, scanDirs: world.scanDirs, runResearch: world.runResearch,
    sendEmail: async (m) => { sent.push(m); }, log: () => {},
    bumpDailyCount: () => ({ date: "2026-06-04", count: 5 }),
  });
  expect(summary.emailed).toBe(1); // emailed 仍只统计提交者那封
  expect(sent.length).toBe(2);
  const author = sent.find((m) => m.to === "me@g.com" && !m.cc); // 作者汇总：to=作者、无 cc
  expect(author).toBeTruthy();
  expect(author.subject).toContain("5");
  expect(author.text).toContain("今日（2026-06-04）累计完成 5 篇");
});

test("提交者发信失败也不影响作者汇总（两者独立）", async () => {
  const fetchImpl = makeFetch({ subOk: false }); // 取提交者邮箱 404 → 提交者那封不发
  const world = makeWorld();
  const sent = [];
  await runOnce(CONFIG, {
    fetchImpl, scanDirs: world.scanDirs, runResearch: world.runResearch,
    sendEmail: async (m) => { sent.push(m); }, log: () => {},
    bumpDailyCount: () => ({ date: "2026-06-04", count: 1 }),
  });
  const author = sent.find((m) => m.to === "me@g.com" && !m.cc);
  expect(author).toBeTruthy(); // 作者汇总照发
});

test("不传 bumpDailyCount 则只发提交者邮件（向后兼容）", async () => {
  const fetchImpl = makeFetch();
  const world = makeWorld();
  const sent = [];
  await runOnce(CONFIG, {
    fetchImpl, scanDirs: world.scanDirs, runResearch: world.runResearch,
    sendEmail: async (m) => { sent.push(m); }, log: () => {},
  });
  expect(sent.length).toBe(1);
  expect(sent[0].to).toBe("u@x.com"); // 仅提交者那封
});

// —— 部署探活闸 ——
// 研究 Step6 push 后，GitHub Actions 才 build+deploy；Pages 偶发 5xx 会打掉部署，
// 造成「已 push 但没上线」。探活失败时不能给提交者发"已上线"邮件（链接会 404）。
test("部署探活失败：研究已完成→贴 done 防重研，但不发信、failed 计数、评论告警未上线", async () => {
  const fetchImpl = makeFetch();
  const world = makeWorld();
  let sentCount = 0;
  const summary = await runOnce(CONFIG, {
    fetchImpl, scanDirs: world.scanDirs, runResearch: world.runResearch,
    sendEmail: async () => { sentCount++; }, log: () => {},
    verifyPublished: async () => false, // 报告子页迟迟非 200
  });
  expect(summary.published).toBe(0);
  expect(summary.failed).toBe(1);
  expect(sentCount).toBe(0); // 关键：不给提交者发 404 链接
  // 仍贴 done：研究已 push，避免下个 tick 重复跑 /research（重研费额度又再造文件夹）
  expect(fetchImpl.calls.some((c) =>
    /\/issues\/7\/labels$/.test(c.url) && JSON.parse(c.opts.body).labels.includes("done")
  )).toBe(true);
  // 评论点明"未确认上线"，提示作者手动补跑部署
  expect(fetchImpl.calls.some((c) =>
    /\/issues\/7\/comments$/.test(c.url) && JSON.parse(c.opts.body).body.includes("未确认上线")
  )).toBe(true);
});

test("部署探活通过：用报告 URL 探活，确认上线后才发信", async () => {
  const fetchImpl = makeFetch();
  const world = makeWorld();
  let probed;
  let sent;
  const summary = await runOnce(CONFIG, {
    fetchImpl, scanDirs: world.scanDirs, runResearch: world.runResearch,
    sendEmail: async (m) => { sent = m; }, log: () => {},
    verifyPublished: async (u) => { probed = u; return true; },
  });
  expect(probed).toBe("https://site.dev/searchX/r/2026-06-03_stablecoin/"); // 探的是报告子页
  expect(summary.published).toBe(1);
  expect(summary.emailed).toBe(1);
  expect(sent.to).toBe("u@x.com");
});
