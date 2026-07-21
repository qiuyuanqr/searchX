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
  const baseCount = {};
  for (const p of plan) baseCount[p.base] = (baseCount[p.base] || 0) + 1;
  for (const p of plan) p.name = baseCount[p.base] > 1 ? `${p.base} · ${p.date}` : p.base;

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
