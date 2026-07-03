import { test, expect } from "bun:test";
import { shouldAlert, composeAlert, evaluateProbe, MIN_INTERVAL_MS } from "./alert.js";

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
  const v = evaluateProbe({ siteOk: true, primaryOk: true, fallbackOk: true, site: "s", primary: "p", fallback: "f" });
  expect(v.alert).toBe(false);
});

test("evaluateProbe：仅备用挂 → 不报警只留痕（workers.dev 墙内间歇阻断是已知常态）", () => {
  const v = evaluateProbe({ siteOk: true, primaryOk: true, fallbackOk: false, site: "s", primary: "p", fallback: "f" });
  expect(v.alert).toBe(false);
  expect(v.detail).toContain("f");
});

test("evaluateProbe：主端点挂 → 报警；主备全挂 → 报警并注明链路完全断", () => {
  expect(evaluateProbe({ siteOk: true, primaryOk: false, fallbackOk: true, site: "s", primary: "p", fallback: "f" }).alert).toBe(true);
  const all = evaluateProbe({ siteOk: true, primaryOk: false, fallbackOk: false, site: "s", primary: "p", fallback: "f" });
  expect(all.alert).toBe(true);
  expect(all.detail).toContain("完全断");
});

test("evaluateProbe：站点挂 → 报警（朋友打不开首页同样是事故）", () => {
  const v = evaluateProbe({ siteOk: false, primaryOk: true, fallbackOk: true, site: "https://site", primary: "p", fallback: "f" });
  expect(v.alert).toBe(true);
  expect(v.detail).toContain("https://site");
});
