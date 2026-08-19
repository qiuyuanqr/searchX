import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import {
  splitTime, buildTldr, applyPriceFixes, insertIndexRow, hasIndexRow, importedIds, buildSources,
  sqliteJsonLines,
} from "./index.js";
import { metaOf, exchangeOf } from "./mapping.js";
import { extractDirection } from "../../../web/build/extract-direction.js";
import { parseNote } from "../../../web/build/parse-note.js";

test("generated_at 是朴素北京时间，created 要补回 +0800", () => {
  expect(splitTime("2026-08-15T14:34:26")).toEqual({
    date: "2026-08-15", created: "2026-08-15T14:34:26+0800",
  });
});

test("导语第一句用顿号分开方向与置信度——括号写法会把徽章渲染成「震荡·置信度中」", () => {
  const tldr = buildTldr({
    direction: "震荡", confidence: "中", oneLiner: "中报的漂亮是后视镜",
    drivers: ["驱动一"], risks: ["风险一"],
  });
  expect(tldr.startsWith("未来约 13 周方向震荡、置信度中：")).toBe(true);
  // 真实抽取器给出的徽章必须是干净的方向词
  expect(extractDirection(tldr).label).toBe("震荡");
});

test("导语把驱动与风险都带上（只写一句方向上了首页就是空话）", () => {
  const tldr = buildTldr({
    direction: "偏跌", confidence: "中", oneLiner: "估值透支",
    drivers: ["PB 90% 分位", "主力净流出"], risks: ["中报不达预期"],
  });
  expect(tldr).toContain("支撑在于PB 90% 分位；主力净流出。");
  expect(tldr).toContain("主要风险是中报不达预期。");
});

test("价位红线改写：逐条按 id 生效，并报告改了哪几处", () => {
  const { value, applied } = applyPriceFixes({ a: ["跌破93.86元且成交额腰斩"] }, 5);
  expect(value.a[0]).toBe("跌破基准日收盘价且成交额腰斩");
  expect(applied).toEqual(["跌破93.86元"]);
});

test("价位红线改写：不匹配的报告原样返回，绝不误改别人的字", () => {
  const obj = { a: "跌破93.86元" };
  expect(applyPriceFixes(obj, 99).value).toBe(obj);
});

test("INDEX 新行按日期倒序插进表里，同日排在已有同日行之前", () => {
  const idx = [
    "| 日期 | 对象 |", "|---|---|",
    "| 2026-08-16 | 甲 |", "| 2026-08-14 | 乙 |", "| 2026-08-01 | 丙 |",
  ].join("\n");
  const out = insertIndexRow(idx, "| 2026-08-14 | 新 |", "2026-08-14").split("\n");
  expect(out[3]).toContain("新");
  expect(out[4]).toContain("乙");
});

test("已有该归档目录的行就不再插一行（重导时会出两张一模一样的卡片）", () => {
  // 2026-08-16 端到端演练撞到并已被自动推送过一次：删掉目录让它重导，
  // 目录逐字节重建、git 看不出差异，但 INDEX 多了一行。
  const idx = "| 日期 |\n|---|\n| 2026-08-11 | `2026-08-11_piotech-688072` |";
  expect(hasIndexRow(idx, "2026-08-11_piotech-688072")).toBe(true);
  expect(hasIndexRow(idx, "2026-08-11_other-000001")).toBe(false);
});

test("INDEX 找不到表格分隔行就抛错（宁可失败，也不把行追到文件末尾）", () => {
  expect(() => insertIndexRow("没有表格", "| x |", "2026-08-14")).toThrow();
});

test("幂等：靠归档目录里的 stocks_report_id 认已导过的，不另存状态文件", () => {
  const root = mkdtempSync(join(tmpdir(), "stocks-import-"));
  mkdirSync(join(root, "2026-08-15_x"), { recursive: true });
  writeFileSync(join(root, "2026-08-15_x", "notes.md"), "---\nstocks_report_id: 42\n---\n# x\n");
  mkdirSync(join(root, "2026-08-15_y"), { recursive: true });
  writeFileSync(join(root, "2026-08-15_y", "notes.md"), "---\ndate: 2026-08-15\n---\n# y\n");
  expect([...importedIds(root)]).toEqual([42]);
});

test("交易所后缀：60/68 开头沪市，其余深市", () => {
  expect(exchangeOf("600519")).toBe("SH");
  expect(exchangeOf("688521")).toBe("SH");
  expect(exchangeOf("300476")).toBe("SZ");
  expect(exchangeOf("000725")).toBe("SZ");
});

