// scripts/git-sync-hook.test.js
// .claude/hooks/git-sync.sh 的自动化回归测试（在临时沙盒仓库里跑真实脚本，绝不碰本仓库）。
//
// 盯的是隐私红线：收工自动提交前那两道按「文件名」匹配的闸（机密词、park 报告目录）。
// git 默认 core.quotePath=true 会把中文路径输出成 "\346\214\201..." 八进制转义串，
// 闸里的 grep '持仓' 因此永远不命中——中文命名的持仓文件会被自动提交推上公开仓。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const HOOK = join(import.meta.dir, "..", ".claude", "hooks", "git-sync.sh");

function sh(cmd, cwd, env) {
  return execFileSync("bash", ["-c", cmd], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}

/** 造一个带 origin（URL 含 qiuyuanqr/searchX 以过安全闸）的沙盒仓库，返回工作树路径与环境。 */
function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), "searchx-gitsync-"));
  const remote = join(root, "qiuyuanqr", "searchX.git");
  mkdirSync(join(root, "qiuyuanqr"), { recursive: true });
  sh(`git init -q --bare "${remote}"`, root);
  const work = join(root, "work");
  mkdirSync(work);
  sh(
    [
      "git init -q -b main",
      "git config user.email t@example.com",
      "git config user.name tester",
      `git remote add origin "${remote}"`,
      "echo seed > seed.txt",
      "git add -A",
      "git commit -qm init",
      "git push -q -u origin main",
    ].join(" && "),
    work
  );
  mkdirSync(join(work, ".claude", "hooks"), { recursive: true });
  cpSync(HOOK, join(work, ".claude", "hooks", "git-sync.sh"));
  // 挡掉 notify_peer 的 ssh（沙盒里不该往外发连接），并给每个沙盒独立的同步锁目录
  const fakebin = join(root, "fakebin");
  mkdirSync(fakebin);
  writeFileSync(join(fakebin, "ssh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const env = {
    CLAUDE_PROJECT_DIR: work,
    SEARCHX_SYNC_LOCK: join(root, "searchx-gitsync.lock"), // 每个沙盒独立的同步锁
    TMPDIR: root,
    PATH: `${fakebin}:${process.env.PATH}`,
    SEARCHX_IN_RUNNER: "",
    HOME: root, // 隔离 runner 锁路径，避免读到真机上的锁
  };
  return { root, work, env, remote };
}

function pushedFiles(work, env) {
  return sh("git -c core.quotePath=false ls-tree -r --name-only origin/main", work, env)
    .trim()
    .split("\n")
    .filter(Boolean);
}

test("闸2：中文命名的机密文件（持仓）能被拦下，不会自动提交推上公开仓", () => {
  const { root, work, env } = makeSandbox();
  try {
    writeFileSync(join(work, "我的持仓明细.md"), "仓位与成本\n");
    const out = sh(`bash .claude/hooks/git-sync.sh push`, work, env);
    expect(out).toContain("疑似机密/敏感文件");
    expect(out).toContain("我的持仓明细.md");
    expect(out).not.toContain("已自动提交");
    expect(pushedFiles(work, env)).toEqual(["seed.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("闸2：ASCII 机密文件名照常拦下（防修复把原有能力改坏）", () => {
  const { root, work, env } = makeSandbox();
  try {
    writeFileSync(join(work, "my-holding.md"), "x\n");
    const out = sh(`bash .claude/hooks/git-sync.sh push`, work, env);
    expect(out).toContain("疑似机密/敏感文件");
    expect(pushedFiles(work, env)).toEqual(["seed.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("闸3：含中文名的 park 报告目录被剔除，普通改动照常提交推送", () => {
  const { root, work, env } = makeSandbox();
  try {
    const parked = join(work, "research", "2026-07-31_测试主题");
    mkdirSync(parked, { recursive: true });
    writeFileSync(join(parked, ".parked"), "");
    writeFileSync(join(parked, "report.html"), "<html>半成品</html>");
    writeFileSync(join(work, "normal.md"), "正常改动\n");
    const out = sh(`bash .claude/hooks/git-sync.sh push`, work, env);
    expect(out).toContain("已从自动提交排除");
    const files = pushedFiles(work, env);
    expect(files).toContain("normal.md");
    expect(files.some((f) => f.includes("2026-07-31"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("无敏感文件时正常自动提交并推送", () => {
  const { root, work, env } = makeSandbox();
  try {
    writeFileSync(join(work, "普通笔记.md"), "内容\n");
    const out = sh(`bash .claude/hooks/git-sync.sh push`, work, env);
    expect(out).toContain("已自动提交");
    expect(pushedFiles(work, env)).toContain("普通笔记.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("自互斥：已有活着的同步锁时静默跳过，不并发动工作树", () => {
  const { root, work, env } = makeSandbox();
  try {
    // 手工占锁，pid 用当前测试进程（必然活着）
    const lock = join(root, "searchx-gitsync.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), String(process.pid));
    writeFileSync(join(work, "普通笔记.md"), "内容\n");
    const out = sh(`bash .claude/hooks/git-sync.sh push`, work, env);
    expect(out.trim()).toBe("");
    expect(pushedFiles(work, env)).toEqual(["seed.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 锁的三个风险分支（2026-07-31 第二轮审查：首轮只测了最顺的一条路）─────────
test("自互斥：锁目录存在但没有 pid 文件且很新 → 静默跳过（视为刚建锁的另一进程）", () => {
  const { root, work, env } = makeSandbox();
  try {
    mkdirSync(join(root, "searchx-gitsync.lock"), { recursive: true }); // 只有目录，没写 pid
    writeFileSync(join(work, "改动.md"), "内容\n");
    const out = sh(`bash .claude/hooks/git-sync.sh push`, work, env);
    expect(out.trim()).toBe("");
    expect(pushedFiles(work, env)).toEqual(["seed.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("自互斥：持有者已死的残锁被抢过来，工作继续（不能因为残锁永久卡死）", () => {
  const { root, work, env } = makeSandbox();
  try {
    const lock = join(root, "searchx-gitsync.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), "999999"); // 几乎不可能存在的 pid
    writeFileSync(join(work, "改动.md"), "内容\n");
    const out = sh(`bash .claude/hooks/git-sync.sh push`, work, env);
    expect(out).toContain("已自动提交");
    expect(pushedFiles(work, env)).toContain("改动.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("自互斥：释放时核对归属——锁已被别人接管则不删（不误删接管者的锁）", () => {
  const { root, work, env } = makeSandbox();
  try {
    writeFileSync(join(work, "改动.md"), "内容\n");
    sh(`bash .claude/hooks/git-sync.sh push`, work, env);           // 正常跑一次，退出时应清掉自己的锁
    expect(existsSync(join(root, "searchx-gitsync.lock"))).toBe(false);
    // 再造一把「别人的」锁，跑一次脚本（会因活 pid 跳过），锁必须原封不动还在
    const lock = join(root, "searchx-gitsync.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), String(process.pid));
    sh(`bash .claude/hooks/git-sync.sh pull`, work, env);
    expect(existsSync(lock)).toBe(true);
    expect(sh(`cat "${join(lock, "pid")}"`, work, env).trim()).toBe(String(process.pid));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
