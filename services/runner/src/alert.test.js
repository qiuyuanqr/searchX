import { test, expect } from "bun:test";
import { shouldAlert, composeAlert, evaluateProbe, nextStreaks, isTransientQueueError, nextQueueStreak, classifyFailure, redactSecrets, parseAlertArgs, MIN_INTERVAL_MS, PROBE_CONFIRM_TICKS, QUEUE_FETCH_CONFIRM_TICKS } from "./alert.js";

test("shouldAlert：无历史记录（NaN/undefined）→ 发", () => {
  expect(shouldAlert(NaN, 1000)).toBe(true);
  expect(shouldAlert(undefined, 1000)).toBe(true);
});

test("shouldAlert：间隔不足 → 不发；到点 → 发（防每 5 分钟一 tick 的轰炸）", () => {
  expect(shouldAlert(0, MIN_INTERVAL_MS - 1)).toBe(false);
  expect(shouldAlert(0, MIN_INTERVAL_MS)).toBe(true);
});

test("composeAlert：收件人=作者、主题含 key、正文含详情，且只有运维信息", () => {
  const m = composeAlert({
    key: "runner-failed", detail: "定时 runner 退出码 1",
    authorEmail: "author@x.com", fromEmail: "from@x.com", when: "2026/7/3 18:00:00",
  });
  expect(m.to).toBe("author@x.com");
  expect(m.from).toBe("from@x.com");
  expect(m.subject).toContain("runner-failed");
  expect(m.text).toContain("定时 runner 退出码 1");
  expect(m.text).toContain("6 小时"); // 告知限频语义：没再收到信 ≠ 已恢复
});

test("evaluateProbe：全通 → 不报警", () => {
  const v = evaluateProbe({ siteOk: true, primaryOk: true, fallbackOk: true, site: "s", primary: "p", fallback: "f",
    streaks: { site: 0, primary: 0 } });
  expect(v.alert).toBe(false);
});

test("evaluateProbe：仅备用挂 → 不报警只留痕（workers.dev 墙内间歇阻断是已知常态）", () => {
  const v = evaluateProbe({ siteOk: true, primaryOk: true, fallbackOk: false, site: "s", primary: "p", fallback: "f",
    streaks: { site: 0, primary: 0 } });
  expect(v.alert).toBe(false);
  expect(v.detail).toContain("f");
});

test("evaluateProbe：主端点断但未达连续阈值 → 不报警只留痕（墙内分钟级瞬时抖动是已知常态）", () => {
  const v = evaluateProbe({ siteOk: true, primaryOk: false, fallbackOk: true, site: "s", primary: "p", fallback: "f",
    streaks: { site: 0, primary: 1 } });
  expect(v.alert).toBe(false);
  expect(v.detail).toContain("p");
  expect(v.detail).toContain("连续");
});

test("evaluateProbe：主端点连续达阈值 → 报警；主备全挂 → 报警并注明链路完全断", () => {
  const v = evaluateProbe({ siteOk: true, primaryOk: false, fallbackOk: true, site: "s", primary: "p", fallback: "f",
    streaks: { site: 0, primary: PROBE_CONFIRM_TICKS } });
  expect(v.alert).toBe(true);
  expect(v.detail).toContain("p");
  const all = evaluateProbe({ siteOk: true, primaryOk: false, fallbackOk: false, site: "s", primary: "p", fallback: "f",
    streaks: { site: 0, primary: PROBE_CONFIRM_TICKS } });
  expect(all.alert).toBe(true);
  expect(all.detail).toContain("完全断");
});

test("evaluateProbe：站点断同样要连续达阈值才报警（朋友打不开首页是事故，但单次抖动不是）", () => {
  const brief = evaluateProbe({ siteOk: false, primaryOk: true, fallbackOk: true, site: "https://site", primary: "p", fallback: "f",
    streaks: { site: 1, primary: 0 } });
  expect(brief.alert).toBe(false);
  const sustained = evaluateProbe({ siteOk: false, primaryOk: true, fallbackOk: true, site: "https://site", primary: "p", fallback: "f",
    streaks: { site: PROBE_CONFIRM_TICKS, primary: 0 } });
  expect(sustained.alert).toBe(true);
  expect(sustained.detail).toContain("https://site");
});

