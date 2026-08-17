import { expect, test, describe } from "bun:test";
import { isBusinessConcept, pickConcepts, suggestBoards, buildSectorSql, groupSectorRows } from "./sectors.js";
import { exchangeOf } from "./mapping.js";

describe("概念噪音过滤", () => {
  // 每条都取自 2026-08-17 对库里 899 个真概念的标定，不是想象出来的例子。
  test.each([
    "融资融券", "深股通", "沪股通",
    "中证500成份股", "沪深300样本股", "上证50样本股", "MSCI概念",
    "同花顺新质50", "同花顺中特估100", "中国AI 50",   // 「中国AI 50」带空格，曾漏网
    "中概股指数", "全球金融科技指数",
    "证金持股", "国家大基金持股", "巴菲特持股",
    "新股与次新股", "注册制次新股", "科创次新股",
    "回购增持再贷款概念", "股权转让(并购重组)", "举牌",
    "2026中报预增", "2025年报预增", "2026一季报预增",
    "人民币贬值受益", "人民币升值",
    "国企改革", "央企国企改革", "上海国企改革",
    "专精特新",
    "一带一路", "西部大开发", "粤港澳大湾区", "乡村振兴", "海峡两岸", "京津冀一体化", "雄安新区", "海南自贸区",
  ])("剔除与业务无关的标签：%s", (name) => {
    expect(isBusinessConcept(name)).toBe(false);
  });

  test.each([
    "共封装光学(CPO)", "光纤概念", "数据中心(AIDC)", "东数西算(算力)",
    "人形机器人", "减速器", "商业航天", "重组蛋白", "CRO概念", "创新药",
    "人工智能", "机器人概念", "芯片概念",   // 泛，但确实是业务方向——展示保留
    "华为概念", "英伟达概念",               // 关联方，弱信息但真实
    "液冷服务器", "算力租赁", "MLCC概念", "军工",
  ])("保留描述业务的标签：%s", (name) => {
    expect(isBusinessConcept(name)).toBe(true);
  });

  test("空值不当作业务概念", () => {
    expect(isBusinessConcept("")).toBe(false);
    expect(isBusinessConcept(null)).toBe(false);
    expect(isBusinessConcept(undefined)).toBe(false);
  });
});

describe("概念排序与截断", () => {
  test("按成分股数升序——越特异越靠前", () => {
    const rows = [
      { name: "人工智能", members: 1085 },
      { name: "光纤概念", members: 112 },
      { name: "数据中心(AIDC)", members: 653 },
    ];
    expect(pickConcepts(rows)).toEqual(["光纤概念", "数据中心(AIDC)", "人工智能"]);
  });

  test("过滤先于排序：噪音不占名额", () => {
    const rows = [
      { name: "融资融券", members: 3857 },
      { name: "沪深300样本股", members: 319 },
      { name: "光纤概念", members: 112 },
    ];
    expect(pickConcepts(rows)).toEqual(["光纤概念"]);
  });

  test("截断到 limit", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ name: `概念${i}`, members: i }));
    expect(pickConcepts(rows, 8)).toHaveLength(8);
    expect(pickConcepts(rows, 3)).toEqual(["概念0", "概念1", "概念2"]);
  });

  // 目的是**结果稳定**（不同输入顺序得到同一份展示），不是某个特定字序——
  // 中文的 localeCompare 未必按拼音，别把实现细节写进期望。
  test("成分股数相同时结果稳定：输入顺序不影响输出", () => {
    const a = [{ name: "AAA概念", members: 50 }, { name: "BBB概念", members: 50 }];
    const b = [{ name: "BBB概念", members: 50 }, { name: "AAA概念", members: 50 }];
    expect(pickConcepts(a)).toEqual(pickConcepts(b));
    expect(pickConcepts(a)).toEqual(["AAA概念", "BBB概念"]);
  });

  test("空输入不报错", () => {
    expect(pickConcepts([])).toEqual([]);
    expect(pickConcepts(null)).toEqual([]);
  });
});

