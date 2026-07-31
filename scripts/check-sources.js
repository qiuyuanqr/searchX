// scripts/check-sources.js
// 核对每个归档的 sources.md 与 report.html 是否对得上。
//
// 为什么需要它：三件套里 notes.md 有 parse-note 解析、report.html 有 validate-report 校验，
// 只有 sources.md 完全没有任何代码消费——格式漂移、漏记来源永远不会被发现。
// 2026-07-31 审查实测：47 个归档里「报告引用了但清单没记」111 条、「清单有但报告没引」115 条。
//
//   bun run scripts/check-sources.js            # 报告差异，退出码始终 0
//   bun run scripts/check-sources.js --strict    # 有「报告引了但清单缺」即非零退出（CI/收尾自查用）
//   bun run scripts/check-sources.js --dir <归档目录名>   # 只看一个
//
// 判定口径：清单必须**覆盖**报告正文里引用的全部外链（sources.md ⊇ report.html）。
// 反过来清单里多出来的条目不算错——查过但最终没引用的来源，留着是有价值的。

import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const ARCHIVE = "research";
const DIR_RE = /^\d{4}-\d{2}-\d{2}_/;

// 从任意文本里抽 http(s) 链接。结尾的中英文标点不算 URL 的一部分。
export function extractUrls(text) {
  const out = new Set();
  // 字符类里就得排除中日韩标点：中文正文里「…/y。另有」不加空格，只靠结尾修剪切不开，
  // 会把后面的中文一起吞进 URL（本文件的测试当场抓到过这个）。
  for (const m of String(text || "").matchAll(/https?:\/\/[^\s)<>"'\]，。、；：（）【】「」《》…]+/g)) {
    out.add(m[0].replace(/[.,;:]+$/, ""));
  }
  return out;
}

// 单个归档的核对结果：missing = 报告引了但清单没有（真问题）；extra = 清单有但报告没引（可接受）
export function checkArchive({ sourcesMd, reportHtml }) {
  const inSources = extractUrls(sourcesMd);
  const inReport = extractUrls(reportHtml);
  return {
    missing: [...inReport].filter((u) => !inSources.has(u)),
    extra: [...inSources].filter((u) => !inReport.has(u)),
    counts: { sources: inSources.size, report: inReport.size },
  };
}

function main() {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const only = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : null;

  const dirs = readdirSync(ARCHIVE)
    .filter((n) => DIR_RE.test(n) && existsSync(join(ARCHIVE, n, "report.html")))
    .filter((n) => !only || n === only)
    .sort();

  let totalMissing = 0, totalExtra = 0, noFile = 0;
  const rows = [];
  for (const dir of dirs) {
    const sp = join(ARCHIVE, dir, "sources.md");
    if (!existsSync(sp)) { noFile++; rows.push({ dir, note: "缺 sources.md" }); continue; }
    const r = checkArchive({
      sourcesMd: readFileSync(sp, "utf8"),
      reportHtml: readFileSync(join(ARCHIVE, dir, "report.html"), "utf8"),
    });
    totalMissing += r.missing.length;
    totalExtra += r.extra.length;
    if (r.missing.length || r.extra.length) rows.push({ dir, ...r });
  }

  console.log(`核对 ${dirs.length} 个归档；缺 sources.md ${noFile} 个`);
  console.log(`报告引用但清单缺失：${totalMissing} 条（这是要修的）`);
  console.log(`清单有但报告未引：${totalExtra} 条（查过没引用，可接受）\n`);
  for (const r of rows.filter((x) => x.missing && x.missing.length).sort((a, b) => b.missing.length - a.missing.length)) {
    console.log(`  ${r.dir}  缺 ${r.missing.length} 条`);
    for (const u of r.missing.slice(0, 3)) console.log(`      ${u}`);
    if (r.missing.length > 3) console.log(`      …还有 ${r.missing.length - 3} 条`);
  }

  if (strict && totalMissing > 0) {
    console.error(`\n✗ --strict：有 ${totalMissing} 条报告引用未记入 sources.md`);
    process.exit(1);
  }
}

if (import.meta.main) main();
