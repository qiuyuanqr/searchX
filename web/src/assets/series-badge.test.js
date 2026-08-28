import { test, expect } from "bun:test";
import { seriesBadgeHtml, seriesHistoryHtml } from "./series-badge.js";

test("第 2 次带间隔天数", () => {
  expect(seriesBadgeHtml({ index: 2, total: 2, daysSincePrev: 48, newerHref: null }))
    .toBe('<span class="series-badge">第 2 次<span class="series-gap"> · 48 天后</span></span>');
});

test("系列里最早那篇不出行内角标（2026-08-28 起它整条不展示，防御性保留判定）", () => {
  expect(seriesBadgeHtml({ index: 1, total: 2, daysSincePrev: null, newerHref: "r/x/" })).toBe("");
});

test("非系列 / 空值 → 空串，不出角标", () => {
  expect(seriesBadgeHtml(undefined)).toBe("");
  expect(seriesBadgeHtml(null)).toBe("");
  expect(seriesBadgeHtml({})).toBe("");
});

test("间隔未知时只说第几次，不编造天数", () => {
  expect(seriesBadgeHtml({ index: 2, total: 2, daysSincePrev: null, newerHref: null }))
    .toBe('<span class="series-badge">第 2 次</span>');
});

test("「历史调研」行：最新篇按 history 出日期链接（新→旧、点隔）；旧篇 / 无 history 不出", () => {
  expect(seriesHistoryHtml({ index: 3, total: 3, daysSincePrev: 20, newerHref: null,
    history: [{ date: "2026-08-10", href: "r/b/" }, { date: "2026-07-02", href: "r/a/" }] }))
    .toBe('<div class="series-history">历史调研：<a href="r/b/">2026-08-10</a><span class="series-history-dot"> · </span><a href="r/a/">2026-07-02</a></div>');
  expect(seriesHistoryHtml({ index: 1, total: 2, daysSincePrev: null, newerHref: "r/x/" })).toBe("");
  expect(seriesHistoryHtml({ history: [] })).toBe("");
  expect(seriesHistoryHtml(undefined)).toBe("");
});

test("history 的 href 与日期都转义（防 DOM-XSS）", () => {
  const html = seriesHistoryHtml({ history: [{ date: '<img src=x onerror=alert(1)>', href: 'r/"><img src=x>/' }] });
  expect(html).not.toContain("<img");
  expect(html).toContain("&quot;&gt;&lt;img");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
});
