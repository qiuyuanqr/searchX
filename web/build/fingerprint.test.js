import { test, expect } from "bun:test";
import { addVersionToHtml, addVersionToImports } from "./fingerprint.js";

// --- addVersionToHtml：给 HTML 里 assets/*.js|css 引用加 ?v=<版本> ---

test("addVersionToHtml：script src 加版本号", () => {
  expect(addVersionToHtml('<script src="assets/check-page.js"></script>', "abc123"))
    .toBe('<script src="assets/check-page.js?v=abc123"></script>');
});

test("addVersionToHtml：link href（css）加版本号", () => {
  expect(addVersionToHtml('<link rel="stylesheet" href="assets/feed.css">', "abc123"))
    .toBe('<link rel="stylesheet" href="assets/feed.css?v=abc123">');
});

test("addVersionToHtml：非 js/css 资源（favicon.png）不动", () => {
  const s = '<link rel="icon" href="assets/favicon.png">';
  expect(addVersionToHtml(s, "abc123")).toBe(s);
});

test("addVersionToHtml：外部 URL / 非 assets 引用不动", () => {
  const s = '<a href="https://x.com/a.js">x</a>';
  expect(addVersionToHtml(s, "abc123")).toBe(s);
});

test("addVersionToHtml：已带 query 的不重复加（幂等）", () => {
  const s = '<script src="assets/check-page.js?v=old"></script>';
  expect(addVersionToHtml(s, "new")).toBe(s);
});

test("addVersionToHtml：一页多个引用全部加", () => {
  const s = '<link href="assets/feed.css"><script src="assets/feed.js"></script>';
  expect(addVersionToHtml(s, "v1"))
    .toBe('<link href="assets/feed.css?v=v1"><script src="assets/feed.js?v=v1"></script>');
});

// --- addVersionToImports：给 JS 相对 import 加 ?v=<版本> ---

test("addVersionToImports：单行 from './x.js' 加版本号", () => {
  expect(addVersionToImports('import { a } from "./check.js";', "abc"))
    .toBe('import { a } from "./check.js?v=abc";');
});

test("addVersionToImports：单引号 import 也加", () => {
  expect(addVersionToImports("import { a } from './check.js';", "abc"))
    .toBe("import { a } from './check.js?v=abc';");
});

test("addVersionToImports：多行 import 的 from 行加版本号", () => {
  const src = 'import {\n  readKey,\n} from "./check.js";';
  expect(addVersionToImports(src, "abc"))
    .toBe('import {\n  readKey,\n} from "./check.js?v=abc";');
});

test("addVersionToImports：一文件多个 import 全部加", () => {
  const src = 'import { a } from "./submit.js";\nimport { b } from "./dedup.js";';
  expect(addVersionToImports(src, "v1"))
    .toBe('import { a } from "./submit.js?v=v1";\nimport { b } from "./dedup.js?v=v1";');
});

test("addVersionToImports：已带 query 的不重复加（幂等）", () => {
  const s = 'import { a } from "./check.js?v=old";';
  expect(addVersionToImports(s, "new")).toBe(s);
});

test("addVersionToImports：非 import 的字符串（如 fetch 的 .json 路径）不动", () => {
  const s = 'const u = "./reports.json"; fetch(u);';
  expect(addVersionToImports(s, "v1")).toBe(s);
});
