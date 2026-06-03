// services/intake-worker/src/issue-format.test.js
import { test, expect } from "bun:test";
import { formatIssue, maskEmail } from "./issue-format.js";

test("maskEmail 只露域名，本地名打码", () => {
  expect(maskEmail("alice@gmail.com")).toBe("a****@gmail.com");
  expect(maskEmail("x@d.io")).toBe("x@d.io");
  expect(maskEmail("garbage")).toBe("***");
});

test("formatIssue 标题=题目，标签=pending，指派作者", () => {
  const r = formatIssue(
    { title: "稳定币清结算", focus: "机制", message: "", email: "a@b.com" },
    { author: "qiuyuanqr" }
  );
  expect(r.title).toBe("稳定币清结算");
  expect(r.labels).toEqual(["pending"]);
  expect(r.assignees).toEqual(["qiuyuanqr"]);
  expect(r.body).toContain("@qiuyuanqr");
  expect(r.body).toContain("approved");
});

test("正文用代码围栏包用户内容，杜绝 markdown 注入；含打码邮箱、不含原始邮箱", () => {
  const r = formatIssue(
    { title: "标题", focus: "看 [点我](http://evil)", message: "", email: "alice@gmail.com" },
    { author: "qiuyuanqr" }
  );
  expect(r.body).toContain("```");
  expect(r.body).toContain("[点我](http://evil)"); // 在围栏里，纯文本
  expect(r.body).toContain("a****@gmail.com");
  expect(r.body).not.toContain("alice@gmail.com");
});

test("无侧重点/留言时不渲染对应小节", () => {
  const r = formatIssue(
    { title: "t", focus: "", message: "", email: "a@b.com" },
    { author: "qiuyuanqr" }
  );
  expect(r.body).not.toContain("### 侧重点");
  expect(r.body).not.toContain("### 留言");
});