test("evaluateProbe：不传 streaks（旧调用方/状态文件读失败）→ 视为已达阈值照报，宁多报不静默", () => {
  const v = evaluateProbe({ siteOk: true, primaryOk: false, fallbackOk: true, site: "s", primary: "p", fallback: "f" });
  expect(v.alert).toBe(true);
});

test("nextStreaks：断则累加、通则清零；历史缺失/损坏从零起算", () => {
  expect(nextStreaks({}, { siteOk: false, primaryOk: false })).toEqual({ site: 1, primary: 1 });
  expect(nextStreaks({ site: 2, primary: 5 }, { siteOk: false, primaryOk: false })).toEqual({ site: 3, primary: 6 });
  expect(nextStreaks({ site: 2, primary: 5 }, { siteOk: true, primaryOk: true })).toEqual({ site: 0, primary: 0 });
  expect(nextStreaks(null, { siteOk: false, primaryOk: true })).toEqual({ site: 1, primary: 0 });
  expect(nextStreaks({ site: "垃圾", primary: -3 }, { siteOk: false, primaryOk: false })).toEqual({ site: 1, primary: 1 });
});

test("isTransientQueueError：fetch 抛错(无 status)/5xx → 瞬时防抖；4xx → 非瞬时立即报警", () => {
  // fetch 自身抛错（连接/TLS/超时）——无 HTTP 响应，无 status：墙内到 api.github.com 的分钟级瞬断
  expect(isTransientQueueError(new Error("The operation timed out."))).toBe(true);
  expect(isTransientQueueError(Object.assign(new Error("timeout"), { code: 23, name: "TimeoutError" }))).toBe(true);
  // 5xx：GitHub 服务端抽风（如 2026-07-17 返回错误页 HTML）——也是外部瞬时故障，防抖
  expect(isTransientQueueError(Object.assign(new Error("list issues failed: 503"), { status: 503 }))).toBe(true);
  expect(isTransientQueueError(Object.assign(new Error("500"), { status: 500 }))).toBe(true);
  // 4xx：配置/权限问题（401 PAT 失效、403 限流）——防抖会掩盖真问题，须立即报警
  expect(isTransientQueueError(Object.assign(new Error("401"), { status: 401 }))).toBe(false);
  expect(isTransientQueueError(Object.assign(new Error("404"), { status: 404 }))).toBe(false);
});

test("nextQueueStreak：失败累加、成功清零、历史缺失/损坏从零起算（与 nextStreaks 同语义、单目标）", () => {
  expect(nextQueueStreak(0, true)).toBe(1);
  expect(nextQueueStreak(3, true)).toBe(4);
  expect(nextQueueStreak(3, false)).toBe(0);   // 成功即清零：只有「连续」失败才累计报警
  expect(nextQueueStreak(undefined, true)).toBe(1);
  expect(nextQueueStreak(null, true)).toBe(1);
  expect(nextQueueStreak("垃圾", true)).toBe(1);
  expect(nextQueueStreak(-3, true)).toBe(1);
});

test("QUEUE_FETCH_CONFIRM_TICKS：正整数（与探活阈值同量级，约 20 分钟才判真故障）", () => {
  expect(Number.isInteger(QUEUE_FETCH_CONFIRM_TICKS)).toBe(true);
  expect(QUEUE_FETCH_CONFIRM_TICKS).toBeGreaterThanOrEqual(2);
});

// ——— 报警正文：错误类型识别与脱敏（2026-08-26 加）———
// 由来：08-26 的 401 事故里，报警邮件只有「定时 runner 退出码 1」，真因（PAT 被重新生成）
// 只躺在 Mac mini 的日志里，每次都得 ssh 上去翻。分类函数把日志尾部读成「类型+关键行+怎么办」。

