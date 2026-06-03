// services/runner/src/email.test.js
import { test, expect } from "bun:test";
import { composeEmail, sendEmail } from "./email.js";

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

test("sendEmail 调用注入的 transport.sendMail", async () => {
  let sent;
  const transport = { sendMail: async (msg) => { sent = msg; return { messageId: "1" }; } };
  await sendEmail({ to: "u@x.com" }, { transport });
  expect(sent.to).toBe("u@x.com");
});
