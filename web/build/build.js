import {
  rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, existsSync,
} from "fs";
import { join } from "path";
import { scanResearch } from "./scan.js";
import { renderIndex } from "./render-index.js";

export function build({
  root = "research",
  out = "web/dist",
  assets = "web/src/assets",
  template = "web/src/index.template.html",
} = {}) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const entries = scanResearch(root);

  for (const e of entries) {
    const destDir = join(out, "r", e.dir);
    mkdirSync(destDir, { recursive: true });
    cpSync(join(root, e.dir, "report.html"), join(destDir, "index.html"));
    const dataDir = join(root, e.dir, "data");
    if (existsSync(dataDir)) cpSync(dataDir, join(destDir, "data"), { recursive: true });
  }

  const tpl = readFileSync(template, "utf8");
  writeFileSync(join(out, "index.html"), renderIndex(entries, tpl));
  cpSync(assets, join(out, "assets"), { recursive: true });

  return entries;
}