test("redactSecrets：GitHub token / Bearer / SMTP 密码一律打码（报警走 SMTP 外发）", () => {
  const t = redactSecrets(
    "RUNNER_GITHUB_TOKEN=github_pat_11ABCDEFG0fakefakefakefake\n" +
    "Authorization: Bearer ghp_FAKEfakeFAKEfake1234567890\n" +
    "RUNNER_SMTP_PASS=abcdefghijklmnop\n" +
    "正常内容不动：list issues failed: 401"
  );
  expect(t).not.toContain("github_pat_11ABCDEFG0fakefakefakefake");
  expect(t).not.toContain("ghp_FAKEfakeFAKEfake1234567890");
  expect(t).not.toContain("abcdefghijklmnop");
  expect(t).toContain("list issues failed: 401");
});

test("classifyFailure：401 Bad credentials → GitHub 凭据失效，提示换两台机的 token", () => {
  const v = classifyFailure(`$ bun run services/runner/src/index.js
✗ 未捕获异常： 22 |   for (let page = 1; ; page++) {
error: list issues failed: 401 {
  "message": "Bad credentials",
  "status": "401"
}
error: script "runner" exited with code 1`);
  expect(v.type).toContain("凭据失效");
  expect(v.summary).toContain("401");
  expect(v.hint).toContain("RUNNER_GITHUB_TOKEN");
  expect(v.hint).toContain("两台"); // 两台机各存一份 .env，只改一台等于没改
});

test("classifyFailure：认不出类型 → 未知错误，但仍给出日志末尾（信息不得少于旧版）", () => {
  const v = classifyFailure("一些无法归类的输出\n最后一行才是错\nsome weird failure here");
  expect(v.type).toContain("未知");
  expect(v.summary).toContain("some weird failure here");
  expect(v.hint).toContain("日志");
});

test("classifyFailure：claude 登录过期优先于「研究未产出」（笼统症状不许盖住真因）", () => {
  // 真实片段（2026-08-24 #50）：邮件当时只说「连续 3 次研究未产出」，而真因就写在上一行。
  const v = classifyFailure(`→ claude -p "/research CPO、NPO、LPO 之间什么关系"
Failed to authenticate: OAuth session expired and could not be refreshed
#50 连续 3 次研究未产出，已自动停跑（贴 done 止损），不再自动重跑
完成：处理 1、上线 0、发信 0、查重跳过 0、搁置 1、上线待确认 0、失败 1
error: script "runner" exited with code 1`);
  expect(v.type).toContain("claude 登录");
  expect(v.hint).toContain("重新登录");
});

test("classifyFailure：没有更具体根因时才落到「研究未产出」", () => {
  const v = classifyFailure(`#50 研究未产出（claude 退出码非 0 或无新文件夹），连续第 1/3 次，不贴 done，留待重跑
完成：处理 1、上线 0、发信 0、查重跳过 0、搁置 0、上线待确认 0、失败 1`);
  expect(v.type).toContain("研究未产出");
});

test("classifyFailure：GitHub 限流 / 仓库配错 / 权限不足分别成类", () => {
  expect(classifyFailure("error: list issues failed: 403 API rate limit exceeded").type).toContain("限流");
  expect(classifyFailure("error: list issues failed: 404 Not Found").type).toContain("仓库");
  expect(classifyFailure("error: add label failed: 403 Resource not accessible by personal access token").type).toContain("权限不足");
});

test("classifyFailure：裸 404/403 不算 GitHub 故障（探活日志里的状态码不许误伤）", () => {
  const v = classifyFailure("→ 探活（等部署上线，最多 8 分钟）：https://x/y\n探活未通过：404");
  expect(v.type).toContain("未知");
});

test("classifyFailure：Worker /sub 的 401 不该给 GitHub token 的处置建议（两把钥匙不同）", () => {
  const v = classifyFailure("error: fetch submitter email failed: 401");
  expect(v.hint).not.toContain("RUNNER_GITHUB_TOKEN");
  expect(v.hint).toContain("RUNNER_SUB_SECRET");
});

test("classifyFailure：环境与配置类——缺环境变量 / 找不到 claude CLI", () => {
  expect(classifyFailure("✗ 缺少 Runner 必需环境变量：RUNNER_SMTP_PASS").type).toContain("配置");
  expect(classifyFailure("✗ 找不到 claude CLI（headless /research 依赖它）").type).toContain("claude CLI");
});

