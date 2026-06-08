// services/runner/src/email.test.js
import { test, expect } from "bun:test";
import { composeEmail, composeExistingEmail, composeAuthorDigest, composeParkNotice, sendEmail } from "./email.js";

test("composeEmail：主题含标题、正文含 TLDR 与链接、抄送作者、from 用 smtpUser", () => {
  const m = composeEmail({
    topic: "稳定币清结算",
    title: "稳定币的清结算机制",
    tldr: "本质是银行间记账",
    url: "https://qiuyuanqr.github.io/searchX/r/2026-06-03_x/",
    toEmail: "u@x.com",
    authorEmail: "me@gmail.com",
    fromEmail: "me@gmail.com",
  });
  expect(m.subject).toContain("稳定币的清结算机制");
  expect(m.text).toContain("本质是银行间记账");
  expect(m.text).toContain("https://qiuyuanqr.github.io/searchX/r/2026-06-03_x/");
  expect(m.to).toBe("u@x.com");
  expect(m.cc).toBe("me@gmail.com");
  expect(m.from).toBe("me@gmail.com");
});

test("无 TLDR 也不报错、不留空噪声行", () => {
  const m = composeEmail({
    topic: "X", title: "X", tldr: "",
    url: "https://x/r/y/", toEmail: "u@x.com", authorEmail: "me@g.com", fromEmail: "me@g.com",
  });
  expect(m.text).toContain("https://x/r/y/");
  expect(m.text).not.toContain("一句话结论：");
});

test("composeExistingEmail：主题标『已有』、正文含链接与 TLDR、发提交者抄作者", () => {
  const m = composeExistingEmail({
    topic: "芯原股份",
    title: "芯原股份（688521.SH）",
    tldr: "国内半导体 IP 龙头",
    url: "https://qiuyuanqr.github.io/searchX/r/2026-06-08_verisilicon-688521/",
    ageDays: 2,
    toEmail: "u@x.com",
    authorEmail: "me@gmail.com",
    fromEmail: "me@gmail.com",
  });
  expect(m.subject).toContain("已有");
  expect(m.subject).toContain("芯原股份");
  expect(m.text).toContain("不重复调研");
  expect(m.text).toContain("https://qiuyuanqr.github.io/searchX/r/2026-06-08_verisilicon-688521/");
  expect(m.text).toContain("国内半导体 IP 龙头");
  expect(m.to).toBe("u@x.com");
  expect(m.cc).toBe("me@gmail.com");
  expect(m.from).toBe("me@gmail.com");
});

test("composeExistingEmail：无 TLDR 不留空噪声行", () => {
  const m = composeExistingEmail({
    topic: "X", title: "X", tldr: "", url: "https://x/r/y/",
    toEmail: "u@x.com", authorEmail: "me@g.com", fromEmail: "me@g.com",
  });
  expect(m.text).toContain("https://x/r/y/");
  expect(m.text).not.toContain("一句话结论：");
});

test("composeAuthorDigest：只发给作者（无 cc）、含报告名/链接/今日计数、不含提交者邮箱", () => {
  const m = composeAuthorDigest({
    topic: "左侧交易和右侧交易的区别",
    title: "左侧交易 vs 右侧交易",
    url: "https://qiuyuanqr.github.io/searchX/r/2026-06-04_x/",
    date: "2026-06-04",
    count: 3,
    authorEmail: "me@gmail.com",
    fromEmail: "me@gmail.com",
  });
  expect(m.to).toBe("me@gmail.com");
  expect(m.cc).toBeUndefined();
  expect(m.subject).toContain("左侧交易 vs 右侧交易");
  expect(m.subject).toContain("3");
  expect(m.text).toContain("https://qiuyuanqr.github.io/searchX/r/2026-06-04_x/");
  expect(m.text).toContain("今日（2026-06-04）累计完成 3 篇");
  expect(m.text).not.toContain("@"); // 正文不出现任何邮箱（隐私）—— URL/正文均无 @
});

test("composeParkNotice：只发作者（无 cc）、含主题/原因/没解决条目/本地草稿路径、主题标『已搁置』", () => {
  const m = composeParkNotice({
    topic: "奥比中光",
    reason: "撑 A 节方向判断的营收数与公告对不上、消解不掉",
    unresolved: ["报告说 23 年营收 33 亿／公告说 5.5 亿／http://src", "Q3 毛利率引述在来源里查无"],
    folder: "research/2026-06-06_orbbec-688322",
    authorEmail: "me@gmail.com",
    fromEmail: "me@gmail.com",
  });
  expect(m.to).toBe("me@gmail.com");
  expect(m.cc).toBeUndefined();             // 绝不抄送提交者
  expect(m.from).toBe("me@gmail.com");
  expect(m.subject).toContain("已搁置");
  expect(m.subject).toContain("奥比中光");
  expect(m.text).toContain("撑 A 节方向判断的营收数与公告对不上");
  expect(m.text).toContain("报告说 23 年营收 33 亿");
  expect(m.text).toContain("research/2026-06-06_orbbec-688322");
  expect(m.text).toContain("未公开"); // 点明未发布、未给提交者发信
});

test("composeParkNotice：无 reason/unresolved/folder 也不报错、不留噪声行", () => {
  const m = composeParkNotice({ topic: "X", authorEmail: "me@g.com", fromEmail: "me@g.com" });
  expect(m.to).toBe("me@g.com");
  expect(m.cc).toBeUndefined();
  expect(m.text).toContain("X");
  expect(m.text).not.toContain("搁置原因：");
  expect(m.text).not.toContain("没解决的硬错：");
  expect(m.text).not.toContain("本地草稿");
});

test("sendEmail 调用注入的 transport.sendMail", async () => {
  let sent;
  const transport = { sendMail: async (msg) => { sent = msg; return { messageId: "1" }; } };
  await sendEmail({ to: "u@x.com" }, { transport });
  expect(sent.to).toBe("u@x.com");
});
