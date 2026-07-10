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
  expect(summary).toEqual({ processed: 1, published: 1, emailed: 1, deduped: 0, parked: 0, failed: 0, pendingPublish: 0 });
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
test("部署探活失败：研究已完成→贴 done 防重研，但不发信、计 pendingPublish 不计 failed、评论告警未上线", async () => {
  const fetchImpl = makeFetch();
  const world = makeWorld();
  let sentCount = 0;
  const summary = await runOnce(CONFIG, {
    fetchImpl, scanDirs: world.scanDirs, runResearch: world.runResearch,
    sendEmail: async () => { sentCount++; }, log: () => {},
    verifyPublished: async () => false, // 报告子页迟迟非 200
  });
  expect(summary.published).toBe(0);
  // 不计 failed：研究本身已成功，只是 Pages 部署慢/待 deploy-retry 补跑，pending 队列会自动
  // 重探补发、超龄才专信告警——此处计 failed 会让 runner exit 1 误发「管线故障」报警。
  expect(summary.failed).toBe(0);
  expect(summary.pendingPublish).toBe(1);
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

// —— 上线待确认队列：超龄过期出队（audit-2026-07-04 [36]）——
test("待补发队列条目超过 pendingExpireMs 仍未上线 → 出队、告警作者、不再复探、failed 计数", async () => {
  const comments = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/issues?")) return { ok: true, json: async () => [] }; // approved 队列已空
    if (/\/issues\/\d+\/comments$/.test(u)) { comments.push(JSON.parse(opts.body).body); return { ok: true, json: async () => ({}) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const store = [{ number: 7, topic: "稳定币清结算", url: "https://site.dev/searchX/r/x/", firstSeen: 0 }];
  let quickCalled = false;
  const sent = [];
  const summary = await runOnce(CONFIG, {
    fetchImpl,
    scanDirs: () => [],
    runResearch: async () => true,
    sendEmail: async (m) => sent.push(m), log: () => {},
    now: () => 25 * 3600_000, // 距 firstSeen=0 已过 25 小时 > 24h 默认阈值
    verifyPublishedQuick: async () => { quickCalled = true; return false; },
    loadPending: async () => store, savePending: async (p) => { store.splice(0, store.length, ...p); },
  });
  expect(quickCalled).toBe(false);      // 超龄条目直接出队，不该再浪费一次探活
  expect(store.length).toBe(0);         // 已出队
  expect(summary.failed).toBe(1);
  expect(sent.length).toBe(1);
  expect(sent[0].to).toBe(CONFIG.authorEmail); // 只告警作者，不发提交者
  expect(sent[0].subject).toContain("超龄");
  expect(comments.some((b) => b.includes("超过") && b.includes("小时"))).toBe(true);
});

test("待补发队列复探用 verifyPublishedQuick（不是 verifyPublished）", async () => {
  const store = [{ number: 7, topic: "X", url: "https://site.dev/searchX/r/x/", firstSeen: 1000 }];
  let fullCalled = false;
  let quickCalled = false;
  await runOnce(CONFIG, {
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes("/issues?")) return { ok: true, json: async () => [] };
      return { ok: false, status: 404, json: async () => ({}) };
    },
    scanDirs: () => [],
    runResearch: async () => true,
    sendEmail: async () => {}, log: () => {},
    now: () => 2000, // 远小于 24h 阈值，不会被判超龄
    verifyPublished: async () => { fullCalled = true; return true; },
    verifyPublishedQuick: async () => { quickCalled = true; return false; },
    loadPending: async () => store, savePending: async () => {},
  });
  expect(quickCalled).toBe(true);
  expect(fullCalled).toBe(false); // 待补发复探绝不该走 8 分钟长轮询那支
});

// —— park：上线前独立核验未过被搁置 ——
// skill 在 runner 子进程里拿不到 SMTP 凭据（被剥离），只写 research/.parked.json 信号、不 push；
// runner 读到就由持凭据的它发邮件通知作者 + 评论 + 贴 done（停重试），不走发布/发提交者信路径。
test("park：发作者通知、清信号、贴 done 停重试、评论⚠️、不发提交者邮件、parked 计数、不计 failed", async () => {
  const fetchImpl = makeFetch();
  const world = makeWorld();
  // 真实时序：信号由本次研究期间的 skill 写入——预先存在的残留会在 spawn 前被清掉（见下方残留信号用例）
  let parkSignal = null;
  const runResearch = async (p) => {
    const r = await world.runResearch(p);
    parkSignal = {
      topic: "稳定币清结算",
      reason: "核心结论依赖的数字与一手来源对不上、消解不掉",
      unresolved: ["报告说 X／来源说 Z／http://src"],
      folder: "research/2026-06-03_stablecoin",
    };
    return r;
  };
  let cleared = false;
  const sent = [];
  const summary = await runOnce(CONFIG, {
    fetchImpl, scanDirs: world.scanDirs, runResearch,
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

// —— 失败退避 / 自动停跑 ——
// 背景：launchd 每 5 分钟一 tick，「研究未产出→不贴 done 留待重跑」的 Issue 若持续失败，
// 会被每 tick 全额重跑一次 /research（每次都真实花额度），一整天可烧上百次。
// 止损：本地文件记每 Issue 连续失败次数（经 loadFailures/saveFailures 注入），
// 达 config.maxFailures（默认 3）即贴 done 停止重跑 + 作者专信 + 评论说明恢复方式。
const FAIL_CONFIG = { ...CONFIG, maxFailures: 3 };

test("失败退避：第 1 次研究未产出 → 计数 1 持久化、不贴 done、不发信、failed 计数", async () => {
  const fetchImpl = makeFetch();
  let saved;
  const sent = [];
  const summary = await runOnce(FAIL_CONFIG, {
    fetchImpl, scanDirs: () => [], runResearch: async () => false,
    sendEmail: async (m) => sent.push(m), log: () => {},
    loadFailures: async () => ({}),
    saveFailures: async (m) => { saved = m; },
  });
  expect(summary.failed).toBe(1);
  expect(summary.parked).toBe(0);
  expect(saved).toEqual({ 7: 1 });
  expect(sent.length).toBe(0);
  expect(fetchImpl.calls.some((c) => /\/labels$/.test(c.url))).toBe(false); // 未达阈值不贴 done
});

test("失败退避：连续第 3 次失败 → 贴 done 止损、作者专信、评论说明恢复方式、计数清零、parked 计数", async () => {
  const fetchImpl = makeFetch();
  let saved;
  const sent = [];
  let ran = 0;
  const summary = await runOnce(FAIL_CONFIG, {
    fetchImpl, scanDirs: () => [], runResearch: async () => { ran++; return false; },
    sendEmail: async (m) => sent.push(m), log: () => {},
    loadFailures: async () => ({ 7: 2 }), // 前两轮已各失败一次
    saveFailures: async (m) => { saved = m; },
  });
  expect(ran).toBe(1);              // 第 3 次是本轮真实跑失败的
  expect(summary.failed).toBe(1);
  expect(summary.parked).toBe(1);
  // 贴 done 止损（幂等标记，下个 tick 不再选中）
  expect(fetchImpl.calls.some((c) =>
    /\/issues\/7\/labels$/.test(c.url) && JSON.parse(c.opts.body).labels.includes("done")
  )).toBe(true);
  // 作者专信：to=作者、无 cc、主题标停跑
  expect(sent.length).toBe(1);
  expect(sent[0].to).toBe("me@g.com");
  expect(sent[0].cc).toBeUndefined();
  expect(sent[0].subject).toContain("已停跑");
  expect(sent[0].text).toContain("连续 3 次");
  // 评论说明连续失败次数与恢复方式（移除 done 标签）
  expect(fetchImpl.calls.some((c) =>
    /\/issues\/7\/comments$/.test(c.url)
      && JSON.parse(c.opts.body).body.includes("连续 3 次")
      && JSON.parse(c.opts.body).body.includes("done")
  )).toBe(true);
  // 计数清零：作者移除 done 恢复后从零重新计数
  expect(saved).toEqual({});
});

test("失败退避：已达阈值的 Issue 下一轮开跑前即拦下——绝不再 spawn 研究，补完成停跑动作", async () => {
  // 场景：上一轮第 3 次失败时贴 done 没贴上（如 PAT 瞬断），计数 3 保留、Issue 仍 approved。
  // 本轮必须先于一切花钱动作停跑，而不是先烧一次研究再说。
  const fetchImpl = makeFetch();
  let saved;
  const sent = [];
  let ran = 0;
  const summary = await runOnce(FAIL_CONFIG, {
    fetchImpl, scanDirs: () => [], runResearch: async () => { ran++; return false; },
    sendEmail: async (m) => sent.push(m), log: () => {},
    loadFailures: async () => ({ 7: 3 }),
    saveFailures: async (m) => { saved = m; },
  });
  expect(ran).toBe(0);              // 关键：没花额度
  expect(summary.parked).toBe(1);
  expect(summary.failed).toBe(0);   // 本轮没有新失败，停跑成功落地
  expect(fetchImpl.calls.some((c) =>
    /\/issues\/7\/labels$/.test(c.url) && JSON.parse(c.opts.body).labels.includes("done")
  )).toBe(true);
  expect(sent.length).toBe(1);      // 停跑专信这轮补发
  expect(saved).toEqual({});
});

test("失败退避：停跑贴 done 失败 → 计数保留待下轮重试停跑、不发停跑信（防每 5 分钟邮件轰炸）", async () => {
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/issues?")) return { ok: true, json: async () => ISSUE_LIST };
    if (/\/issues\/\d+\/labels$/.test(u)) return { ok: false, status: 403, text: async () => "forbidden" };
    if (/\/issues\/\d+\/comments$/.test(u)) return { ok: true, json: async () => ({}) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  let saved;
  const sent = [];
  const summary = await runOnce(FAIL_CONFIG, {
    fetchImpl, scanDirs: () => [], runResearch: async () => false,
    sendEmail: async (m) => sent.push(m), log: () => {},
    loadFailures: async () => ({ 7: 2 }),
    saveFailures: async (m) => { saved = m; },
  });
  expect(saved).toEqual({ 7: 3 }); // 止损没落地，计数保留 → 下一轮循环顶部先重试停跑
  expect(sent.length).toBe(0);     // 不发信：止损未落地就发，会每 tick 重复轰炸
  expect(summary.failed).toBe(1);
  expect(summary.parked).toBe(0);
});

test("失败退避：停跑专信发送失败 → 仍已贴 done、仍评论、计数照清（尽力而为不中止）", async () => {
  const fetchImpl = makeFetch();
  let saved;
  const summary = await runOnce(FAIL_CONFIG, {
    fetchImpl, scanDirs: () => [], runResearch: async () => false,
    sendEmail: async () => { throw new Error("smtp down"); }, log: () => {},
    loadFailures: async () => ({ 7: 2 }),
    saveFailures: async (m) => { saved = m; },
  });
  expect(summary.parked).toBe(1);
  expect(saved).toEqual({});
  expect(fetchImpl.calls.some((c) =>
    /\/issues\/7\/labels$/.test(c.url) && JSON.parse(c.opts.body).labels.includes("done")
  )).toBe(true);
  expect(fetchImpl.calls.some((c) =>
    /\/issues\/7\/comments$/.test(c.url) && JSON.parse(c.opts.body).body.includes("连续 3 次")
  )).toBe(true);
});

test("失败退避：曾失败过的 Issue 本轮成功 → 计数清零（连续失败语义，偶发故障不累计）", async () => {
  const fetchImpl = makeFetch();
  const world = makeWorld();
  let saved;
  const summary = await runOnce(FAIL_CONFIG, {
    fetchImpl, scanDirs: world.scanDirs, runResearch: world.runResearch,
    sendEmail: async () => {}, log: () => {},
    loadFailures: async () => ({ 7: 2 }),
    saveFailures: async (m) => { saved = m; },
  });
  expect(summary.published).toBe(1);
  expect(saved).toEqual({});
});

test("失败退避：不在 approved 队列的残留计数被修剪（防状态文件无限膨胀）", async () => {
  const fetchImpl = makeFetch();
  const world = makeWorld();
  let saved;
  await runOnce(FAIL_CONFIG, {
    fetchImpl, scanDirs: world.scanDirs, runResearch: world.runResearch,
    sendEmail: async () => {}, log: () => {},
    loadFailures: async () => ({ 99: 2 }), // #99 已被人工处理（不在 approved 队列）
    saveFailures: async (m) => { saved = m; },
  });
  expect(saved).toEqual({}); // 残留清掉；#99 若日后重新 approved，从零重新计数（作者已介入，给新预算）
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

test("查重命中但贴 done 失败 → 不发信（防持续贴不上时每轮重发轰炸提交者）、评论提示下轮重试、failed 计数", async () => {
  const base = makeStockFetch([{ number: 9, title: "芯原股份", body: "", labels: [{ name: "approved" }] }]);
  const fetchImpl = async (url, opts) => {
    if (/\/issues\/9\/labels$/.test(String(url))) { base.calls.push({ url: String(url), opts: opts || {} }); return { ok: false, status: 500 }; }
    return base(url, opts);
  };
  fetchImpl.calls = base.calls;
  let ran = 0, sent = 0;
  const summary = await runOnce(CONFIG, {
    fetchImpl, scanDirs: () => [STOCK_ENTRY],
    runResearch: async () => { ran++; return true; },
    sendEmail: async () => { sent++; }, log: () => {},
    today: () => "2026-06-10",
  });
  expect(ran).toBe(0);
  expect(summary.deduped).toBe(1);
  expect(summary.failed).toBe(1);
  expect(summary.emailed).toBe(0);
  expect(sent).toBe(0); // 关键：贴 done 失败就不发信，避免持续失败时每轮重发一封
  expect(fetchImpl.calls.some((c) =>
    /\/issues\/9\/comments$/.test(c.url) && JSON.parse(c.opts.body).body.includes("下一轮重试")
  )).toBe(true);
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

// —— 同批次内动态查重：第一条跑完研究后，scanDirs() 重新读磁盘应能看到新产出，
// 从而拦下同批次内第二条同标的重复提交（GitHub issues 列表默认按 created 倒序，新的在前）——
test("同批次两条同标的 approved Issue（短时间内重复提交）：第一条跑完研究，第二条被查重拦下，不重复调研", async () => {
  // 倒序：后提交的 25 在前，先提交的 24 在后（模拟真实 GitHub /issues? 默认排序）
  const ISSUES = [
    { number: 25, title: "海光信息", body: "", labels: [{ name: "approved" }] },
    { number: 24, title: "海光信息", body: "", labels: [{ name: "approved" }] },
  ];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/issues?")) return { ok: true, json: async () => ISSUES };
    if (/\/issues\/(24|25)\/labels$/.test(u)) return { ok: true, json: async () => [] };
    if (/\/issues\/(24|25)\/comments$/.test(u)) return { ok: true, json: async () => ({}) };
    if (/\/sub\/(24|25)$/.test(u)) return { ok: true, json: async () => ({ ok: true, email: "u@x.com" }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  fetchImpl.calls = [];
  const rawFetch = fetchImpl;
  const wrapped = async (url, opts) => { wrapped.calls.push({ url: String(url), opts: opts || {} }); return rawFetch(url, opts); };
  wrapped.calls = [];

  let dirs = []; // 这只票之前从未研究过
  let ran = 0;
  const sent = [];
  const summary = await runOnce(CONFIG, {
    fetchImpl: wrapped,
    scanDirs: () => dirs.slice(),
    runResearch: async () => {
      ran++;
      dirs.push({
        dir: "2026-06-30_haiguang-688041", date: "2026-06-30", type: "股票",
        title: "海光信息（688041.SH）", tldr: "国产CPU/DCU龙头", slug: "haiguang-688041",
        tags: ["research", "海光信息", "688041", "半导体"], href: "r/2026-06-30_haiguang-688041/",
      });
      return true;
    },
    sendEmail: async (m) => { sent.push(m); }, log: () => {},
    today: () => "2026-06-30",
  });

  expect(ran).toBe(1); // 关键：只真正 spawn 了一次 claude / 跑了一次研究
  expect(summary.processed).toBe(2);
  expect(summary.published).toBe(1);
  expect(summary.deduped).toBe(1);
  expect(summary.failed).toBe(0);
  expect(summary.emailed).toBe(2); // 第一条「调研完成」信 + 第二条「已有报告」回信
});

test("补发成功后立即落盘：阶段 2 取 Issue 列表抛错，已补发条目也不会留在队列里重复发信", async () => {
  const saves = [];
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes("/issues?")) throw new Error("GitHub 503");
    if (String(url).includes("/sub/")) return { ok: true, json: async () => ({ ok: true, email: "u@x.com" }) };
    if (/\/issues\/\d+\/comments$/.test(String(url))) return { ok: true, json: async () => ({}) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  let sent = 0;
  await expect(runOnce(CONFIG, {
    fetchImpl, scanDirs: () => [], runResearch: async () => true,
    sendEmail: async () => { sent++; }, log: () => {},
    verifyPublished: async () => true,
    loadPending: async () => [{ number: 7, topic: "t", title: "T", tldr: "d", url: "https://site.dev/searchX/r/x/" }],
    savePending: async (list) => { saves.push(list.map((p) => p.number)); },
  })).rejects.toThrow("GitHub 503");
  expect(sent).toBe(1);          // 补发信已发出一封
  expect(saves.length).toBe(1);  // runOnce 中止前队列已落盘
  expect(saves[0]).toEqual([]);  // 已补发条目不在落盘队列里 → 下一轮不会重复发信
});

test("残留的 park 信号在跑研究前被清掉：研究实际成功的 Issue 不被旧信号张冠李戴判搁置", async () => {
  const fetchImpl = makeFetch();
  const world = makeWorld();
  let signal = { reason: "上一次交互式 park 的残留" };
  let sent;
  const summary = await runOnce(CONFIG, {
    fetchImpl, scanDirs: world.scanDirs, runResearch: world.runResearch,
    sendEmail: async (m) => { sent = m; }, log: () => {},
    readParkSignal: async () => signal,
    clearParkSignal: async () => { signal = null; },
  });
  expect(summary.parked).toBe(0);
  expect(summary.published).toBe(1);
  expect(sent.to).toBe("u@x.com"); // 提交者收到上线信，而不是作者收到错误的搁置信
});
