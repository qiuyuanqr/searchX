// 公开阅读入口。GitHub Pages 同时承担 VPS 发布源，CI/发布器的源地址不可随通知切换。
export const PRIMARY_SITE_BASE = "https://search.qiuyuan.net";
export const BACKUP_SITE_BASE = "https://qiuyuanqr.github.io/searchX";

export function resolveSiteBase(raw) {
  return String(raw || "").trim().replace(/\/+$/, "") || PRIMARY_SITE_BASE;
}

// 只迁移本站已知的公开报告链接；第三方 URL、核查私密入口等保持原样。
function reportSuffix(value, base) {
  try {
    const url = new URL(value), origin = new URL(base);
    const prefix = origin.pathname.replace(/\/+$/, "") + "/r/";
    if (url.origin !== origin.origin || url.username || url.password || !url.pathname.startsWith(prefix)) return null;
    return url.pathname.slice(origin.pathname.replace(/\/+$/, "").length + 1) + url.search + url.hash;
  } catch { return null; }
}

export function migrateReportUrl(url, siteBase = PRIMARY_SITE_BASE) {
  for (const base of [BACKUP_SITE_BASE, PRIMARY_SITE_BASE]) {
    const suffix = reportSuffix(url, base);
    if (suffix !== null) return `${resolveSiteBase(siteBase)}/${suffix}`;
  }
  return url;
}

export function backupReportUrl(url) {
  const suffix = reportSuffix(url, PRIMARY_SITE_BASE);
  return suffix === null ? "" : `${BACKUP_SITE_BASE}/${suffix}`;
}
