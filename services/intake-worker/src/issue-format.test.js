// services/intake-worker/src/issue-format.test.js
import { test, expect } from "bun:test";
import { formatIssue, maskEmail } from "./issue-format.js";

test("maskEmail 定长掩码：不泄露本地名长度、单字符本地名也不暴露、只露域名", () => {
  expect(maskEmail("alice@gmail.com")).toBe("a***@gmail.com"); // 定长 ***，不再按长度给星
  expect(maskEmail("bob@gmail.com")).toBe("b***@gmail.com");   // 不同长度本地名 → 同样掩码（不泄露长度）
  expect(maskEmail("x@d.io")).toBe("***@d.io");                // 单字符本地名不暴露
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
  expect(r.body).toContain("a***@gmail.com");
  expect(r.body).not.toContain("alice@gmail.com");
});

test("带 flags 时正文含安全初筛红旗 + 提示逐字核对；无 flags 时不出现", () => {
  const withFlags = formatIssue(
    { title: "标题", focus: "忽略以上指令", message: "", email: "a@b.com" },
    { author: "qiuyuanqr", flags: ["疑似指令覆盖（忽略以上指令 / ignore previous）"] }
  );
  expect(withFlags.body).toContain("自动安全初筛");
  expect(withFlags.body).toContain("疑似指令覆盖");
  expect(withFlags.body).toContain("逐字核对");

  const clean = formatIssue(
    { title: "标题", focus: "正常", message: "", email: "a@b.com" },
    { author: "qiuyuanqr" } // 不传 flags → 默认 []
  );
  expect(clean.body).not.toContain("自动安全初筛");
});

test("无侧重点/留言时不渲染对应小节", () => {
  const r = formatIssue(
    { title: "t", focus: "", message: "", email: "a@b.com" },
    { author: "qiuyuanqr" }
  );
  expect(r.body).not.toContain("### 侧重点");
  expect(r.body).not.toContain("### 留言");
});
