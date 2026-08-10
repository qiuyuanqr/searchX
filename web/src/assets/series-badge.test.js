import { test, expect } from "bun:test";
import { seriesBadgeHtml, seriesNewerLinkHtml } from "./series-badge.js";

test("第 2 次带间隔天数", () => {
  expect(seriesBadgeHtml({ index: 2, total: 2, daysSincePrev: 48, newerHref: null }))
    .toBe('<span class="series-badge">第 2 次<span class="series-gap"> · 48 天后</span></span>');
});

test("系列里最早那篇不出行内角标（它靠「已有更新版」表达身份）", () => {
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

test("「已有更新版」链到 newerHref；最新那篇不出这行", () => {
  expect(seriesNewerLinkHtml({ index: 1, total: 2, daysSincePrev: null, newerHref: "r/2026-07-26_x/" }))
    .toBe('<a class="series-newer" href="r/2026-07-26_x/">已有更新版 →</a>');
  expect(seriesNewerLinkHtml({ index: 2, total: 2, daysSincePrev: 48, newerHref: null })).toBe("");
  expect(seriesNewerLinkHtml(undefined)).toBe("");
});

test("href 转义（防 DOM-XSS）", () => {
  const html = seriesNewerLinkHtml({ newerHref: 'r/"><img src=x onerror=alert(1)>/' });
  expect(html).not.toContain("<img");
  expect(html).toContain("&quot;&gt;&lt;img");
});
