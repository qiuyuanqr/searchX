import { describe, it, expect } from "bun:test";
import { buildBarkRequest, sendBark } from "./bark.js";

describe("buildBarkRequest", () => {
  it("未配置 barkUrl → null（不发）", () => {
    expect(buildBarkRequest({ barkUrl: "", outcome: "done" })).toBeNull();
    expect(buildBarkRequest({ outcome: "done" })).toBeNull();
  });

  it("默认（不带细节）：正文只说完成，不含标题 / 结论 / 原文；去掉 barkUrl 末尾斜杠", () => {
    const r = buildBarkRequest({ barkUrl: "https://api.day.app/KEY/", outcome: "done", title: "某公众号称XX", summary: "属实（高）：真" });
    expect(r.url).toBe("https://api.day.app/KEY");
    expect(r.init.method).toBe("POST");
    const p = JSON.parse(r.init.body);
    expect(p.title).toBe("searchX 核查完成");
    expect(p.body).not.toContain("某公众号称XX");
    expect(p.body).not.toContain("属实");
    expect(p.group).toBe("searchx-check");
    expect(p.url).toBeUndefined();
  });

  it("detail=true：正文带内容标题 + 一行结论；配了核查页地址则带 url", () => {
    const r = buildBarkRequest({ barkUrl: "https://api.day.app/KEY", outcome: "done", title: "某公众号称XX", summary: "属实（高）：确有其事", detail: true, checkPageUrl: "https://x.github.io/check.html" });
    const p = JSON.parse(r.init.body);
    expect(p.body).toBe("某公众号称XX\n属实（高）：确有其事");
    expect(p.url).toBe("https://x.github.io/check.html");
  });

  it("detail=true 但标题结论都空 → 退回默认正文", () => {
    const p = JSON.parse(buildBarkRequest({ barkUrl: "https://b/k", outcome: "done", detail: true }).init.body);
    expect(p.body).toBe("有一条核查已完成，打开核查页查看结论");
  });

  it("failed：标题写失败、正文提示一键重试；detail 时带内容标题", () => {
    const a = JSON.parse(buildBarkRequest({ barkUrl: "https://b/k", outcome: "failed", title: "T" }).init.body);
    expect(a.title).toBe("searchX 核查失败");
    expect(a.body).toContain("一键重试");
    expect(a.body).not.toContain("T");
    const b = JSON.parse(buildBarkRequest({ barkUrl: "https://b/k", outcome: "failed", title: "T", detail: true }).init.body);
    expect(b.body).toContain("「T」");
  });

  it("超长标题 / 结论被截断", () => {
    const p = JSON.parse(buildBarkRequest({ barkUrl: "https://b/k", outcome: "done", title: "标".repeat(80), summary: "论".repeat(300), detail: true }).init.body);
    const [t, s] = p.body.split("\n");
    expect(t.length).toBe(40);
    expect(s.length).toBe(120);
  });
});

describe("sendBark", () => {
  it("req 为 null 直接返回；2xx 正常；非 2xx 抛", async () => {
    await sendBark(null, async () => { throw new Error("不该被调"); });
    let called = null;
    await sendBark({ url: "https://b/k", init: { method: "POST", body: "{}" } }, async (u, init) => { called = [u, init.method, !!init.signal]; return { ok: true, status: 200 }; });
    expect(called).toEqual(["https://b/k", "POST", true]);
    await expect(sendBark({ url: "https://b/k", init: { method: "POST" } }, async () => ({ ok: false, status: 500 }))).rejects.toThrow("bark 500");
  });
});
