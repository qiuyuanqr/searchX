import { test, expect } from "bun:test";
import { PRIMARY_SITE_BASE, BACKUP_SITE_BASE, resolveSiteBase, migrateReportUrl, backupReportUrl } from "./site-links.js";

test("公开入口默认新域名；环境覆盖保留回滚能力", () => {
  expect(resolveSiteBase()).toBe(PRIMARY_SITE_BASE);
  expect(resolveSiteBase("  ")).toBe(PRIMARY_SITE_BASE);
  expect(resolveSiteBase(" https://qiuyuanqr.github.io/searchX/ ")).toBe(BACKUP_SITE_BASE);
});
test("仅重写已知两站的报告路径，保留路径/查询/锚点，拒绝相似域名和无关URL", () => {
  expect(migrateReportUrl(BACKUP_SITE_BASE+"/r/test/?v=1#s", PRIMARY_SITE_BASE)).toBe(PRIMARY_SITE_BASE+"/r/test/?v=1#s");
  expect(migrateReportUrl(PRIMARY_SITE_BASE+"/r/test/", BACKUP_SITE_BASE)).toBe(BACKUP_SITE_BASE+"/r/test/");
  for (const url of ["https://qiuyuanqr.github.io.evil/searchX/r/test/", "https://search.qiuyuan.net.evil/r/test/", "https://qiuyuanqr.github.io/other/r/test/", "https://search.qiuyuan.net/check.html", "bad-url"])
    expect(migrateReportUrl(url, PRIMARY_SITE_BASE)).toBe(url);
});
test("备用链接只给新主站公开报告，不重复/不改自定义站点", () => {
  expect(backupReportUrl(PRIMARY_SITE_BASE+"/r/test/")).toBe(BACKUP_SITE_BASE+"/r/test/");
  expect(backupReportUrl(BACKUP_SITE_BASE+"/r/test/")).toBe("");
  expect(backupReportUrl("https://custom.invalid/r/test/")).toBe("");
});
