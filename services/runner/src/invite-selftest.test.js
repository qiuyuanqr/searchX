import { test, expect } from "bun:test";
import { splitInvites, nextSeenTokens, composeInviteReport } from "./invite-selftest.js";

const P = (token, email = "a***@x.com", addedAt = 1) => ({ token, email, addedAt });

test("splitInvites：没见过的 token 才算新（新增/换钥都会出新 token）", () => {
  const { fresh } = splitInvites(["old1"], [P("old1"), P("new1"), P("new2")]);
  expect(fresh.map((p) => p.token)).toEqual(["new1", "new2"]);
});

test("splitInvites：空「已见」→ 全部算新；空列表 → 无新", () => {
  expect(splitInvites([], [P("a")]).fresh.length).toBe(1);
  expect(splitInvites(undefined, []).fresh.length).toBe(0);
});

test("nextSeenTokens：撤销的掉出、通知成功的进入、通知失败的留待重试", () => {
  // 之前见过 old1/gone；gone 已被撤销（不在 current）；new1 本次通知成功、new2 失败
  const current = [P("old1"), P("new1"), P("new2")];
  const next = nextSeenTokens(current, ["new1"], ["old1", "gone"]);
  expect(next).toEqual(["old1", "new1"]); // gone 掉出，new2 不进 → 下个 tick 重试
});

test("composeInviteReport：主端点+站点都通 → ✅ 且附可转发链接", () => {
  const m = composeInviteReport({
    person: P("t1", "9***@qq.com"), link: "https://site/?k=t1",
    primaryOk: true, fallbackOk: false, siteOk: true,
    authorEmail: "au@x.com", fromEmail: "fr@x.com",
  });
  expect(m.pass).toBe(true);
  expect(m.subject).toContain("✅");
  expect(m.subject).toContain("9***@qq.com");
  expect(m.text).toContain("https://site/?k=t1");
  expect(m.text).toContain("间歇阻断属常态"); // 备用域挂不影响判定，但要说明
  expect(m.to).toBe("au@x.com");
});

test("composeInviteReport：主端点挂 → ❌ 不附链接、说明会自动复检", () => {
  const m = composeInviteReport({
    person: P("t2", "b***@x.com"), link: "https://site/?k=t2",
    primaryOk: false, fallbackOk: true, siteOk: true,
    authorEmail: "au@x.com", fromEmail: "fr@x.com",
  });
  expect(m.pass).toBe(false);
  expect(m.subject).toContain("❌");
  expect(m.text).not.toContain("https://site/?k=t2");
  expect(m.text).toContain("自动复检");
});

test("composeInviteReport：诚实边界——声明不代表对方手机网络可达", () => {
  const m = composeInviteReport({
    person: P("t3"), link: "https://site/?k=t3",
    primaryOk: true, fallbackOk: true, siteOk: true,
    authorEmail: "au@x.com", fromEmail: "fr@x.com",
  });
  expect(m.text).toContain("不能代表对方手机网络必然可达");
});
