import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { parseNote } from "./parse-note.js";

const DIR_RE = /^\d{4}-\d{2}-\d{2}_/;

// 悬空符号链接或不可读条目会让 statSync 抛错；与下面 frontmatter 损坏的处理对齐，
// 一条坏目录只警告跳过，绝不击穿整站构建。返回 null 表示 stat 本身失败（需要警告），
// 与"stat 成功但不是目录"（正常静默跳过）区分开。
function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return null;
  }
}

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
    .filter((name) => {
      if (!DIR_RE.test(name)) return false;
      const dir = isDir(join(root, name));
      if (dir === null) {
        console.warn(`⚠ 跳过 ${name}：无法读取目录（悬空链接或不可读条目）`);
        return false;
      }
      if (!dir) return false;
      return existsSync(join(root, name, "notes.md"));
    })
    .map((name) => {
      // frontmatter YAML 损坏（未闭合序列、错位引号等）时 gray-matter 直接抛错——警告 + 跳过
      // 该目录（与 build.js 对缺 report.html 半成品目录的处理对齐），一条坏 note 不击穿整站构建。
      try {
        return parseNote(readFileSync(join(root, name, "notes.md"), "utf8"), name);
      } catch (err) {
        console.warn(`⚠ 跳过 ${name}：notes.md frontmatter 解析失败（${err.message.split("\n")[0]}）`);
        return null;
      }
    })
    .filter(Boolean)
    .sort(compareByNewest);
}
