// services/check-runner/src/result-signals.js
// 从 /factcheck 写出的结果文件（result.md，与 Obsidian 笔记同内容）的 frontmatter 里取手机端要的
// 两个信号：summary（一行结论，列表那条下方的结论行）与 title（那条的标题）。
// 2026-09-17 起三个信号文件（verdict.txt / title.txt / result.md）合并为一个：skill 只写笔记，
// 标题与结论本来就该是笔记的一部分（frontmatter 字段），runner 解析即可——prompt 少两段指令、
// 少两个"漏写就降级"的口子。纯函数，无 IO。

// 只解 frontmatter 里的标量键值（`key: value`），去掉成对的引号；数组 / 多行值不需要。
export function parseFrontmatterScalars(md) {
  const s = String(md == null ? "" : md).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(s);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split("\n")) {
    const mm = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!mm) continue;
    let v = mm[2].trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    out[mm[1]] = v;
  }
  return out;
}

// 单行化：模型偶尔把一行结论写成两行，只取第一行、去首尾空白；空 / 非字符串 → ""。
function oneLine(v) {
  return String(v == null ? "" : v).split("\n")[0].trim();
}

// 返回 { summary, title }，取不到的字段为空串（调用方按空降级，与旧信号文件缺失时行为一致）。
export function signalsFromResult(md) {
  const fm = parseFrontmatterScalars(md);
  return { summary: oneLine(fm.summary), title: oneLine(fm.title) };
}
