import { test, expect } from "bun:test";
import { inviteLink, renderPeopleRows, describeAdminError, escapeHtml } from "./admin.js";

test("inviteLink：按站点 base 拼 ?k= 链接", () => {
  expect(inviteLink("https://qiuyuanqr.github.io/searchX/", "TOK")).toBe("https://qiuyuanqr.github.io/searchX/?k=TOK");
});

test("renderPeopleRows：含邮箱、专属链接、撤销按钮", () => {
  const html = renderPeopleRows([{ email: "a@x.com", token: "T", addedAt: 0 }], "https://s/");
  expect(html).toContain("a@x.com");
  expect(html).toContain("?k=T");
  expect(html).toContain('data-email="a@x.com"');
  expect(html).toContain('data-act="revoke"');
  expect(html).toContain('data-act="copy"');
});

test("renderPeopleRows：邮箱里的 HTML 被转义防 XSS", () => {
  const html = renderPeopleRows([{ email: "<img src=x onerror=alert(1)>@x.com", token: "T", addedAt: 0 }], "https://s/");
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;img");
});

test("renderPeopleRows：空列表 → 空串", () => {
  expect(renderPeopleRows([], "https://s/")).toBe("");
  expect(renderPeopleRows(null, "https://s/")).toBe("");
});

test("describeAdminError：401/429/400 给清楚中文", () => {
  expect(describeAdminError(401)).toContain("密钥");
  expect(describeAdminError(429)).toContain("锁定");
  expect(describeAdminError(400)).toContain("邮箱");
});

test("escapeHtml 转义 & < > 双引号", () => {
  expect(escapeHtml(`<a href="x">&`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
});

// ── describeSelftest：新增授权后的即时链接自检文案 ──
import { describeSelftest } from "./admin.js";

test("describeSelftest：verify 通过 → ✓ 且回显打码邮箱", () => {
  const r = describeSelftest({ ok: true, email: "9***@qq.com" });
  expect(r.kind).toBe("ok");
  expect(r.text).toContain("9***@qq.com");
  expect(r.text).toContain("自检通过");
});

test("describeSelftest：verify 不通过 / 网络错（null）→ ⚠ 提示先别发", () => {
  for (const res of [{ ok: false }, null, undefined]) {
    const r = describeSelftest(res);
    expect(r.kind).toBe("warn");
    expect(r.text).toContain("先别把链接发出去");
  }
});
