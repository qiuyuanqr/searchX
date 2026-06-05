import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { parseNote } from "./parse-note.js";

const DIR_RE = /^\d{4}-\d{2}-\d{2}_/;

// 信息流排序：新生成的排最上面。
// 1) 日期（天）降序 → 2) 同一天按精确生成时间 created 降序 → 3) 退化目录名降序（确定性）
export function compareByNewest(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  let ta = a.created ? Date.parse(a.created) : 0;
  let tb = b.created ? Date.parse(b.created) : 0;
  // created 存在但格式损坏时 Date.parse 返回 NaN；不归零会让比较器返回 NaN（被当 0），
  // 既到不了"目录名降序"的确定性兜底，又破坏"新生成在最上"。坏 created 一律视同缺失。
  if (Number.isNaN(ta)) ta = 0;
  if (Number.isNaN(tb)) tb = 0;
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
