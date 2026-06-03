// services/runner/src/research-output.js
// 跑研究前后对比 research/ 目录列表，识别本次新产出的主题文件夹。

// 假设 afterDirs 无重复（调用方用 fs.readdirSync 列平铺目录，天然不重复）。
export function diffNewDirs(beforeDirs, afterDirs) {
  const before = new Set(beforeDirs);
  return afterDirs.filter((d) => !before.has(d));
}
