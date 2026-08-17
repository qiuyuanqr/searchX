// 标的元数据：目录 slug 与「五大常关注板块」归属。
//
// 为什么要一张手工表，而不是自动生成：
//   - **slug** 决定归档目录名，也就是公开站的固定网址（/r/2026-08-15_boe-000725/）。
//     一旦上线就不该再变，所以不能让它随某个音译库的版本漂移；同一只票此前已在
//     research/ 里有归档的，必须沿用**同一个 slug**（如 300285 → guoci-materials-300285），
//     否则同一标的的多份报告在 web/build/series.js 里认不出是一个系列。
//   - **boards** 是 CLAUDE.md 的「仅在确有关联时挂，不硬凑」——这是判断，不是词频。
//     光靠正文里出现几次「机器人」来自动挂链，会把「顺带提了一句人形机器人」的票
//     也挂上去。表里留空数组就是「本票与五大板块无强关联」，是有意的结论。
//
// 表里没有的票（将来新跑出来的）会自动降级：slug 用 `stock-<代码>`、boards 留空，
// 并在导入时打一行提示，提醒补进这张表。降级不阻断上线——宁可 slug 丑一点，
// 也不能让一份真报告因为查表失败就发不出去。

export const STOCK_META = {
  "600519": { slug: "moutai-600519", boards: [] },
  "002050": { slug: "sanhua-zhikong-002050", boards: ["机器人", "算力"] },
  "688521": { slug: "verisilicon-688521", boards: ["算力", "AI应用"] },
  "300433": { slug: "lens-technology-300433", boards: ["AI应用", "机器人", "算力"] },
  "688322": { slug: "orbbec-688322", boards: ["机器人", "AI应用"] },
  "300442": { slug: "runze-tech-300442", boards: ["算力", "AI应用"] },
  "688041": { slug: "haiguang-xinxi-688041", boards: ["算力"] },
  "688017": { slug: "leaderdrive-688017", boards: ["机器人"] },
  "002340": { slug: "gem-002340", boards: [] },
  "300395": { slug: "feilihua-300395", boards: ["算力", "光模块", "航天"] },
  "603009": { slug: "beite-technology-603009", boards: ["机器人"] },
  "002031": { slug: "greatoo-002031", boards: ["机器人"] },
  "300394": { slug: "tfc-optical-300394", boards: ["光模块", "算力"] },
  "600547": { slug: "shandong-gold-600547", boards: [] },
  "301396": { slug: "hongjing-tech-301396", boards: ["算力", "AI应用"] },
  "301080": { slug: "acrobiosystems-301080", boards: [] },
  "300916": { slug: "lont-electronic-300916", boards: ["算力"] },
  "688072": { slug: "piotech-688072", boards: ["算力"] },
  "300408": { slug: "sanhuan-300408", boards: ["光模块", "算力"] },
  "300725": { slug: "pharmablock-300725", boards: [] },
  "300285": { slug: "guoci-materials-300285", boards: ["AI应用", "算力", "航天", "机器人"] },
  "300476": { slug: "shenghong-tech-300476", boards: ["算力", "AI应用"] },
  "000725": { slug: "boe-000725", boards: [] },
  "301599": { slug: "liqi-intelligent-301599", boards: [] },
  "603259": { slug: "wuxi-apptec-603259", boards: [] },
  "688635": { slug: "changjin-photonics-688635", boards: ["光模块", "算力"] },
};

// A 股代码 → 交易所后缀。沪市：600/601/603/605/688/689；深市：000/001/002/003/300/301。
export function exchangeOf(code) {
  return /^(?:60|68|9)/.test(String(code)) ? "SH" : "SZ";
}

export function metaOf(code) {
  const key = String(code).padStart(6, "0");
  const hit = STOCK_META[key];
  return {
    slug: hit ? hit.slug : `stock-${key}`,
    boards: hit ? hit.boards : [],
    known: Boolean(hit),
  };
}
