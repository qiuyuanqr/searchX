// services/runner/src/parse-issue.test.js
import { test, expect } from "bun:test";
import { parseIssueRequest } from "./parse-issue.js";

// 与 M2a issue-format.js 产出的正文一致的夹具
const BODY = [
  "**调研请求**（来自站内表单）",
  "",
  "- 提交者邮箱（打码）：`a****@gmail.com`",
  "- 审批：@qiuyuanqr 贴 `approved` 标签即开始（贴前 0 花费）",
  "",
  "### 题目",
  "```",
  "稳定币的清结算机制",
  "```",
  "",
  "### 侧重点",
  "```",
  "重点讲清算所角色与跨境路径",
  "```",
].join("\n");

test("题目取自标题、侧重点取自围栏", () => {
  const r = parseIssueRequest({ title: "稳定币的清结算机制", body: BODY });
  expect(r.topic).toBe("稳定币的清结算机制");
  expect(r.focus).toBe("重点讲清算所角色与跨境路径");
});

test("无侧重点小节 → focus 为空", () => {
  const body = "### 题目\n```\nX\n```";
  expect(parseIssueRequest({ title: "X", body }).focus).toBe("");
});

test("标题首尾空白被去掉", () => {
  expect(parseIssueRequest({ title: "  CPO  ", body: "" }).topic).toBe("CPO");
});

test("CRLF 行尾（GitHub API 实际返回）也能解析侧重点", () => {
  const crlf = "### 侧重点\r\n```\r\n跨境路径\r\n```";
  expect(parseIssueRequest({ title: "X", body: crlf }).focus).toBe("跨境路径");
});
