// 手机 Obsidian 深链与宿主落盘共享唯一文件名；纯函数，不读取真实库。
import { signalsFromResult } from "./result-signals.js";

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function factcheckFilename(title, taskId) {
  if (!SAFE_ID.test(String(taskId || ""))) throw new Error("任务 id 形态非法");
  const clean = String(title || "").normalize("NFC").replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").replace(/^\.+|[. ]+$/g, "").trim();
  const label = Array.from(clean || "私密事实核查").slice(0, 48).join("");
  return `${label}--${taskId}.md`;
}

export function canonicalFactcheckNote(note, taskId) {
  if (typeof note !== "string") throw new Error("核查笔记必须为文本");
  const opening = /^\uFEFF?---(\r?\n)/.exec(note);
  if (!opening) throw new Error("核查笔记缺少 frontmatter");
  const remainder = note.slice(opening[0].length);
  const closing = /^---(?:\r?\n|$)/m.exec(remainder);
  if (!closing) throw new Error("核查笔记 frontmatter 未闭合");
  const frontmatter = remainder.slice(0, closing.index);
  const lines = frontmatter.split(/(?<=\n)/);
  const indexes = [];
  for (let index = 0; index < lines.length; index++) {
    if (/^[ \t]*(?:note|"note"|'note')[ \t]*:/.test(lines[index])) indexes.push(index);
  }
  if (indexes.length > 1) throw new Error("核查笔记有重复 note 字段");
  const filename = factcheckFilename(signalsFromResult(note).title, taskId);
  const canonical = `note: ${JSON.stringify(`Factcheck/${filename}`)}`;
  if (indexes.length) {
    const index = indexes[0];
    const line = lines[index].replace(/\r?\n$/, "");
    const value = line.slice(line.indexOf(":") + 1).trim();
    // 只接受单行标量。块标量、空值后续缩进及跨行引号不能安全定点替换。
    if (!value || /^[>|&*\[{]/.test(value)
      || (value.startsWith('"') && !/^"(?:[^"\\]|\\.)*"(?:\s+#.*)?$/.test(value))
      || (value.startsWith("'") && !/^'(?:[^']|'')*'(?:\s+#.*)?$/.test(value))) {
      throw new Error("核查笔记 note 字段存在多行或复杂标量歧义");
    }
    let next = index + 1;
    while (next < lines.length && /^[ \t]*(?:#.*)?(?:\r?\n)?$/.test(lines[next])) next++;
    if (next < lines.length && /^[ \t]+\S/.test(lines[next])) {
      throw new Error("核查笔记 note 字段存在多行歧义");
    }
    const newline = /\r?\n$/.exec(lines[index])?.[0] || opening[1];
    lines[index] = canonical + newline;
  } else {
    // 缺字段时由宿主补入；保留已有 frontmatter 和正文的字节形式。
    lines.push(canonical + opening[1]);
  }
  return opening[0] + lines.join("") + remainder.slice(closing.index);
}