test("classifyFailure：运行期故障——研究超时 / 锁疑似卡死 / 状态文件不可写", () => {
  expect(classifyFailure("✗ 研究超时（90 分钟），已终止 claude 子进程").type).toContain("超时");
  expect(classifyFailure("✗ 连续 36 个 tick 都因「已有一轮在运行」而跳过（约 3 小时）").type).toContain("锁");
  expect(classifyFailure("✗ 本机状态文件写入失败（磁盘满/权限？）").type).toContain("状态文件");
});

test("classifyFailure：Stocks 库被占 / git push 失败（stocks-import 的两类常客）", () => {
  const locked = classifyFailure("Error: in prepare, database is locked (5)\n[2026-08-19 18:35:14] 导入脚本退出码 1，本次中止");
  expect(locked.type).toContain("Stocks 库");
  expect(locked.hint).toContain("重试");
  expect(classifyFailure("[2026-08-17 14:50:43] push 失败").type).toContain("push");
});

test("classifyFailure：关键错误行与日志一起脱敏（summary 也会进邮件）", () => {
  const v = classifyFailure("error: list issues failed: 401 Bad credentials (token=github_pat_11ABCDEFG0fakefakefake)");
  expect(v.summary).not.toContain("github_pat_11ABCDEFG0fakefakefake");
});

test("composeAlert：给了日志尾部 → 主题带错误类型，正文分栏列出类型/关键行/处置/现场日志", () => {
  const m = composeAlert({
    key: "runner-failed", detail: "定时 runner 退出码 1",
    authorEmail: "author@x.com", fromEmail: "from@x.com", when: "2026/8/26 01:38:21",
    logPath: "/Users/x/Library/Logs/searchx-runner/runner.log",
    logTail: 'error: list issues failed: 401 {"message": "Bad credentials"}\nerror: script "runner" exited with code 1',
  });
  expect(m.subject).toContain("runner-failed");
  expect(m.subject).toContain("GitHub 凭据失效");
  expect(m.text).toContain("【错误类型】");
  expect(m.text).toContain("【关键错误】");
  expect(m.text).toContain("RUNNER_GITHUB_TOKEN");   // 处置办法直接写进正文
  expect(m.text).toContain("【现场日志】");
  expect(m.text).toContain("/Users/x/Library/Logs/searchx-runner/runner.log");
  expect(m.text).toContain("6 小时");
});

test("composeAlert：现场日志只截末尾若干行并脱敏（别把整轮日志塞进邮件）", () => {
  const long = Array.from({ length: 60 }, (_, i) => `第${i}行`).join("\n") +
    "\nRUNNER_GITHUB_TOKEN=github_pat_11ABCDEFG0fakefakefake";
  const m = composeAlert({
    key: "runner-failed", detail: "定时 runner 退出码 1",
    authorEmail: "a@x.com", fromEmail: "f@x.com", when: "t", logTail: long,
  });
  expect(m.text).not.toContain("github_pat_11ABCDEFG0fakefakefake");
  expect(m.text).not.toContain("第0行");     // 早期行被截掉
  expect(m.text).toContain("第59行");        // 末尾保留
});

test("composeAlert：不给日志尾部 → 主题与正文保持旧格式（探活/搁置那些调用方不受影响）", () => {
  const m = composeAlert({
    key: "stocks-import-parked", detail: "以下报告未过机器质检",
    authorEmail: "a@x.com", fromEmail: "f@x.com", when: "t",
  });
  expect(m.subject).toBe("【searchX 报警·stocks-import-parked】流水线出问题了");
  expect(m.text).toContain("以下报告未过机器质检");
  expect(m.text).not.toContain("【错误类型】");
});

test("parseAlertArgs：拆出 key / 详情 / 日志路径 / 是否从 stdin 读日志", () => {
  const a = parseAlertArgs(["runner-failed", "定时", "runner", "退出码 1", "--log-path", "/x/y.log", "--log-stdin"]);
  expect(a.key).toBe("runner-failed");
  expect(a.detail).toBe("定时 runner 退出码 1");
  expect(a.logPath).toBe("/x/y.log");
  expect(a.logStdin).toBe(true);
});

