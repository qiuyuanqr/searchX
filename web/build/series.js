// 同一标的的多份报告 = 一个「系列」，不是重复。
// 2026-08-28 用户拍板（替代 08-10 的「两张卡都留」）：旧报告过时了，首页与搜索**只展示最新篇**，
// 旧篇归进最新条目下的「历史调研」行；旧报告页面仍在线上（挂更新版横幅、退出全文索引）。
// 归组结果同时进 reports.json，让信息流卡片与搜索结果卡片用同一份数据、不各算一套。

// 归组键：优先用**标题里**的 6 位代码。
// 只认标题不认标签是有意的——别的报告标签里提到某只票的代码（如板块报告 tags 含 300476）
// 不该被并进那只票的系列里。港股 5 位后缀（02476.HK）天然不匹配 6 位，不参与归组。
// 无代码时退回「去掉括号内容后的标题」，且要求完全相同才归组：宁可不归组，也不错并。
export function seriesKey(entry) {
  const title = String((entry && entry.title) || "");
  const code = title.match(/\d{6}/);
  if (code) return code[0];
  return title.replace(/（[^）]*）/g, "").replace(/\([^)]*\)/g, "").trim().toLowerCase();
}

// 日历天差；任一端日期缺失/损坏 → null（记作"间隔未知"，不编造数字）
function daysBetween(fromYMD, toYMD) {
  const a = Date.parse(String(fromYMD) + "T00:00:00Z");
  const b = Date.parse(String(toYMD) + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

// 给每条 entry 补 series 字段：{ index, total, daysSincePrev, newerHref, latestHref?, latestDate?, history? }。
// 旧篇带 newerHref（链紧邻下一篇）与 latestHref/latestDate（报告页横幅直达最新版）；
// 最新篇带 history（新→旧的 {date, href} 列表，渲染「历史调研」行）。
// 只有 total > 1 才挂 series——单篇报告不该出现任何角标。
// 返回新数组、保持入参顺序，原对象不改（调用方还要按原序渲染信息流）。
export function annotateSeries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const groups = new Map();
  for (const e of list) {
    const k = seriesKey(e);
    if (!k) continue;                       // 键为空（无标题）→ 不归组
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }

  const info = new Map();                   // entry 对象 → series
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // 组内按时间旧→新。同一天用 href 兜底，保证顺序确定、不出现两篇并列「最新」。
    const ordered = [...group].sort(
      (a, b) => String(a.date).localeCompare(String(b.date)) || String(a.href).localeCompare(String(b.href)),
    );
    const latest = ordered[ordered.length - 1];
    ordered.forEach((e, i) => {
      const prev = i > 0 ? ordered[i - 1] : null;
      const next = i < ordered.length - 1 ? ordered[i + 1] : null;
      const s = {
        index: i + 1,
        total: ordered.length,
        daysSincePrev: prev ? daysBetween(prev.date, e.date) : null,
        // 链到紧邻的下一篇，不是最新那篇：三篇时中间那篇的"更新版"是它的下一篇，
        // 顺着链能一篇篇读下去，也能看出判断是怎么一步步改的。
        newerHref: next ? next.href : null,
      };
      if (next) {
        // 旧篇：报告页横幅要一键直达最新版（顺链读是给愿意考古的人的，横幅先给最新）
        s.latestHref = latest.href;
        s.latestDate = latest.date;
      } else {
        // 最新篇：挂新→旧的历史列表，渲染条目下的「历史调研」行
        s.history = ordered.slice(0, -1).reverse().map((x) => ({ date: x.date, href: x.href }));
      }
      info.set(e, s);
    });
  }

  return list.map((e) => (info.has(e) ? { ...e, series: info.get(e) } : e));
}