test("元数据表没收录的代码降级成 stock-<代码> 且板块留空，但不阻断导入", () => {
  expect(metaOf("999999")).toEqual({ slug: "stock-999999", boards: [], known: false });
  expect(metaOf("300285").known).toBe(true);
});

test("来源清单：无链接的文字出处也要成条（否则那几篇的清单是空的）", () => {
  const md = buildSources({
    meta: { title: "某公司（000001.SZ）", date: "2026-08-16" },
    links: [], textSources: ["新浪财经 2026-07-05"],
  });
  expect(md).toContain("新浪财经 2026-07-05");
  expect(md).not.toContain("未引用外部来源");
});

test("来源清单：一条都没有时明说，不留空块", () => {
  const md = buildSources({
    meta: { title: "某公司（000001.SZ）", date: "2026-08-16" }, links: [], textSources: [],
  });
  expect(md).toContain("未引用外部来源");
});

test("产出的 notes.md 能被首页真实抽取器读出标题与导语", () => {
  // 口径分家=这里绿、线上空白，所以直接调 parse-note 本体
  const notes = [
    "---", "date: 2026-08-15", "created: 2026-08-15T14:34:26+0800", "type: 股票",
    'tags: ["research"]', "related: []", "source_count: 23",
    'archive: "research/2026-08-15_boe-000725/"', "source_system: stocks",
    "stocks_report_id: 25", "---", "",
    "# 京东方A（000725.SZ）", "", "## 一句话结论", "",
    buildTldr({ direction: "震荡", confidence: "中", oneLiner: "中报的漂亮是后视镜",
      drivers: ["PB 1.58 倍全组最低"], risks: ["Q3 面板跌价"] }),
  ].join("\n");
  const note = parseNote(notes, "2026-08-15_boe-000725");
  expect(note.title).toBe("京东方A（000725.SZ）");
  expect(note.type).toBe("股票");
  expect(note.tldr).toContain("PB 1.58 倍全组最低");
  expect(note.tldr.length).toBeGreaterThan(40);
});

// —— 撞上 Stocks 写事务不该直接失败 ——
// 2026-08-19 18:35:14 的真实故障：Stocks 的 compute-factors（每交易日 18:35 起、写 3.3 万行、
// 耗时 15 秒）正在写库，我们的 tick 恰好落进那 15 秒，sqlite3 CLI 的 busy_timeout 默认是 0，
// 于是「in prepare, database is locked (5)」→ 退出码 1 → 报警邮件。Stocks 自己那边早有对策
// （database.py get_conn 设了 30 秒 timeout），只有 searchX 这条直查通道没设。
test("查库撞上别人的写事务时要等锁，不能立刻失败", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sx-lock-"));
  const db = join(dir, "t.db");
  execFileSync("sqlite3", [db,
    "PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER, v TEXT); INSERT INTO t VALUES(1,'a');"]);

  // 起一个把库整个锁死的写进程，模拟 Stocks 侧的写事务窗口
  const holder = Bun.spawn(["sqlite3", db], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  holder.stdin.write("PRAGMA locking_mode=EXCLUSIVE;\nBEGIN IMMEDIATE;\nINSERT INTO t VALUES(2,'b');\n");
  holder.stdin.flush();
  await Bun.sleep(400);

  // 1.2 秒后放锁——等得起的查询应当拿到数据，等不起的当场就炸
  const releaseAt = setTimeout(() => {
    holder.stdin.write("COMMIT;\n.quit\n");
    holder.stdin.flush();
  }, 1200);

  const t0 = performance.now();
  const rows = sqliteJsonLines(db, "SELECT json_object('id', id, 'v', v) FROM t WHERE id=1;");
  const waited = performance.now() - t0;
  clearTimeout(releaseAt);
  holder.kill();

  expect(rows).toEqual([{ id: 1, v: "a" }]);
  // 确认真撞上了锁并等到了释放，而不是压根没撞上、测试白跑
  expect(waited).toBeGreaterThan(700);
});

test("等满 busy_timeout 仍拿不到锁时照常失败——不能把真故障吞掉", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sx-lock2-"));
  const db = join(dir, "t.db");
  execFileSync("sqlite3", [db, "PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER);"]);

  const holder = Bun.spawn(["sqlite3", db], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  holder.stdin.write("PRAGMA locking_mode=EXCLUSIVE;\nBEGIN IMMEDIATE;\nINSERT INTO t VALUES(1);\n");
  holder.stdin.flush();
  await Bun.sleep(400);

  expect(() => sqliteJsonLines(db, "SELECT json_object('id', id) FROM t;",
    { busyTimeoutMs: 200, retries: 1, retryDelayMs: 100 })).toThrow();
  holder.kill();
});
