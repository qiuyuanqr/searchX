// 五大常关注板块（双链/筛选的唯一权威清单）。related 里可能混入非板块双链，
// 显示与筛选都只取与这 5 个的交集，避免脏标签外露。
export const BOARDS = ["光模块", "机器人", "算力", "AI应用", "航天"];
const SET = new Set(BOARDS);

// 从一条 entry 的 boards（= related 解析值）里筛出真正属于 5 大板块的项，保持原顺序。
export function boardsOf(boards) {
  return (boards || []).filter((b) => SET.has(b));
}
