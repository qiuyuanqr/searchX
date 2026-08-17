// 标的元数据：目录 slug 与「五大常关注板块」归属。
//
// 为什么要一张手工表，而不是自动生成：
//   - **slug** 决定归档目录名，也就是公开站的固定网址（/r/2026-08-15_boe-000725/）。
//     一旦上线就不该再变——旧链接会直接 404（已分享出去的、书签、搜索引擎收录的全部失效），
//     所以也不能让它随某个音译库的版本漂移。同一只票此前已在 research/ 里有归档的，
//     沿用**同一个 slug**（如 300285 → guoci-materials-300285），让网址形态保持一致。
//     注意：多份报告的「系列」识别**不靠 slug**——web/build/series.js 取的是标题里的
//     6 位股票代码（seriesKey），所以 slug 不一致不影响「第 N 次 · X 天后」正确显示。
//     （2026-08-17 更正：这里原先写的「否则 series.js 认不出是一个系列」与实现不符。）
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
  // 下面两只的 slug **刻意保持 `stock-<代码>` 这个降级形态**：它们在补进本表之前就已经
  // 上线，slug 就是公开网址，改了旧链接会 404。名字丑一点是既成事实，不值得为好看而
  // 让已分享出去的链接失效。写进表里的意义在另外两点：不再被当成「表里没有的新票」
  // 反复提示，以及把 `boards: []` 从「还没填」变成**有意的结论**——
  // 两家都是医药（近岸蛋白做重组蛋白，泓博医药做 CRO），与五大关注板块确无强关联，
  // 与表里药明康德 / 药石科技 / 百普赛斯的处理一致。
  "688137": { slug: "stock-688137", boards: [] },
  "301230": { slug: "stock-301230", boards: [] },
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
