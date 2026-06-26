// services/check-runner/src/factcheck-cmd.test.js
import { describe, it, expect } from "bun:test";
import { buildFactcheckPrompt } from "./factcheck-cmd.js";

describe("buildFactcheckPrompt", () => {
  it("仅 text", () => {
    expect(buildFactcheckPrompt({ text: "某某说了什么" })).toBe("/factcheck 某某说了什么");
  });

  it("仅 link", () => {
    expect(buildFactcheckPrompt({ link: "https://example.com/news" })).toBe(
      "/factcheck 链接：https://example.com/news"
    );
  });

  it("text + link 都有", () => {
    expect(buildFactcheckPrompt({ text: "这条消息", link: "https://example.com" })).toBe(
      "/factcheck 这条消息\n链接：https://example.com"
    );
  });

  it("两者都空则只剩命令", () => {
    expect(buildFactcheckPrompt({})).toBe("/factcheck ");
  });

  it("text 带首尾空白会被去掉", () => {
    expect(buildFactcheckPrompt({ text: "  消息  " })).toBe("/factcheck 消息");
  });
});
