import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { parseNote } from "./parse-note.js";

const DIR_RE = /^\d{4}-\d{2}-\d{2}_/;

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
    .sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : a.dir < b.dir ? 1 : -1
    );
}
