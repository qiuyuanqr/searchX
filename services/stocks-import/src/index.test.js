import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import {
  splitTime, buildTldr, applyPriceFixes, insertIndexRow, hasIndexRow, importedIds, buildSources,
  sqliteJsonLines, DB_BUSY_TIMEOUT_MS,
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
// 于是「in prepare, database is locked (5)」→ 退出码 1 → 报警邮件。
//
// **为什么这里不真造锁冲突**：前两版都真造锁，都栽了。第一版用 setTimeout 放锁——而被测函数
// 是同步阻塞的（execFileSync），阻塞期间定时器根本不跑，本机侥幸绿、CI 上等满超时；第二版改
// 由 holder 进程自己 sleep 放锁，单跑没问题，全量并发一跑又因机器负载拿不到锁。真并发锁测试
// 依赖进程调度，做不到确定性，放进 CI 只会变成假故障源（它已经挂掉过 4 次部署）。
// CI 里该守的是确定性的那部分——参数有没有传对、撞锁之后怎么处理；真实锁行为在诊断时已对真库
// 验证过（无 busy_timeout 立刻报 locked，有则等 1285ms 后成功），并留了下面 SX_SLOW_TESTS 版。
function withStubSqlite(fn, { failTimes = 0, stdout = "", errMsg = "Error: in prepare, database is locked (5)" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sx-stub-"));
  writeFileSync(join(dir, "fail_times"), String(failTimes));
  writeFileSync(join(dir, "stdout"), stdout);
  writeFileSync(join(dir, "err_msg"), errMsg);
  // 替身把每次收到的 SQL 原样存下来，好断言我们究竟传了什么过去
  writeFileSync(join(dir, "sqlite3"), [
    "#!/bin/sh",
    'd=$(dirname "$0")',
    'n=$(cat "$d/count" 2>/dev/null || echo 0); n=$((n+1)); printf %s "$n" > "$d/count"',
    'printf %s "$2" > "$d/script.$n"',
    'if [ "$n" -le "$(cat "$d/fail_times")" ]; then cat "$d/err_msg" >&2; exit 5; fi',
    'cat "$d/stdout"',
    "",
  ].join("\n"), { mode: 0o755 });

  // 用 bin 选项直接注入，不动 PATH——Bun 的 execFileSync 不认运行时改的 PATH，
  // 改了也还是会去调真的 sqlite3（第一版就这么白跑了一轮）。
  return fn(dir, join(dir, "sqlite3"));
}

test("查库一定要带 busy_timeout，且排在 query_only 前面", () => {
  withStubSqlite((dir, bin) => {
    const rows = sqliteJsonLines("/nonexistent.db", "SELECT 1;", { bin });
    const script = readFileSync(join(dir, "script.1"), "utf8");
    // 漏掉这一句就是 2026-08-19 那封报警：CLI 的 busy_timeout 默认 0，撞上写事务当场就死
    expect(script.startsWith(`PRAGMA busy_timeout=${DB_BUSY_TIMEOUT_MS};`)).toBe(true);
    // 顺序反了等于没设：query_only 之后再设也来不及挡住 prepare 阶段的 BUSY
    expect(script.indexOf("busy_timeout")).toBeLessThan(script.indexOf("query_only"));
    expect(script).toContain("PRAGMA query_only=1;");   // 只读保护不能被顺带弄丢
    expect(rows).toEqual([{ id: 1 }]);
  }, { stdout: '{"id":1}\n' });
});

test("撞上写事务：等锁之外还要重试一次，重试成功就当无事发生", () => {
  withStubSqlite((dir, bin) => {
    const rows = sqliteJsonLines("/nonexistent.db", "SELECT 1;", { bin, retryDelayMs: 10 });
    expect(rows).toEqual([{ id: 1 }]);
    expect(readFileSync(join(dir, "count"), "utf8")).toBe("2");   // 确认真重试了，不是第一次就成功
  }, { failTimes: 1, stdout: '{"id":1}\n' });
});

test("一直拿不到锁：照常抛出——这层只消误报，不许把真故障吞掉", () => {
  withStubSqlite((_dir, bin) => {
    expect(() => sqliteJsonLines("/nonexistent.db", "SELECT 1;", { bin, retryDelayMs: 10 })).toThrow();
  }, { failTimes: 99 });
});

test("不是锁的毛病就别重试——真故障要立刻报，不该被拖慢", () => {
  withStubSqlite((dir, bin) => {
    expect(() => sqliteJsonLines("/nonexistent.db", "SELECT 1;", { bin, retryDelayMs: 10 })).toThrow();
    expect(readFileSync(join(dir, "count"), "utf8")).toBe("1");   // 只试了一次
  }, { failTimes: 99, errMsg: "Error: no such table: research_report" });
});

// 真造锁冲突的版本：确定性靠不住（见上），只在显式开启时跑，用来手工核对
// busy_timeout 在真 SQLite 上确实管用。跑法：SX_SLOW_TESTS=1 bun test services/stocks-import
test.if(process.env.SX_SLOW_TESTS === "1")("[慢] 真造锁冲突：等到锁释放后拿到数据", () => {
  const dir = mkdtempSync(join(tmpdir(), "sx-lock-"));
  const db = join(dir, "t.db");
  execFileSync("sqlite3", [db,
    "PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER, v TEXT); INSERT INTO t VALUES(1,'a');"]);
  // locking_mode=EXCLUSIVE 才挡得住读者：WAL 下普通写事务不阻塞读，复现不出线上那条错。
  // 放锁由 holder 自己的 sleep 驱动——本进程在 execFileSync 里是阻塞的，指望不上定时器。
  const hold = "PRAGMA locking_mode=EXCLUSIVE;\nBEGIN IMMEDIATE;\nINSERT INTO t(id) VALUES(99);\n";
  const holder = Bun.spawn(["sh", "-c",
    `{ printf '%s' "$1"; sleep 2; printf 'COMMIT;\n'; } | sqlite3 "$0"`, db, hold],
    { stdout: "ignore", stderr: "ignore" });
  try {
    const rows = sqliteJsonLines(db, "SELECT json_object('id', id, 'v', v) FROM t WHERE id=1;");
    expect(rows).toEqual([{ id: 1, v: "a" }]);
  } finally { holder.kill(); }
}, 60_000);

// 2026-08-26：定价位口径时加的「丢弃」标记。搁置的报告若判定不值得上线（时效已过），
// 目录里只留一个 .dropped（内容=reportId），正文删掉。没有这层，删目录等于「未导入」，
// 下个 tick 会原样再导一遍——搁置→删除→重导→再搁置，永远转圈。
test("importedIds 认 .dropped 标记：丢弃过的报告不会被重新导入", () => {
  const root = mkdtempSync(join(tmpdir(), "stocks-import-dropped-"));
  mkdirSync(join(root, "2026-08-24_stock-000001"), { recursive: true });
  writeFileSync(join(root, "2026-08-24_stock-000001", ".dropped"), "77\n");
  mkdirSync(join(root, "2026-08-25_stock-000002"), { recursive: true });
  writeFileSync(join(root, "2026-08-25_stock-000002", "notes.md"), "---\nstocks_report_id: 42\n---\n");
  expect([...importedIds(root)].sort((a, b) => a - b)).toEqual([42, 77]);
});
