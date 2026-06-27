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

  it("text + 图片路径：追加 Read 指引段", () => {
    expect(
      buildFactcheckPrompt({ text: "看看这张图", imagePaths: ["/tmp/a/0.jpg", "/tmp/a/1.png"] })
    ).toBe(
      "/factcheck 看看这张图\n附图为本地文件，请用 Read 逐张打开后纳入核查：\n/tmp/a/0.jpg\n/tmp/a/1.png"
    );
  });

  it("仅图片（无 text/link）：命令后直接接图片指引段", () => {
    expect(buildFactcheckPrompt({ imagePaths: ["/tmp/a/0.jpg"] })).toBe(
      "/factcheck 附图为本地文件，请用 Read 逐张打开后纳入核查：\n/tmp/a/0.jpg"
    );
  });

  it("imagePaths 为空数组：与无图等价", () => {
    expect(buildFactcheckPrompt({ text: "消息", imagePaths: [] })).toBe("/factcheck 消息");
  });

  it("link + 图片：三段拼接", () => {
    expect(
      buildFactcheckPrompt({ link: "https://x.com", imagePaths: ["/tmp/a/0.jpg"] })
    ).toBe(
      "/factcheck 链接：https://x.com\n附图为本地文件，请用 Read 逐张打开后纳入核查：\n/tmp/a/0.jpg"
    );
  });
});