describe("五大板块推荐", () => {
  test("强特征命中（天孚通信的真实标签）", () => {
    expect(suggestBoards(["光纤概念", "共封装光学(CPO)", "数据中心(AIDC)"])).toEqual(["光模块", "算力"]);
  });

  test("绿的谐波的真实标签命中机器人", () => {
    expect(suggestBoards(["减速器", "人形机器人"])).toEqual(["机器人"]);
  });

  // 这是本模块最重要的一条：泛概念不得触发板块。
  // 实测反例——润泽科技（IDC 公司）挂着「机器人概念」（1221 只票），
  // 早期版本拿它做判据，就把机器人板块挂到了一家数据中心公司头上。
  test("泛概念「机器人概念」不触发机器人板块", () => {
    expect(suggestBoards(["机器人概念", "算力租赁", "东数西算(算力)"])).toEqual(["算力", "AI应用"]);
  });

  // 泓博医药是 CRO 医药公司，同花顺给它挂了一堆 AI 标签。
  // 正确答案是不挂任何板块——这条测试守住「不硬凑」。
  test("医药公司的泛 AI 标签不触发 AI应用板块", () => {
    expect(suggestBoards(["CRO概念", "创新药", "ChatGPT概念", "多模态AI", "智能医疗", "合成生物"])).toEqual([]);
  });

  test("无命中返回空数组", () => {
    expect(suggestBoards(["重组蛋白", "流感"])).toEqual([]);
    expect(suggestBoards([])).toEqual([]);
  });

  test("按五大板块固定顺序返回，不随输入顺序变化", () => {
    const a = suggestBoards(["商业航天", "光纤概念", "减速器"]);
    const b = suggestBoards(["减速器", "商业航天", "光纤概念"]);
    expect(a).toEqual(b);
  });
});

describe("查库 SQL", () => {
  // ts_code 两格式陷阱：这两张表存带后缀，写成裸码会静默查空。
  test("6 位裸码拼上交易所后缀", () => {
    const sql = buildSectorSql(["688635", "300394"], exchangeOf);
    expect(sql).toContain("'688635.SH'");
    expect(sql).toContain("'300394.SZ'");
    expect(sql).not.toContain("'688635'");
  });

  test("只读且只碰白名单内的表", () => {
    const sql = buildSectorSql(["600519"], exchangeOf);
    expect(sql).toContain("PRAGMA query_only=1");
    expect(sql).not.toContain("query_only=0");
    for (const t of ["stock_industry", "industry_sw", "theme_stock", "theme"]) expect(sql).toContain(t);
    for (const t of ["paper_position", "watchlist_user", "user_thesis", "paper_account"]) expect(sql).not.toContain(t);
  });

  test("空列表返回空串（不生成 IN () 这种非法 SQL）", () => {
    expect(buildSectorSql([], exchangeOf)).toBe("");
    expect(buildSectorSql(null, exchangeOf)).toBe("");
  });
});

describe("查库结果归组", () => {
  test("行业与概念按代码归到一起", () => {
    const g = groupSectorRows([
      { kind: "industry", code: "300394", name: "通信设备" },
      { kind: "concept", code: "300394", name: "光纤概念", members: 112 },
      { kind: "concept", code: "300394", name: "融资融券", members: 3857 },
    ]);
    expect(g["300394"].industry).toBe("通信设备");
    expect(g["300394"].concepts).toHaveLength(2);
  });

  test("只有概念没有行业时 industry 为空串，不是 undefined", () => {
    const g = groupSectorRows([{ kind: "concept", code: "688635", name: "光纤概念", members: 112 }]);
    expect(g["688635"].industry).toBe("");
  });

  test("代码补齐到 6 位", () => {
    const g = groupSectorRows([{ kind: "industry", code: "725", name: "光学光电子" }]);
    expect(g["000725"]).toBeDefined();
  });

  test("空输入返回空对象", () => {
    expect(groupSectorRows([])).toEqual({});
    expect(groupSectorRows(null)).toEqual({});
  });
});
