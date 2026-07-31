// services/runner/src/atomic-write.test.js
// 第二轮审查点名：atomic-write 是两个 runner 全部状态落盘的地基（补发队列、失败计数、
// 连败 streak、attempts），却零测试、也不进覆盖率分母。这里把它的契约钉死。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";

function sandbox() {
  return mkdtempSync(join(tmpdir(), "searchx-atomic-"));
}

test("正常写入：内容落盘，且不留下临时文件", () => {
  const dir = sandbox();
  try {
    const f = join(dir, "state.json");
    writeFileAtomic(f, JSON.stringify({ a: 1 }));
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ a: 1 });
    expect(readdirSync(dir)).toEqual(["state.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("覆写：旧内容被完整替换，中间不出现半截文件", () => {
  const dir = sandbox();
  try {
    const f = join(dir, "state.json");
    writeFileAtomic(f, JSON.stringify({ v: 1, pad: "x".repeat(5000) }));
    writeFileAtomic(f, JSON.stringify({ v: 2 }));
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ v: 2 });
    expect(readdirSync(dir)).toEqual(["state.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("写失败：原样抛出，且清掉临时文件、不破坏原有内容", () => {
  const dir = sandbox();
  try {
    const sub = join(dir, "ro");
    mkdirSync(sub);
    const f = join(sub, "state.json");
    writeFileAtomic(f, "原有内容");        // 先写一份好的
    chmodSync(sub, 0o500);                  // 目录只读 → 临时文件建不出来
    expect(() => writeFileAtomic(f, "新内容")).toThrow();
    chmodSync(sub, 0o700);
    expect(readFileSync(f, "utf8")).toBe("原有内容"); // 原文件未被破坏
    expect(readdirSync(sub)).toEqual(["state.json"]); // 没留临时文件
  } finally {
    try { chmodSync(join(dir, "ro"), 0o700); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("临时文件名带 pid：并发写同一目标不会互相踩到对方的半成品", () => {
  const dir = sandbox();
  try {
    const f = join(dir, "state.json");
    // 直接造一个「别的进程遗留的临时文件」，本进程的写不该受它影响、也不该删它
    const foreignTmp = `${f}.999999.tmp`;
    writeFileSync(foreignTmp, "别人的半成品");
    writeFileAtomic(f, "我的内容");
    expect(readFileSync(f, "utf8")).toBe("我的内容");
    expect(readFileSync(foreignTmp, "utf8")).toBe("别人的半成品");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("读者要么看到旧的完整内容、要么看到新的完整内容（不会读到半截 JSON）", () => {
  const dir = sandbox();
  try {
    const f = join(dir, "state.json");
    const big = JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ i })));
    writeFileAtomic(f, JSON.stringify([{ old: true }]));
    // 每次覆写后立刻读，解析必须成功——rename 是原子的，不存在中间态
    for (let n = 0; n < 20; n++) {
      writeFileAtomic(f, big);
      expect(() => JSON.parse(readFileSync(f, "utf8"))).not.toThrow();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
