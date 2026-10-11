// scripts/agent-rules-sync.test.js
// Claude 与 Codex 各有一套规则 / 技能 / 钩子文件，内容本该相同。这里盯住它们不要各改各的：
// 一边改了规则、另一边没跟，线上自动产出（Codex 读 .agents/skills）和本机交互式产出
// （Claude 读 .claude/skills）就会按两套口径写报告，而且没有任何地方会报错。
//
// 允许的差异只有三类，其余必须逐字相同：
//   1. 路径替换：.agents/skills ↔ .claude/skills、AGENTS.md ↔ CLAUDE.md、.codex/hooks ↔ .claude/hooks
//   2. Codex 技能里的「## Codex 平台适配」一段
//   3. 两份规则文件「## 全局约定」之前的部分（各自的开工入口）
import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const SHARED_FROM = "## 全局约定";
const CODEX_ONLY = "## Codex 平台适配";
const SKILLS = ["research", "stock", "factcheck"];
const HOOKS = ["git-sync.sh", "autopull.sh", "memory-sync.sh"];

/** 把 Codex 侧的写法换回 Claude 侧的，再去掉 Codex 独有的平台适配段。 */
function codexToClaude(text) {
  const lines = text.split("\n");
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (line.startsWith(CODEX_ONLY)) { skipping = true; continue; }
    if (skipping && /^#{1,2} /.test(line)) skipping = false; // 适配段后面接的是一级标题
    if (!skipping) out.push(line);
  }
  return out.join("\n")
    .replaceAll(".agents/skills", ".claude/skills")
    .replaceAll("AGENTS.md", "CLAUDE.md")
    .replaceAll(".codex/hooks", ".claude/hooks");
}

/** 第一处不同的行，报错时直接指给人看（整篇 diff 太长没法读）。 */
function firstDiff(a, b) {
  const x = a.split("\n"), y = b.split("\n");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return `第 ${i + 1} 行\n  Claude 侧: ${x[i] ?? "（没有这一行）"}\n  Codex 侧: ${y[i] ?? "（没有这一行）"}`;
  }
  return null;
}

test("CLAUDE.md 与 AGENTS.md 从「全局约定」起到文末逐字相同", () => {
  const claude = read("CLAUDE.md"), agents = read("AGENTS.md");
  const a = claude.slice(claude.indexOf(SHARED_FROM));
  const b = agents.slice(agents.indexOf(SHARED_FROM));
  // 判别力自检：找不到分界标题时 indexOf 返回 -1，slice(-1) 只剩一个换行，两边会「恰好相同」。
  expect(claude.indexOf(SHARED_FROM)).toBeGreaterThan(0);
  expect(agents.indexOf(SHARED_FROM)).toBeGreaterThan(0);
  expect(a.length).toBeGreaterThan(2000);
  expect(firstDiff(a, b)).toBeNull();
});

for (const name of SKILLS) {
  test(`${name} 技能两份内容一致（除路径替换与 Codex 平台适配段）`, () => {
    const claude = read(`.claude/skills/${name}/SKILL.md`);
    const codexRaw = read(`.agents/skills/${name}/SKILL.md`);
    const codex = codexToClaude(codexRaw);
    // 判别力自检：平台适配段确实存在且只删掉了它，没把后面的正文一起吞掉。
    expect(codexRaw).toContain(CODEX_ONLY);
    expect(codex.length).toBeGreaterThan(claude.length * 0.9);
    // 平台适配段前后各留了空行，去掉后会多出空行；只比非空行的序列。
    const squash = (s) => s.split("\n").filter((l) => l.trim() !== "").join("\n");
    expect(firstDiff(squash(claude), squash(codex))).toBeNull();
  });
}

test("报告模板两份逐字相同", () => {
  const dirA = ".claude/skills/research/templates", dirB = ".agents/skills/research/templates";
  const files = readdirSync(join(ROOT, dirA)).filter((f) => !f.startsWith("."));
  expect(files.length).toBeGreaterThan(0);
  expect(readdirSync(join(ROOT, dirB)).filter((f) => !f.startsWith(".")).sort()).toEqual([...files].sort());
  for (const f of files) expect(read(`${dirB}/${f}`) === read(`${dirA}/${f}`)).toBe(true);
});

test("同步钩子两份逐字相同", () => {
  for (const f of HOOKS) expect(read(`.codex/hooks/${f}`) === read(`.claude/hooks/${f}`)).toBe(true);
});
