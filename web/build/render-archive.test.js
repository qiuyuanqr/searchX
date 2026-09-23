import { test, expect } from "bun:test";
import { closeOnOrBefore, archiveRows, chartSvg, renderArchivePage } from "./render-archive.js";

// 芯原 688521 的真实形态（2026-09-23 取自 Stocks 库），裁成几个点
const PTS = [
  ["20260605", 225.2], ["20260608", 213.0], ["20260729", 192.02], ["20260730", 170.21],
  ["20260811", 211.51], ["20260820", 178.37], ["20260909", 191.0], ["20260922", 208.03],
];
const T = "芯原股份（688521.SH）";
const E = (date, tldr) => ({ title: T, type: "股票", date, href: `r/${date}_verisilicon-688521/`, tldr });
const ENTRIES = [
  E("2026-09-09", "未来约 13 周方向震荡、置信度中：订单兑现速度和利润何时转正之间没有共识。支撑在于……"),
  E("2026-06-08", "未来 ~13 周方向判断：震荡偏中性，上下空间均不对称地大。"),
  E("2026-07-30", "未来约 13 周方向震荡、置信度中：订单爆发是真的，利润和估值还没接上。"),
];
const PRICES = { asOf: "20260922", source: "x", codes: { "688521": PTS } };

test("closeOnOrBefore：当天有就取当天；非交易日取前一个交易日；早于行情起点 → null（不拿之后的价冒充）", () => {
  expect(closeOnOrBefore(PTS, "2026-08-11")).toEqual({ date: "20260811", close: 211.51 });
  expect(closeOnOrBefore(PTS, "2026-06-07")).toEqual({ date: "20260605", close: 225.2 });   // 周日 → 周五
  expect(closeOnOrBefore(PTS, "2026-06-01")).toBeNull();
  expect(closeOnOrBefore(PTS, "坏日期")).toBeNull();
  expect(closeOnOrBefore(null, "2026-08-11")).toBeNull();
});

test("archiveRows：旧→新编号；涨跌 = 本次调研日收盘 → 下一次调研日收盘，最新一篇算到数据截止日", () => {
  const rows = archiveRows(ENTRIES, PTS);
  expect(rows.map((r) => r.n)).toEqual([1, 2, 3]);
  expect(rows.map((r) => r.date)).toEqual(["2026-06-08", "2026-07-30", "2026-09-09"]);
  expect(rows[0].change).toBeCloseTo(170.21 / 213.0 - 1, 10);
  expect(rows[1].change).toBeCloseTo(191.0 / 170.21 - 1, 10);
  expect(rows[2].change).toBeCloseTo(208.03 / 191.0 - 1, 10);
  expect(rows[2].toLatest).toBe(true);
  expect(rows[0].dir.label).toBe("震荡偏中性");
  expect(rows[2].conf).toBe("中");
  expect(rows[0].conf).toBeNull();                         // 没写置信度就是没有，不补
  expect(rows[2].lead).toBe("订单兑现速度和利润何时转正之间没有共识。");   // 剥掉方向套话、只留第一句
});

test("archiveRows：两端取到同一个交易日（最新一篇晚于数据截止日）→ 不显示 0%，记 null", () => {
  const rows = archiveRows([E("2026-09-20", "方向震荡"), E("2026-09-27", "方向震荡")], PTS);
  expect(rows[0].change).toBeCloseTo(208.03 / 191.0 - 1, 10);  // 09-20 之前最近的点是 09-09（夹具里中间没有数据）
  expect(rows[1].close.date).toBe("20260922");
  expect(rows[1].change).toBeNull();
  // 页面上不能只剩一个横杠：说清楚是「还没有后续行情」（三环 300408 09-22 那篇就是这样）
  const html = renderArchivePage({ code: "688521", entries: [E("2026-09-20", "方向震荡"), E("2026-09-27", "方向震荡")], prices: PRICES });
  expect(html).toContain('—<span class="arch-cd">尚无后续行情</span>');
});

test("archiveRows：没有行情 → close / change 全为 null，不炸", () => {
  const rows = archiveRows(ENTRIES, []);
  expect(rows.every((r) => r.close === null && r.change === null)).toBe(true);
});

test("chartSvg：每次调研一个带序号的点、最新一次用 latest 类；点少于 2 个不画", () => {
  const svg = chartSvg(PTS, archiveRows(ENTRIES, PTS));
  expect(svg.startsWith("<svg")).toBe(true);
  expect((svg.match(/class="arch-mk /g) || []).length).toBe(3);
  expect(svg).toContain('class="arch-mk latest"');
  expect(svg).toContain(">3</text>");
  expect(svg).toContain("2026-06-05");                     // 横轴起点
  expect(svg).toContain("2026-09-22");                     // 横轴终点 = 数据截止日
  expect(svg).not.toMatch(/NaN|undefined|Infinity/);
  expect(chartSvg([["20260605", 1]], [])).toBe("");
});

test("chartSvg：价格全都一样也不除零", () => {
  const flat = [["20260601", 10], ["20260602", 10], ["20260603", 10]];
  expect(chartSvg(flat, archiveRows([E("2026-06-02", "方向震荡"), E("2026-06-03", "方向震荡")], flat))).not.toMatch(/NaN|Infinity/);
});

test("renderArchivePage：有行情 → 走势图 + 判断表 + 时间线，链接都指回 ../../r/<目录>/", () => {
  const html = renderArchivePage({ code: "688521", entries: ENTRIES, prices: PRICES });
  expect(html).toContain("<title>芯原股份 688521.SH · 判断档案 · SearchX</title>");
  expect(html).toContain("判断档案 · 3 次调研 · 2026-06-08 至 2026-09-09");
  expect(html).toContain('<svg class="arch-chart"');
  expect(html).toContain("<th>调研日收盘</th>");
  expect(html).toContain('href="../../r/2026-09-09_verisilicon-688521/"');
  expect(html).toContain("−20.1%");                        // 06-08 → 07-30：213.00 → 170.21
  expect(html).toContain("+12.2%");                        // 07-30 → 09-09：170.21 → 191.00
  expect(html).toContain("+8.9%");                         // 09-09 → 截止日
  expect(html).toContain("至今");
  expect(html).toContain("数据截至 2026-09-22");
  expect(html).toContain("较上次：方向由「震荡偏中性」转为「震荡」");
  expect(html).toContain("script-src 'none'");            // 档案页零脚本
  expect(html).toContain('<body data-pagefind-ignore>');  // 不进全文索引，搜索结果只出报告本身
  expect(html).toContain('href="../../assets/feed.css"');
});

test("renderArchivePage：没有行情 → 不画图、表里不出价格列，页脚如实说明", () => {
  for (const prices of [null, { asOf: "20260922", codes: {} }]) {
    const html = renderArchivePage({ code: "688521", entries: ENTRIES, prices });
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("调研日收盘");
    expect(html).toContain("暂无这只票的行情数据");
    expect(html).toContain("每次说了什么");
  }
});

test("renderArchivePage：标题 / 导语里的尖括号被转义（报告内容出自全权限 headless Claude）", () => {
  const evil = [
    { title: "坏<script>alert(1)</script>（600001.SH）", type: "股票", date: "2026-07-01", href: "r/a/", tldr: "方向震荡：<img src=x onerror=alert(1)>。" },
    { title: "坏<script>alert(1)</script>（600001.SH）", type: "股票", date: "2026-08-01", href: "r/b/", tldr: "方向震荡：正常。" },
  ];
  const html = renderArchivePage({ code: "600001", entries: evil, prices: null });
  expect(html).not.toContain("<script>alert");
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;img src=x");
});
