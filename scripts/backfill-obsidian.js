// 一次性回填：把 research/ 下所有归档文件夹重新同步到 Obsidian，
// 出「中文名 + 全文」笔记，替换掉旧的「英文 slug + 精简」笔记。
//
//   演练（不碰真库，只打印计划）：bun run scripts/backfill-obsidian.js --vault <VAULT> --dry
//   实跑：                       bun run scripts/backfill-obsidian.js --vault <VAULT>
//
// vault 私有路径经参数/环境传入，绝不硬编码进本文件（入库、公开）。
// 实跑前先把 <VAULT>/Research 整体备份到 --backup 指定目录（默认脚本旁 .backup-研究）。

import { readdir, readFile, writeFile, mkdir, cp, rm, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { noteFromFolder, sanitizeFilename, extractReport } from "./report-to-obsidian.js";

const ARCHIVE = "research";

function getArg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const DRY = process.argv.includes("--dry");

// INDEX.md 的「对象」列是人工维护的中文名，做文件名的首选来源。
function parseIndex(indexMd) {
  const map = {};
  for (const line of indexMd.split("\n")) {
    const cols = line.split("|").map((c) => c.trim());
    if (cols.length < 7) continue;
    const object = cols[2];
    const folder = cols[6].replace(/[`/]/g, "").trim();
    if (!/^\d{4}-\d{2}-\d{2}_/.test(folder)) continue; // 跳过表头/分隔行
    map[folder] = object;
  }
  return map;
}

function dateOf(folder) {
  const m = folder.match(/^(\d{4}-\d{2}-\d{2})_/);
  return m ? m[1] : "";
}
function slugOf(folder) {
  return folder.replace(/^\d{4}-\d{2}-\d{2}_/, "");
}

async function fallbackName(folder) {
  // INDEX 里没有时，退回报告 <h1>，去掉「· 13 周展望」这类后缀。
  try {
    const html = await readFile(join(ARCHIVE, folder, "report.html"), "utf8");
    return extractReport(html).title.replace(/\s*·.*$/, "").trim() || slugOf(folder);
  } catch {
    return slugOf(folder);
  }
}

async function main() {
  const vault = getArg("--vault", process.env.OBSIDIAN_VAULT);
  if (!vault) {
    console.error("✗ 需要 --vault <OBSIDIAN_VAULT>（或设 env OBSIDIAN_VAULT）");
    process.exit(2);
  }
  const researchDir = join(vault, "Research");
  if (!DRY) {
    try {
      await access(vault);
    } catch {
      console.error(`✗ OBSIDIAN_VAULT 不存在：${vault}（停手，不猜测落点）`);
      process.exit(1);
    }
  }

  const index = parseIndex(await readFile(join(ARCHIVE, "INDEX.md"), "utf8"));
  const all = (await readdir(ARCHIVE, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);

  const usable = [];
  const skipped = [];
  for (const folder of all) {
    const hasReport = existsSync(join(ARCHIVE, folder, "report.html"));
    const hasNotes = existsSync(join(ARCHIVE, folder, "notes.md"));
    if (hasReport && hasNotes) usable.push(folder);
    else skipped.push({ folder, reason: `缺 ${!hasReport ? "report.html" : ""}${!hasReport && !hasNotes ? " 和 " : ""}${!hasNotes ? "notes.md" : ""}` });
  }

  // 计算文件名（冲突加日期后缀，两份都留、不丢信息）
  const plan = [];
  for (const folder of usable) {
    const raw = index[folder] || (await fallbackName(folder));
    plan.push({ folder, slug: slugOf(folder), date: dateOf(folder), base: sanitizeFilename(raw), fromIndex: !!index[folder] });
  }
  // 冲突消歧按「标的」而不是「文件名字符串」归并：同一只票两次调研，INDEX 里的中文名可能
  // 写法不同（带/不带港股代码、全角/半角括号），base 不相等就都不加日期后缀，产出两份看似
  // 无关、实则同标的的笔记；反过来 base 与日期都相同的两条会静默互相覆盖。
  const groupKey = (p) => {
    const codes = [...String(p.base).matchAll(/\d{6}/g)].map((m) => m[0]).sort().join(",");
    return codes || p.base;  // 有 6 位代码就按代码归并，没有就退回文件名
  };
  const groupCount = {};
  for (const p of plan) groupCount[groupKey(p)] = (groupCount[groupKey(p)] || 0) + 1;
  for (const p of plan) p.name = groupCount[groupKey(p)] > 1 ? `${p.base} · ${p.date}` : p.base;
  // 兜底：加了日期后仍重名（同标的同一天两个文件夹）→ 再追加 slug，绝不让两份计划互相覆盖
  const nameCount = {};
  for (const p of plan) nameCount[p.name] = (nameCount[p.name] || 0) + 1;
  for (const p of plan) if (nameCount[p.name] > 1) p.name = `${p.name} · ${p.slug}`;

  // 计划改名会留下孤儿：库里已有的笔记若是用旧命名规则（或由单篇 CLI 写成的无日期后缀名），
  // 改名后旧文件仍在，同一篇报告在库里出现两份、旧那份内容还是陈旧的。显式报出来让人先决定。
  const willOrphan = [];
  {
    const planned = new Set(plan.map((p) => `${p.name}.md`));
    const existingNow = existsSync(researchDir) ? (await readdir(researchDir)).filter((f) => f.endsWith(".md")) : [];
    for (const f of existingNow) {
      if (planned.has(f)) continue;
      const base = f.replace(/\.md$/, "");
      if (plan.some((p) => p.name.replace(/ · \d{4}-\d{2}-\d{2}$/, "") === base)) willOrphan.push(f);
    }
  }
  if (willOrphan.length) {
    console.log(`\n⚠️ 以下 ${willOrphan.length} 篇会因改名被甩成孤儿（库里将同时存在新旧两份，旧的内容陈旧）：`);
    for (const f of willOrphan) console.log(`  · ${f}`);
    console.log(`  → 若只是想刷新内容，请改用「按 archive 字段原地回写同名文件」的方式，不改名、不产生重复。`);
  }

  // 需要删除的旧英文名笔记 = 现有 Research/*.md 里 basename 恰好等于某个已知 slug 的
  const knownSlugs = new Set(plan.map((p) => p.slug));
  let existing = [];
  if (existsSync(researchDir)) existing = (await readdir(researchDir)).filter((f) => f.endsWith(".md"));
  const toDelete = existing.filter((f) => knownSlugs.has(f.replace(/\.md$/, "")));
  const orphans = existing.filter((f) => !knownSlugs.has(f.replace(/\.md$/, "")) && !plan.some((p) => `${p.name}.md` === f));

  // 打印计划
  console.log(`\n归档文件夹 ${all.length}，可回填 ${usable.length}，跳过 ${skipped.length}`);
  for (const p of plan) console.log(`  ${p.folder}  →  ${p.name}.md${p.fromIndex ? "" : "（名取自报告标题·非INDEX）"}`);
  if (skipped.length) {
    console.log(`\n跳过（不动）：`);
    for (const s of skipped) console.log(`  ${s.folder}：${s.reason}`);
  }
  console.log(`\n将删除旧英文名笔记 ${toDelete.length} 个：`);
  for (const f of toDelete) console.log(`  - ${f}`);
  console.log(`\n保留不动的其它 Research 笔记（非本流程产物）${orphans.length} 个：`);
  for (const f of orphans) console.log(`  · ${f}`);

  if (DRY) {
    console.log("\n[dry] 未写入、未删除、未备份。去掉 --dry 实跑。");
    return;
  }

  // 备份 → 写入 → 删除
  const backup = getArg("--backup", join(vault, `.backup-Research-${dateOf(plan[0]?.folder || "") || "run"}`));
  if (existsSync(researchDir)) {
    await cp(researchDir, backup, { recursive: true });
    console.log(`\n✓ 已备份 Research/ → ${backup}`);
  }
  await mkdir(researchDir, { recursive: true });

  let written = 0;
  for (const p of plan) {
    const md = await noteFromFolder(join(ARCHIVE, p.folder));
    await writeFile(join(researchDir, `${p.name}.md`), md, "utf8");
    written++;
  }
  console.log(`✓ 写入 ${written} 个中文全文笔记`);

  let deleted = 0;
  for (const f of toDelete) {
    // 防呆：仅删确实存在、且不是我们刚写出的中文名文件
    if (!plan.some((p) => `${p.name}.md` === f)) {
      await rm(join(researchDir, f));
      deleted++;
    }
  }
  console.log(`✓ 删除 ${deleted} 个旧英文名笔记`);
  console.log(`\n完成。备份在 ${backup}（确认无误后可自行删除）。`);
}

main();
