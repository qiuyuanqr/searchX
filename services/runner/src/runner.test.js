// services/runner/src/runner.test.js
import { test, expect } from "bun:test";
import { runOnce } from "./runner.js";

const CONFIG = {
  owner: "o", repo: "r", githubToken: "T",
  workerUrl: "https://w.dev", subSecret: "S",
  authorEmail: "me@g.com", smtpUser: "me@g.com",
  siteBase: "https://site.dev/searchX",
  dedupWindowDays: 30,
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
  expect(summary).toEqual({ processed: 1, published: 1, emailed: 1, deduped: 0, parked: 0, failed: 0 });
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

// —— 部署探活 ——
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

// —— 贴 done 失败的兜底（runner-1）——
test("贴 done 失败：不中止整轮、failed 计数、评论告警、同批后续 Issue 仍处理", async () => {
  const ISSUES = [
    { number: 7, title: "A", body: "", labels: [{ name: "approved" }] },
    { number: 8, title: "B", body: "", labels: [{ name: "approved" }] },
  ];
  const comments = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/issues?")) return { ok: true, json: async () => ISSUES };
    if (/\/issues\/\d+\/labels$/.test(u)) return { ok: false, status: 403, text: async () => "forbidden" }; // 贴 done 失败
    if (/\/issues\/\d+\/comments$/.test(u)) { comments.push(JSON.parse(opts.body).body); return { ok: true, json: async () => ({}) }; }
    if (u.includes("/sub/")) return { ok: true, json: async () => ({ ok: true, email: "u@x.com" }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const dirs = [{ dir: "old", title: "旧", tldr: "t", href: "r/old/" }];
  let runs = 0;
  const summary = await runOnce(CONFIG, {
    fetchImpl,
    scanDirs: () => dirs.slice(),
    runResearch: async () => { runs++; dirs.push({ dir: `n${runs}`, title: `t${runs}`, tldr: "x", href: `r/n${runs}/` }); return true; },
    sendEmail: async () => {}, log: () => {},
  });
  expect(runs).toBe(2);            // 两条都跑了研究（第一条贴 done 失败没拖垮第二条）
  expect(summary.failed).toBe(2);  // 两条都贴 done 失败
  expect(summary.emailed).toBe(0); // 贴 done 失败即跳过，不发信
  expect(comments.some((b) => b.includes("done") && b.includes("重复跑"))).toBe(true); // 告警含手动补贴提示
});

// —— 上线待确认队列：自动补发（runner-2 / dc-1）——
test("探活失败→记入待补发；下一轮探活通过→自动补发邮件，且不重跑研究", async () => {
  // 第一轮：研究产出、贴 done、探活失败 → 进入待补发队列、不发信
  let store = [];
  const s1 = await runOnce(CONFIG, {
    ...(() => { const w = makeWorld(); return { scanDirs: w.scanDirs, runResearch: w.runResearch }; })(),
    fetchImpl: makeFetch(),
    sendEmail: async () => {}, log: () => {},
    verifyPublished: async () => false,
    loadPending: async () => store, savePending: async (p) => { store = p; },
  });
  expect(s1.emailed).toBe(0);
  expect(store.length).toBe(1);
  expect(store[0].number).toBe(7);
  expect(store[0].url).toBe("https://site.dev/searchX/r/2026-06-03_stablecoin/");

  // 第二轮：issue 7 已是 done → 不在 approved 队列；探活这次通过 → 从待补发队列自动补发
  let ran2 = 0;
  let sent2;
  const s2 = await runOnce(CONFIG, {
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes("/issues?")) return { ok: true, json: async () => [] }; // approved 队列已空（7 已 done）
      if (/\/issues\/\d+\/comments$/.test(u)) return { ok: true, json: async () => ({}) };
      if (u.includes("/sub/")) return { ok: true, json: async () => ({ ok: true, email: "u@x.com" }) };
      return { ok: false, status: 404, json: async () => ({}) };
    },
    scanDirs: () => [],
    runResearch: async () => { ran2++; return true; },
    sendEmail: async (m) => { sent2 = m; }, log: () => {},
    verifyPublished: async () => true,
    loadPending: async () => store, savePending: async (p) => { store = p; },
  });
  expect(ran2).toBe(0);             // 关键：没有重跑 /research
  expect(sent2.to).toBe("u@x.com"); // 补发给提交者
  expect(s2.emailed).toBe(1);
  expect(store.length).toBe(0);     // 待补发队列已清空
});

// —— park：上线前独立核验未过被搁置 ——
// skill 在 runner 子进程里拿不到 SMTP 凭据（被剥离），只写 research/.parked.json 信号、不 push；
// runner 读到就由持凭据的它发邮件通知作者 + 评论 + 贴 done（停重试），不走发布/发提交者信路径。
test("park：发作者通知、清信号、贴 done 停重试、评论⚠️、不发提交者邮件、parked 计数、不计 failed", async () => {
  const fetchImpl = makeFetch();
  const world = makeWorld();
  let parkSignal = {
    topic: "稳定币清结算",
    reason: "核心结论依赖的数字与一手来源对不上、消解不掉",
    unresolved: ["报告说 X／来源说 Z／http://src"],
    folder: "research/2026-06-03_stablecoin",
  };
  let cleared = false;
  const sent = [];
  const summary = await runOnce(CONFIG, {
    fetchImpl, scanDirs: world.scanDirs, runResearch: world.runResearch,
    sendEmail: async (m) => { sent.push(m); }, log: () => {},
    readParkSignal: async () => parkSignal,
    clearParkSignal: async () => { cleared = true; parkSignal = null; },
  });
  expect(summary.parked).toBe(1);
  expect(summary.published).toBe(0);
  expect(summary.emailed).toBe(0);   // 不给提交者发信
  expect(summary.failed).toBe(0);    // park 不是失败、不该被重跑
  expect(cleared).toBe(true);        // 信号已清，杜绝泄漏到本批后续 Issue
  // 只发一封：作者搁置通知（to=作者、无 cc、主题含已搁置、正文含原因）
  expect(sent.length).toBe(1);
  expect(sent[0].to).toBe("me@g.com");
  expect(sent[0].cc).toBeUndefined();
  expect(sent[0].subject).toContain("已搁置");
  expect(sent[0].text).toContain("核心结论依赖的数字");
  // 贴 done 停重试
  expect(fetchImpl.calls.some((c) =>
    /\/issues\/7\/labels$/.test(c.url) && JSON.parse(c.opts.body).labels.includes("done")
  )).toBe(true);
  // 评论⚠️点明已搁置待复核
  expect(fetchImpl.calls.some((c) =>
    /\/issues\/7\/comments$/.test(c.url) && JSON.parse(c.opts.body).body.includes("搁置")
  )).toBe(true);
  // 不探活提交者邮箱（park 不走发布路径）
  expect(fetchImpl.calls.some((c) => c.url.includes("/sub/"))).toBe(false);
});

test("park 时发信失败：仍清信号、贴 done、评论，parked 照计数（尽力而为不中止）", async () => {
  const fetchImpl = makeFetch();
  const world = makeWorld();
  let cleared = false;
  const summary = await runOnce(CONFIG, {
    fetchImpl, scanDirs: world.scanDirs, runResearch: world.runResearch,
    sendEmail: async () => { throw new Error("smtp down"); }, log: () => {},
    readParkSignal: async () => ({ topic: "X", reason: "r", unresolved: [], folder: "f" }),
    clearParkSignal: async () => { cleared = true; },
  });
  expect(summary.parked).toBe(1);
  expect(cleared).toBe(true);
  expect(fetchImpl.calls.some((c) =>
    /\/issues\/7\/labels$/.test(c.url) && JSON.parse(c.opts.body).labels.includes("done")
  )).toBe(true);
  expect(fetchImpl.calls.some((c) =>
    /\/issues\/7\/comments$/.test(c.url) && JSON.parse(c.opts.body).body.includes("搁置")
  )).toBe(true);
});

// —— 查重：同标的且在时效窗口内已有报告 → 不重复调研，自动回信 ——
// scanDirs 返回一个 30 天内的同股票报告（type=股票、tags 含中文名+代码），runner 应在 spawn 前拦下。
function makeStockFetch(issues) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const u = String(url);
    if (u.includes("/issues?")) return { ok: true, json: async () => issues };
    if (/\/issues\/\d+\/labels$/.test(u)) return { ok: true, json: async () => [] };
    if (/\/issues\/\d+\/comments$/.test(u)) return { ok: true, json: async () => ({}) };
    if (u.includes("/sub/")) return { ok: true, json: async () => ({ ok: true, email: "u@x.com" }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}
const STOCK_ENTRY = {
  dir: "2026-06-08_verisilicon-688521", date: "2026-06-08", type: "股票",
  title: "芯原股份（688521.SH）", tldr: "国内半导体 IP 龙头", slug: "verisilicon-688521",
  tags: ["research", "芯原股份", "688521"], href: "r/2026-06-08_verisilicon-688521/",
};

test("查重命中（窗口内已有同股票报告）：不跑研究、回信告知已有、贴 done、deduped 计数、不计 failed", async () => {
  const fetchImpl = makeStockFetch([{ number: 9, title: "芯原股份", body: "", labels: [{ name: "approved" }] }]);
  let ran = 0, sent;
  const summary = await runOnce(CONFIG, {
    fetchImpl, scanDirs: () => [STOCK_ENTRY],
    runResearch: async () => { ran++; return true; },
    sendEmail: async (m) => { sent = m; }, log: () => {},
    today: () => "2026-06-10",
  });
  expect(ran).toBe(0);                 // 关键：没 spawn claude、没跑研究
  expect(summary.deduped).toBe(1);
  expect(summary.processed).toBe(1);
  expect(summary.published).toBe(0);
  expect(summary.failed).toBe(0);
  expect(summary.emailed).toBe(1);
  // 回信：发给提交者、抄作者、主题标「已有」、正文含报告链接
  expect(sent.to).toBe("u@x.com");
  expect(sent.cc).toBe("me@g.com");
  expect(sent.subject).toContain("已有");
  expect(sent.text).toContain("https://site.dev/searchX/r/2026-06-08_verisilicon-688521/");
  // 贴 done（幂等，杜绝下轮重判）+ 评论留痕「未重复调研」
  expect(fetchImpl.calls.some((c) =>
    /\/issues\/9\/labels$/.test(c.url) && JSON.parse(c.opts.body).labels.includes("done")
  )).toBe(true);
  expect(fetchImpl.calls.some((c) =>
    /\/issues\/9\/comments$/.test(c.url) && JSON.parse(c.opts.body).body.includes("未重复调研")
  )).toBe(true);
});

test("查重命中但报告已过时效窗口 → 照常跑研究（不当成重复）", async () => {
  const stale = { ...STOCK_ENTRY, dir: "2026-01-01_verisilicon-688521", date: "2026-01-01", href: "r/2026-01-01_verisilicon-688521/" };
  const dirs = [stale];
  const fetchImpl = makeStockFetch([{ number: 9, title: "芯原股份", body: "", labels: [{ name: "approved" }] }]);
  let ran = 0, sent;
  const summary = await runOnce(CONFIG, {
    fetchImpl, scanDirs: () => dirs.slice(),
    runResearch: async () => {
      ran++;
      dirs.push({ dir: "2026-06-10_verisilicon-688521-new", date: "2026-06-10", type: "股票",
        title: "芯原股份（688521.SH）", tldr: "刷新", slug: "verisilicon-688521-new",
        tags: ["芯原股份", "688521"], href: "r/2026-06-10_verisilicon-688521-new/" });
      return true;
    },
    sendEmail: async (m) => { sent = m; }, log: () => {},
    today: () => "2026-06-10", // 距 2026-01-01 远超 30 天
  });
  expect(ran).toBe(1);            // 旧报告过时 → 重做
  expect(summary.deduped).toBe(0);
  expect(summary.published).toBe(1);
  expect(sent.subject).toContain("调研完成"); // 走正常完成回信，而非「已有报告」
});

test("查重命中但回信失败 → 仍贴 done、评论提示手动告知、emailed 不计数", async () => {
  const fetchImpl = makeStockFetch([{ number: 9, title: "芯原股份", body: "", labels: [{ name: "approved" }] }]);
  // 取提交者邮箱 404 → fetchSubmitterEmail 抛错 → 回信失败
  const base = fetchImpl;
  const wrapped = async (url, opts) => {
    if (String(url).includes("/sub/")) { base.calls.push({ url: String(url), opts: opts || {} }); return { ok: false, status: 404 }; }
    return base(url, opts);
  };
  wrapped.calls = base.calls;
  let ran = 0;
  const summary = await runOnce(CONFIG, {
    fetchImpl: wrapped, scanDirs: () => [STOCK_ENTRY],
    runResearch: async () => { ran++; return true; },
    sendEmail: async () => {}, log: () => {},
    today: () => "2026-06-10",
  });
  expect(ran).toBe(0);
  expect(summary.deduped).toBe(1);
  expect(summary.emailed).toBe(0);
  expect(base.calls.some((c) =>
    /\/issues\/9\/labels$/.test(c.url) && JSON.parse(c.opts.body).labels.includes("done")
  )).toBe(true);
  expect(base.calls.some((c) =>
    /\/issues\/9\/comments$/.test(c.url) && JSON.parse(c.opts.body).body.includes("手动告知")
  )).toBe(true);
});
