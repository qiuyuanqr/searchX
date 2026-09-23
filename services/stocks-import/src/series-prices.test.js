import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  seriesTargets, startYmd, pricesSql, AS_OF_SQL, buildPrices, serialize, decideWrite, main, SOURCE,
} from "./series-prices.js";

const TMP = mkdtempSync(join(tmpdir(), "series-prices-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function makeRoot(files) {
  const root = mkdtempSync(join(TMP, "root-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}
const note = (title) => `---\ntype: 股票\n---\n\n# ${title}\n\n> 未来约 13 周方向震荡。\n`;
const HTML = "<html><body>x</body></html>";

const ROOT_FILES = {
  // 两篇 → 要行情
  "2026-06-08_verisilicon-688521/notes.md": note("芯原股份（688521.SH）"),
  "2026-06-08_verisilicon-688521/report.html": HTML,
  "2026-09-09_verisilicon-688521/notes.md": note("芯原股份（688521.SH）"),
  "2026-09-09_verisilicon-688521/report.html": HTML,
  // 两篇但其中一篇搁置 → 只剩一篇，不要（与构建同一口径）
  "2026-07-01_x-300001/notes.md": note("某股（300001.SZ）"),
  "2026-07-01_x-300001/report.html": HTML,
  "2026-08-01_x-300001/notes.md": note("某股（300001.SZ）"),
  "2026-08-01_x-300001/report.html": HTML,
  "2026-08-01_x-300001/.parked": "",
  // 单篇 → 不要
  "2026-08-01_y-600001/notes.md": note("另一股（600001.SH）"),
  "2026-08-01_y-600001/report.html": HTML,
  // 快照目录本身不该被当成报告
  "_series/prices.json": "{}",
};

test("seriesTargets：与构建同口径——两篇以上、跳过搁置件；值是最早一次调研日", () => {
  const t = seriesTargets(makeRoot(ROOT_FILES));
  expect([...t]).toEqual([["688521", "2026-06-08"]]);
});

test("startYmd：往前 14 个自然日；坏日期 → null", () => {
  expect(startYmd("2026-06-08")).toBe("20260525");
  expect(startYmd("2026-03-05")).toBe("20260219");
  expect(startYmd("坏")).toBeNull();
});

test("pricesSql：只查白名单表 daily_kline、6 位裸码；不合形的代码 / 日期不进 SQL", () => {
  const sql = pricesSql(new Map([["688521", "2026-06-08"], ["300476", "2026-06-08"], ["1; DROP", "2026-06-08"], ["600001", "坏"]]));
  expect(sql).toContain("FROM daily_kline");
  expect(sql).toContain("(ts_code='300476' AND trade_date>='20260525')");
  expect(sql).toContain("(ts_code='688521' AND trade_date>='20260525')");
  expect(sql).not.toContain("DROP");
  expect(sql).not.toContain("600001");
  expect(sql.indexOf("300476")).toBeLessThan(sql.indexOf("688521"));   // 代码排序，SQL 本身也稳定
  expect(pricesSql(new Map())).toBeNull();
  expect(AS_OF_SQL).toContain("MAX(trade_date)");
});

test("buildPrices：按代码排序、日期升序；形状不对的行丢掉，不补值", () => {
  const d = buildPrices({ asOf: 20260922, rows: [
    { c: "688521", d: "20260909", p: 191 }, { c: "688521", d: "20260908", p: 190.123456 },
    { c: "300476", d: "20260909", p: 300 }, { c: "688521", d: "坏", p: 1 }, { c: "688521", d: "20260910", p: null },
    { c: "688521", d: "20260911", p: 0 },
  ] });
  expect(d.asOf).toBe("20260922");
  expect(d.source).toBe(SOURCE);
  expect(Object.keys(d.codes)).toEqual(["300476", "688521"]);
  expect(d.codes["688521"]).toEqual([["20260908", 190.123], ["20260909", 191]]);
});

test("serialize：一只票一行、字节稳定；解析回来与原对象一致", () => {
  const d = buildPrices({ asOf: "20260922", rows: [{ c: "688521", d: "20260909", p: 191 }, { c: "300476", d: "20260909", p: 300 }] });
  const text = serialize(d);
  expect(text).toBe(serialize(buildPrices({ asOf: "20260922", rows: [{ c: "300476", d: "20260909", p: 300 }, { c: "688521", d: "20260909", p: 191 }] })));
  expect(text.split("\n").filter((l) => l.startsWith('"'))).toHaveLength(2);
  expect(JSON.parse(text)).toEqual(d);
});

test("decideWrite：没变化不写；首次写；数据截止日只许前进（过期副本 / 库回滚绝不覆盖）", () => {
  const next = buildPrices({ asOf: "20260922", rows: [{ c: "688521", d: "20260922", p: 208.03 }] });
  expect(decideWrite("", next)).toMatchObject({ write: true, reason: "首次生成" });
  expect(decideWrite(serialize(next), next)).toMatchObject({ write: false, reason: "没有变化" });
  const newer = serialize(buildPrices({ asOf: "20260923", rows: [] }));
  expect(decideWrite(newer, next).write).toBe(false);
  expect(decideWrite(newer, next).reason).toContain("不许倒退");
  expect(decideWrite("", buildPrices({ asOf: "", rows: [] })).write).toBe(false);
  expect(decideWrite("{坏的", next).write).toBe(true);     // 旧文件坏了就重写
});

test("main：注入替身查库——写文件并在 --porcelain 下打 changed；第二次无变化什么都不打", () => {
  const root = makeRoot(ROOT_FILES);
  const pricesPath = join(TMP, "out", "prices.json");
  const calls = [];
  const query = (db, sql) => {
    calls.push(sql);
    if (sql === AS_OF_SQL) return [{ asOf: "20260922" }];
    return [{ c: "688521", d: "20260909", p: 191 }, { c: "688521", d: "20260922", p: 208.03 }];
  };
  const logs = [];
  const orig = console.log;
  console.log = (...s) => logs.push(s.join(" "));
  const origErr = console.error;
  console.error = () => {};
  try {
    expect(main(["--porcelain"], { archiveRoot: root, pricesPath, db: "x", query })).toBe(0);
    expect(logs).toEqual(["changed"]);
    expect(JSON.parse(readFileSync(pricesPath, "utf8")).codes["688521"]).toHaveLength(2);
    logs.length = 0;
    expect(main(["--porcelain"], { archiveRoot: root, pricesPath, db: "x", query })).toBe(0);
    expect(logs).toEqual([]);
    // --dry-run 不落盘
    const dry = join(TMP, "out", "dry.json");
    main(["--porcelain", "--dry-run"], { archiveRoot: root, pricesPath: dry, db: "x", query });
    expect(existsSync(dry)).toBe(false);
  } finally {
    console.log = orig;
    console.error = origErr;
  }
  expect(calls.some((s) => s.includes("daily_kline") && s.includes("688521"))).toBe(true);
});

test("main：查库失败照常抛（由 scheduled-run.sh 记日志、限频报警），不写半截文件", () => {
  const pricesPath = join(TMP, "out", "boom.json");
  const query = () => { throw new Error("database is locked"); };
  const origErr = console.error;
  console.error = () => {};
  try {
    expect(() => main([], { archiveRoot: makeRoot(ROOT_FILES), pricesPath, db: "x", query })).toThrow("database is locked");
  } finally {
    console.error = origErr;
  }
  expect(existsSync(pricesPath)).toBe(false);
});
