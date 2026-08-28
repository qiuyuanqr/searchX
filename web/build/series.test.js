import { test, expect } from "bun:test";
import { seriesKey, annotateSeries } from "./series.js";

// entries 按信息流顺序（新→旧）给，与 scanResearch 的输出一致
const SHENGHONG_NEW = { title: "胜宏科技（300476.SZ / 02476.HK）", date: "2026-07-26", href: "r/2026-07-26_shenghong-tech-300476/", type: "股票" };
const SHENGHONG_OLD = { title: "胜宏科技（300476.SZ / 02476.HK）", date: "2026-06-08", href: "r/2026-06-08_shenghong-tech-300476/", type: "股票" };
const GUOCI_NEW = { title: "国瓷材料（300285.SZ）— 未来约 13 周走势判断", date: "2026-07-13", href: "r/2026-07-13_guoci-materials-300285/", type: "股票" };
const GUOCI_OLD = { title: "国瓷材料（300285.SZ）", date: "2026-06-05", href: "r/2026-06-05_guoci-materials-300285/", type: "股票" };
const LONE = { title: "宏景科技（301396.SZ）", date: "2026-07-29", href: "r/2026-07-29_hongjing-tech-301396/", type: "股票" };

test("seriesKey：按标题里的 6 位代码归组（标题后缀不同也算同一只）", () => {
  expect(seriesKey(GUOCI_NEW)).toBe(seriesKey(GUOCI_OLD));
  expect(seriesKey(SHENGHONG_NEW)).toBe(seriesKey(SHENGHONG_OLD));
  expect(seriesKey(LONE)).not.toBe(seriesKey(GUOCI_NEW));
});

test("seriesKey：只认标题里的代码，不认标签——别的报告标签里提到某代码不该被并进来", () => {
  const mentions = { title: "国产替代芯片供应链的龙头企业", tags: ["research", 300476], date: "2026-08-10", href: "r/x/", type: "板块" };
  expect(seriesKey(mentions)).not.toBe(seriesKey(SHENGHONG_NEW));
});

test("seriesKey：港股 5 位后缀不参与归组（02476 不是 6 位）", () => {
  expect(seriesKey(SHENGHONG_NEW)).toBe("300476");
});

test("无代码的报告按去括号后的标题归组；标题不同则不归组", () => {
  const a = { title: "CPO 共封装光学", date: "2026-05-01", href: "r/a/", type: "概念" };
  const b = { title: "CPO 共封装光学", date: "2026-06-01", href: "r/b/", type: "概念" };
  const c = { title: "CPO / 硅光产业链", date: "2026-06-02", href: "r/c/", type: "概念" };
  expect(seriesKey(a)).toBe(seriesKey(b));
  expect(seriesKey(a)).not.toBe(seriesKey(c));
});

test("单篇报告不带 series 字段（不出角标）", () => {
  const out = annotateSeries([LONE]);
  expect(out[0].series).toBeUndefined();
});

test("两篇：新的拿「第 2 次 + 间隔天数 + history」，旧的拿 newerHref + latest 直达", () => {
  const out = annotateSeries([SHENGHONG_NEW, SHENGHONG_OLD]);
  const [nw, old] = out;
  expect(nw.series).toEqual({
    index: 2, total: 2, daysSincePrev: 48, newerHref: null,
    history: [{ date: "2026-06-08", href: "r/2026-06-08_shenghong-tech-300476/" }],
  });
  expect(old.series).toEqual({
    index: 1, total: 2, daysSincePrev: null,
    newerHref: "r/2026-07-26_shenghong-tech-300476/",
    latestHref: "r/2026-07-26_shenghong-tech-300476/", latestDate: "2026-07-26",
  });
});

test("三篇：中间那篇 newerHref 链紧邻下一篇、latest 直达最新；最新篇 history 新→旧", () => {
  const mid = { title: "某股（000001.SZ）", date: "2026-03-01", href: "r/mid/", type: "股票" };
  const old = { title: "某股（000001.SZ）", date: "2026-02-01", href: "r/old/", type: "股票" };
  const nw = { title: "某股（000001.SZ）", date: "2026-04-01", href: "r/new/", type: "股票" };
  const out = annotateSeries([nw, mid, old]);
  const byHref = Object.fromEntries(out.map((e) => [e.href, e.series]));
  expect(byHref["r/new/"]).toEqual({
    index: 3, total: 3, daysSincePrev: 31, newerHref: null,
    history: [{ date: "2026-03-01", href: "r/mid/" }, { date: "2026-02-01", href: "r/old/" }],
  });
  expect(byHref["r/mid/"]).toEqual({
    index: 2, total: 3, daysSincePrev: 28, newerHref: "r/new/",
    latestHref: "r/new/", latestDate: "2026-04-01",
  });
  expect(byHref["r/old/"]).toEqual({
    index: 1, total: 3, daysSincePrev: null, newerHref: "r/mid/",
    latestHref: "r/new/", latestDate: "2026-04-01",
  });
});

test("不改变入参顺序，也不改动原对象（构建里这个数组还要按原序渲染）", () => {
  const input = [SHENGHONG_NEW, GUOCI_NEW, SHENGHONG_OLD, GUOCI_OLD];
  const out = annotateSeries(input);
  expect(out.map((e) => e.href)).toEqual(input.map((e) => e.href));
  expect(SHENGHONG_NEW.series).toBeUndefined(); // 原对象不被写脏
});

test("同一天的两篇也能分出先后（按 href 兜底，保证确定性、不并列）", () => {
  const a = { title: "某股（000002.SZ）", date: "2026-05-01", href: "r/a/", type: "股票" };
  const b = { title: "某股（000002.SZ）", date: "2026-05-01", href: "r/b/", type: "股票" };
  const out = annotateSeries([a, b]);
  const idx = out.map((e) => e.series.index).sort();
  expect(idx).toEqual([1, 2]);
  expect(out.filter((e) => e.series.newerHref === null).length).toBe(1); // 只有一篇是「最新」
});

test("日期缺失或损坏不炸，间隔记 null", () => {
  const a = { title: "某股（000003.SZ）", date: "", href: "r/a/", type: "股票" };
  const b = { title: "某股（000003.SZ）", date: "2026-05-01", href: "r/b/", type: "股票" };
  const out = annotateSeries([a, b]);
  expect(out.every((e) => e.series.total === 2)).toBe(true);
  expect(out.some((e) => e.series.daysSincePrev === null)).toBe(true);
});
