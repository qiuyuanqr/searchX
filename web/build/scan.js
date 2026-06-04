import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { parseNote } from "./parse-note.js";

const DIR_RE = /^\d{4}-\d{2}-\d{2}_/;

// 信息流排序：新生成的排最上面。
// 1) 日期（天）降序 → 2) 同一天按精确生成时间 created 降序 → 3) 退化目录名降序（确定性）
export function compareByNewest(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  const ta = a.created ? Date.parse(a.created) : 0;
  const tb = b.created ? Date.parse(b.created) : 0;
  if (ta !== tb) return tb - ta;
  return a.dir < b.dir ? 1 : -1;
}

export function scanResearch(root) {
  return readdirSync(root)
    .filter(
      (name) =>
        DIR_RE.test(name) &&
        statSync(join(root, name)).isDirectory() &&
        existsSync(join(root, name, "notes.md"))
    )
    .map((name) =>
      parseNote(readFileSync(join(root, name, "notes.md"), "utf8"), name)
    )
    .sort(compareByNewest);
}