test("parseAlertArgs：不带开关时照旧（老调用方一个字都不用改）", () => {
  const a = parseAlertArgs(["stocks-import-parked", "以下报告未过机器质检"]);
  expect(a.detail).toBe("以下报告未过机器质检");
  expect(a.logStdin).toBe(false);
  expect(a.logPath).toBe("");
});

test("classifyFailure：关键错误行要吸收 JSON 续行（真实日志里 Bad credentials 在下一行）", () => {
  // 夹具陷阱：把 401 和 Bad credentials 写在同一行就测不出这个缺陷——真实日志是多行 JSON。
  const v = classifyFailure(`error: list issues failed: 401 {
  "message": "Bad credentials",
  "documentation_url": "https://docs.github.com/rest",
  "status": "401"
}`);
  expect(v.summary).toContain("Bad credentials");
});

test("classifyFailure：堆栈行不许拼进关键错误行（那是噪音不是信息）", () => {
  const v = classifyFailure(`Error: in prepare, database is locked (5)
      at execFileSync (node:child_process:269:31)
      at queryReports (/Users/x/services/stocks-import/src/index.js:65:15)`);
  expect(v.summary).toContain("database is locked");
  expect(v.summary).not.toContain("execFileSync");
});

test("composeAlert：现场日志跳过纯符号行（bun 报错里的 ^ 指示行占位不给信息）", () => {
  const m = composeAlert({
    key: "runner-failed", detail: "d", authorEmail: "a@x", fromEmail: "f@x", when: "t",
    logTail: "error: list issues failed: 401\n                     ^\n  \"message\": \"Bad credentials\"",
  });
  const shown = m.text.split("【现场日志】")[1];
  expect(shown).not.toMatch(/\n\s*\^\s*\n/);
  expect(shown).toContain("Bad credentials");
});

test("redactSecrets：只打码全大写的密钥变量，别误伤日志里正常的 key=", () => {
  // 真实日志里满是「⏭ 报警限频中（key=runner-failed，6 小时内已发过）」这类行，
  // 宽松的 KEY= 规则会把它连同后面的字一起抹掉，现场日志反而更难读。
  const t = redactSecrets(
    "⏭ 报警限频中（key=runner-failed，6 小时内已发过）\n" +
    "RUNNER_SMTP_PASS=abcdefghijklmnop\n" +
    "CHECK_KEY: abcdef1234567890"
  );
  expect(t).toContain("key=runner-failed");
  expect(t).toContain("6 小时内已发过");
  expect(t).not.toContain("abcdefghijklmnop");
  expect(t).not.toContain("abcdef1234567890");
});

test("composeAlert：认不出类型时主题退回详情，别把「未知错误」当标题（那比旧版还少信息）", () => {
  const m = composeAlert({
    key: "stocks-import-failed",
    detail: "Stocks→searchX 每日同步 · 构建自检失败（已导入但未提交）",
    authorEmail: "a@x", fromEmail: "f@x", when: "t",
    logTail: "error: Build failed with 3 errors\n某些没见过的输出",
  });
  expect(m.subject).toContain("构建自检失败");
  expect(m.subject).not.toContain("未知错误");
  expect(m.text).toContain("【错误类型】未知错误"); // 正文仍如实说明没认出来
});

test("classifyFailure：只在日志末尾一段里认类型（claude 中途的输出不许劫持分类）", () => {
  // runner 把 claude 的 stdout 整个 inherit 进日志：一次 /stock 调研里 claude 查 Stocks 库
  // 撞上锁，输出里就会有 database is locked，而本轮真正的失败结论在最后。
  const noise = "Error: in prepare, database is locked (5)\n" + Array.from({ length: 80 }, (_, i) => `claude 输出第 ${i} 行`).join("\n");
  const v = classifyFailure(`${noise}\n#50 研究未产出（claude 退出码非 0 或无新文件夹），连续第 1/3 次\n完成：处理 1、失败 1`);
  expect(v.type).toContain("研究未产出");
});
