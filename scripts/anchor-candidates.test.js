import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quotedPrice, classify, collect, render } from "./anchor-candidates.js";

test("只从价位类硬红线里取原文，别的红线一概不碰", () => {
  expect(quotedPrice('【报告正文】具体触发价位「跌破 MA20 29.24 元」（§4.9…）')).toBe("跌破 MA20 29.24 元");
  expect(quotedPrice("【报告正文】疑似用户私人信息（个人持仓/账户）：…")).toBeNull();
  expect(quotedPrice("【报告正文】预测性价格区间「30–44 元区间」（§4.9…）")).toBeNull();
});

// ① 候选锚名：词表外的**真实客观刻度**。这一类正是本脚本存在的理由——它要在下一封
// 报警之前就把「该补哪个词」说出来。用一个当前表里确实没有的转债刻度当样本。
test("词表外的客观刻度 → 候选锚名（该补词表的就是它）", () => {
  expect(classify("跌破本次回售触发价 89.50 元")).toEqual({ kind: "candidate", anchorText: "本次回售触发价" });
});

// ② 裸价位：改写器故意不猜。通用主语（股价/价格）不算锚，否则词表等于废掉。
test("裸价位与「股价」这类通用主语 → 裸价位，不当候选", () => {
  expect(classify("跌破 54.00 元").kind).toBe("bare");
  expect(classify("跌破股价 54.00 元").kind).toBe("bare");
});

// ③ 存量残留：词表现在认得、报告是补词之前导入的。补词表不回溯已入库的正文。
// 三个都是真实原文（09-01 两篇 + 09-18 茂莱）。
test("词表已认得且现在剥得掉 → 存量残留", () => {
  for (const s of ["失守 MA20 29.24 元", "跌破 9-01 当日最低 13.81 元", "跌破茂莱转债转股价 364.15 元"]) {
    expect(classify(s).kind).toBe("stale");
  }
});

// ④ 改写器够不着：有锚却一个字都剥不掉，补词表没用。
// ⚠️ 存量里暂时没有真样本（QC 报的引文不跨括号，那类推算价位两边都够不着、也报不出），
// 所以这里用改写器明确会跳过的带标签形态钉住行为——真样本出现时这条分类自然会接住它。
test("有锚但改写器一个字不动 → 够不着（不是词表问题）", () => {
  expect(classify("跌破 MA20 <strong>29.24 元</strong>").kind).toBe("unreachable");
});

test("拿不到触发词就如实报「解析不了」，不猜", () => {
  expect(classify("站在 29.24 元上方").kind).toBe("unparsed");
});

test("扫目录：分诊结果与渲染都指向下一步动作", () => {
  const root = mkdtempSync(join(tmpdir(), "anchor-"));
  const dir = "2026-09-04_stock-000001";
  mkdirSync(join(root, dir));
  writeFileSync(join(root, dir, "notes.md"), "---\ntype: 股票\n---\n");
  writeFileSync(
    join(root, dir, "report.html"),
    "<h1>x</h1><h2>L. 决策与风控</h2><p>如果跌破本次回售触发价 89.50 元，那么观望</p>"
  );
  const res = collect(null, root);
  expect(res.scanned).toBe(1);
  expect([...res.candidate.values()][0]).toMatchObject({ anchor: "本次回售触发价", count: 1 });
  const out = render(res);
  expect(out).toContain("本次回售触发价");
  expect(out).toContain("同步 Stocks 侧 SKILL"); // 成对改那条必须出现在人眼前
});

test("没有被拦下的价位时，说清楚是「没有」而不是「没扫」", () => {
  const root = mkdtempSync(join(tmpdir(), "anchor-"));
  const dir = "2026-09-04_stock-000002";
  mkdirSync(join(root, dir));
  writeFileSync(join(root, dir, "notes.md"), "---\ntype: 股票\n---\n");
  writeFileSync(join(root, dir, "report.html"), "<h1>x</h1><h2>L. 决策与风控</h2><p>如果跌破 MA20 那么观望</p>");
  const out = render(collect(null, root));
  expect(out).toContain("扫了 1 篇");
  expect(out).toContain("没有待补的锚名");
});
