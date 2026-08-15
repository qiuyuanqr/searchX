// scripts/check-web-numbers.js
// 联网数字回链核验：把正文里挂了外链的每个数字，回到**那个链接的页面**里用数字本身搜一遍。
//
// ## 为什么需要它（机器质检的第二条腿）
//
// `research-qc.js` 的数字对账只比对本地 `data/`，**结构上看不见联网来源**——而 searchX
// 的事实主要来自 WebSearch，真正反复出事的正是联网这条腿：
//   · 2026-08-15 智谱那篇 16 条硬错，根因是「搜索摘要 ≠ 所引链接的内容」；
//   · 2026-08-16 中际旭创那篇，机器质检硬红线 0、取数点全覆盖、判别力 93%，看着很干净，
//     核验员仍抓出 6 条硬错，其中三条就是「数字挂错来源 / 数字压根不在页内 / 同页两种
//     情形的数字被并成一对」。
// 这两次都靠 LLM 核验员抓到，代价是「核验员有没有真去抓链接、真去搜数字」无从验证，
// 且它只框承重项十几二十条。本模块把那个动作做成确定性的、可复现的、覆盖全量的一遍。
//
// ## 一条不许破的线：它不是闸
//
// **本模块永远不挡 push，没有 `--strict`。** 抓取成败不可控——JS 渲染的骨架页（实测
// 36kr 正文只有 2KB）、PDF、反爬、墙内网络抖动，都会让「搜不到」这个信号失真。做成硬闸
// 等于让网络状况决定报告能不能发，违反本项目「绝不因取数失败而中断出报告」。
// 所以口径是**非对称**的：
//   · 搜到了 → 确定性的强证据，这个数字与这条来源的配对成立；
//   · 搜不到 → 只是**嫌疑**，交给 Step 5.5 核验员②去质证，不下判决；
//   · 没抓到 → 如实写「未测」，绝不当通过（同 research-qc 的规矩）。
//
// ## 与既有代码的分工（不重复造）
//
// - `scripts/check-sources.js` 管 **sources.md ⊇ report.html**（URL 集合层面）——本模块不碰；
// - `scripts/research-qc.js` 管**本地 `data/` 的数字对账 + 格式红线**，秒级、不联网、可复现，
//   本模块不并进去：一并进去就会把它变成一个要联网几十秒的东西，毁掉它最有价值的性质。
//   数字提取直接 import 它的 `reportNumbers`，口径分家会让两份清单对不上。
//
//   bun run scripts/check-web-numbers.js --dir <归档目录名>              # 核一篇
//   bun run scripts/check-web-numbers.js --dir <x> --challenge           # 输出喂给 Step 5.5 的质证清单
//   bun run scripts/check-web-numbers.js --dir <x> --max-urls 20         # 限制抓取条数（默认 60）
//   bun run scripts/check-web-numbers.js --dir <x> --no-skip-local       # 连能对回 data/ 的数字也一起核

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { reportNumbers, runQc } from "./research-qc.js";

const ARCHIVE = "research";

// ========== HTML → 带链接的块 ==========

// 块边界。**不切 `</td>`**：表格里「营收 | 108.96 亿 | <a>来源</a>」是分在三个单元格的，
// 按 td 切会让数字和链接落进不同块、数字失去归属（漏核）。按 `</tr>` 切，一行是一个块。
const BLOCK_END_RE = /<\/(?:p|li|tr|div|h[1-6]|dd|dt|blockquote|section|figcaption)>/gi;

export function stripTags(html) {
  return String(html || "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

// 把 report.html 切成 [{text, urls}]。只保留**含至少一个外链**的块——没有链接的数字
// 不属于「联网数字」，那是 research-qc 数字对账的活，这里不重复管。
export function blocksWithLinks(html) {
  const src = String(html || "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  const out = [];
  let last = 0;
  const pushBlock = (chunk) => {
    const urls = [];
    for (const m of chunk.matchAll(/href\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
      if (!urls.includes(m[1])) urls.push(m[1]);
    }
    if (!urls.length) return;
    const text = stripTags(chunk).replace(/\s+/g, " ").trim();
    if (text) out.push({ text, urls });
  };
  for (const m of src.matchAll(BLOCK_END_RE)) {
    pushBlock(src.slice(last, m.index));
    last = m.index + m[0].length;
  }
  pushBlock(src.slice(last));
  return out;
}

// ========== 待核数字的挑选 ==========

// 从块文本里挑**值得回链核**的数字。复用 research-qc 的 reportNumbers（已滤掉 URL、
// 时间、年份、证券代码、≤13 的整数），这里再加一道「辨识度」过滤：
// 不带小数、又没有 %／亿／万 单位的三位数以内整数（「3 家客户」「已有 200 人」），
// 在任何一个长网页里都几乎必然命中，核了等于没核，只会稀释清单。
// 「1.1–7.16 累计签单 146.53 亿元」里的 1.1 和 7.16 是**日期区间**，不是事实性数字。
// 股票报告的事件表里这种写法很常见，不滤掉就会在质证清单里堆一批永远核不上的噪声
// （2026-08-16 对芯原那篇真跑，challenge 前六条里有四条是它）。
// 判定收窄到三条同时成立：两侧都是「月.日」形态（月 1–12、日 1–31）、**至少一侧的日是两位**、
// 且**后面没有紧跟单位字**——这样「1.5–3.2 倍」「10.5–12.30 亿」这类真实数值区间不会被误伤
// （后一个例子是收尾复审时发现的：10 月 5 日–12 月 30 日与 10.5 亿–12.30 亿形态完全一样，
// 只有单位能分开它们，漏了这条会把一个真实的区间数据静默吞掉）。
const DATE_RANGE_RE =
  /(?<![\d.])(\d{1,2})\.(\d{1,2})\s*[–—~-]\s*(\d{1,2})\.(\d{1,2})(?![\d])(?!\s{0,2}[亿万元％%倍个家点千])/g;

export function stripDateRanges(text) {
  return String(text || "").replace(DATE_RANGE_RE, (m, m1, d1, m2, d2) => {
    const ok = (mo, d) => +mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31;
    const twoDigit = d1.length === 2 || d2.length === 2;
    return ok(m1, d1) && ok(m2, d2) && twoDigit ? " " : m;
  });
}

export function citedNumbers(blockText) {
  const out = [];
  for (const n of reportNumbers(stripDateRanges(blockText))) {
    const hasUnit = /^\s*(亿|万|%|％)/.test(n.tail || "");
    if (!n.raw.includes(".") && !hasUnit && Math.abs(n.value) < 1000) continue;
    out.push(n);
  }
  return out;
}

// ========== 数字在页内的几种写法 ==========

// 去掉浮点运算留下的尾巴（108.96 * 1e4 在 JS 里是 1089600.0000000001）。
function fmtNum(n) {
  if (!Number.isFinite(n)) return null;
  const s = Math.abs(n) >= 1e15 ? String(n) : Number(n.toPrecision(12)).toString();
  return s.includes("e") ? null : s;
}

function withThousands(s) {
  const [i, d] = String(s).split(".");
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (d ? "." + d : "");
}

// 同一个数在报告与网页里的常见写法差异：千分位有无、尾零、以及**单位换算**
// （报告写「108.96 亿元」，公告原文常写「10,896,000,000」或「1,089,600 万元」）。
//
// ⚠️ 变体要克制。这里的风险与 research-qc「真值池按单位展开」那个坑同源：候选越多，
// 在一个几万字的页面里碰巧命中的概率越高，「搜到了」这个强证据就越不强。所以只做
// **放大**方向（亿→万→元）这一种真实存在的换算，不做反向、不做任意倍缩放，且封顶 8 个。
export function numberVariants({ raw, value, tail }) {
  const out = [];
  const add = (s) => {
    if (s && !out.includes(s)) out.push(s);
  };
  add(raw);
  add(raw.replace(/,/g, ""));
  add(withThousands(raw.replace(/,/g, "")));
  if (raw.includes(".")) add(raw.replace(/0+$/, "").replace(/\.$/, "")); // 61.70 → 61.7
  else add(raw + ".0");

  const u = (String(tail || "").match(/^\s*(亿|万)/) || [])[1];
  if (u === "亿") {
    for (const k of [1e4, 1e8]) {
      const s = fmtNum(value * k);
      add(s);
      if (s) add(withThousands(s));
    }
  } else if (u === "万") {
    const s = fmtNum(value * 1e4);
    add(s);
    if (s) add(withThousands(s));
  }
  return out.slice(0, 8);
}

// 在页面文本里找一个数字串。**必须卡数字边界**：直接 indexOf("61.7") 会在页面的
// 「161.7」「61.75」里命中，把不存在的配对报成存在——那正好是本模块最该避免的错误方向
// （假「搜到」＝ 放过一条真硬错）。
//
// ⚠️ 边界还必须**卡住千分位串的两头**。只写 `(?![\d])` 是不够的：「108.96 亿」的万元候选
// 是 `1,089,600`，而页面若写着 `1,089,600,000`（10.896 亿，差 1000 倍），逗号不是数字、
// 后置断言照样放行——本文件的测试当场抓到过这个。所以再加两条：前面不许是「数字逗号」
// （自己是更长串的尾段），后面不许是「逗号数字」（串还没结束）。
export function containsNumber(pageText, needle) {
  const esc = String(needle).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\d.])(?<!\\d,)${esc}(?![\\d])(?!,\\d)`).test(pageText);
}

// 页面文本归一：删掉全部空白。网页里「61.7 %」「108.96 亿元」中间常夹空格或换行，
// 不归一会把本来在页内的数字判成不在。
export function normalizePage(text) {
  return String(text || "").replace(/\s+/g, "");
}

// ========== 量级比对（字符串搜不到时的第二档） ==========

// 光靠字符串搜是不够的：**报告写的是四舍五入值，来源写的是精确值**。实测智谱那篇
// 「2025 年收入 7.24 亿元」，港交所公告原文是千元单位的 `724,187`——主体、口径、数都对，
// 精确串却永远搜不到。只做字符串匹配的话，那一篇 85 个数字里有 38 个被报成待质证，
// 清单立刻失信（同 research-qc 的教训：误报一多就没人看了）。
//
// 所以补一档**按数值比对**：把页面里的数字串全抽成数值，再拿报告数字按单位缩放后的
// 候选值去够，容差取「报告写出的精度」并**随倍数一起缩放**（这个坑 research-qc 踩过——
// 缩放后仍用固定绝对容差，等于给小数字开了 22% 的窗口）。
const PAGE_NUM_RE = /(?<![\w.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;

export function pageNumbers(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(PAGE_NUM_RE)) {
    const v = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(v)) out.add(v);
  }
  return out;
}

// 报告数字 → [{v, tol, label}]。只做**放大**方向（亿→万→千→元）这一种真实存在的换算，
// 「千元」这一档是港交所与 A 股公告的常用口径，漏了它就会整批漏掉一手披露类来源。
export function scaledCandidates({ raw, value, tail }) {
  const s = String(raw);
  const dot = s.indexOf(".");
  const dec = dot === -1 ? 0 : s.length - dot - 1;
  // 容差 = 报告写出那一位的半个单位（写「7.24」就允许 ±0.005），再兜一个 0.05% 的相对下限。
  const tol = Math.max(0.5 * Math.pow(10, -dec), Math.abs(value) * 5e-4);
  const out = [{ v: value, tol, label: "原值" }];
  const push = (k, label) => out.push({ v: value * k, tol: tol * k, label });
  const u = (String(tail || "").match(/^\s*(亿|万|%|％)/) || [])[1];
  if (u === "亿") { push(1e4, "万元"); push(1e5, "千元"); push(1e8, "元"); }
  else if (u === "万") { push(10, "千元"); push(1e4, "元"); }
  else if (u === "%" || u === "％") push(1e-2, "小数比率");
  return out;
}

// ⚠️ 固有局限，别指望它判得出：本函数**只比数值、不读页面上的单位**（同 research-qc）。
// 页面写的「72,418」按万元读正好是 7.2418 亿，落在「7.24 亿」的容差内 ——
// 这是**该命中**的；但反过来，若页面那个 72,418 其实是「元」，它也照样命中。
// 所以命中只证明「这一页里有个数与报告的数在某个口径下对得上」，不证明口径本身没错配。
// 口径错配（2026-08-16 中际旭创那篇的第三条硬错）仍然只有核验员回到原文才判得了。
export function matchByMagnitude(num, pageNums) {
  for (const { v, tol, label } of scaledCandidates(num)) {
    for (const t of pageNums) if (Math.abs(v - t) <= tol) return { hit: true, label, found: t };
  }
  return { hit: false };
}

// 一个数字在一批已抓到的页面里的核对结果。两档，**精确串优先**——「页面里就写着 7.24」
// 比「页面里有个 724,187 换算得上」是强得多的证据，输出要能分清。
export function matchNumberInPages(num, pages) {
  const variants = numberVariants(num);
  for (const p of pages) {
    for (const v of variants) {
      if (containsNumber(p.text, v)) return { hit: true, url: p.url, form: `原样「${v}」` };
    }
  }
  for (const p of pages) {
    const m = matchByMagnitude(num, p.nums || pageNumbers(p.text));
    if (m.hit) return { hit: true, url: p.url, form: `按${m.label}口径换算命中 ${m.found}`, scaled: true };
  }
  return { hit: false, variants };
}

// 本轮比对的**判别力**：拿一批与正文同量级的凭空数字，看有多少能被判为「不在页内」。
//
// 为什么必须有（照搬 research-qc 的教训）：数值比对的强弱完全取决于页面的数字密度。
// 一份几千个数字的招股书，容差窗口里随便一个数都能碰上，此时「全部命中」什么也证明不了，
// 而**检查失效时反而显示得最漂亮**。所以让它自报家门：判别力低就明说这轮不作数。
// 固定种子，可复现（不用 Math.random，否则同一篇每次跑出不同结论）。
export function matchPower(items, samples = 200) {
  const withPages = items.filter((it) => it.pages && it.pages.length);
  if (!withPages.length) return null;
  let s = 987654321;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  let caught = 0;
  for (let i = 0; i < samples; i++) {
    const base = withPages[Math.floor(rnd() * withPages.length)];
    const v = Number((Math.abs(base.value) * (0.2 + rnd() * 3)).toFixed(2));
    const fake = { raw: v.toFixed(2), value: v, tail: base.tail };
    if (!matchNumberInPages(fake, base.pages).hit) caught += 1;
  }
  return caught / samples;
}

// ========== 抓取 ==========

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// 正文太短 = 多半是 JS 渲染的骨架（实测 36kr 详情页剥完标签只剩约 2KB，正文根本没在
// HTML 里）。这种页面**必须判「未测」**，否则一篇报告里挂了几条这类链接，就会批量
// 报出「数字不在页内」的假嫌疑，清单立刻失信、下次没人看。
const MIN_RENDERED_CHARS = 800;

export function looksUnrendered(text) {
  return normalizePage(text).length < MIN_RENDERED_CHARS;
}

// 从 HTTP 响应体解码出文本。绝大多数来源是 UTF-8；GBK 系（老财经站）用 iconv 兜底——
// bun 的 TextDecoder 不认 "gbk"（实测抛 Unsupported encoding label）。
async function decodeBody(buf, contentType) {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, 4096));
  const declared = (
    (contentType || "").match(/charset=([\w-]+)/i) ||
    head.match(/charset=["']?([\w-]+)/i) ||
    []
  )[1];
  if (declared && /gb(2312|k|18030)/i.test(declared)) {
    try {
      const p = Bun.spawn(["iconv", "-f", "gb18030", "-t", "utf-8"], {
        stdin: new Uint8Array(buf),
        stdout: "pipe",
        stderr: "ignore",
      });
      const t = await new Response(p.stdout).text();
      if (t) return t;
    } catch {
      /* iconv 不可用 → 退回 utf-8 尽力而为 */
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

// PDF 走 pdftotext（poppler）。**没装就如实报「未测」**，不猜、不当成搜不到——
// 智谱那篇 20 条来源是 pdf.dfcfw.com，把它们误报成「数字不在页内」等于毁掉整份清单。
async function pdfToText(buf) {
  try {
    const p = Bun.spawn(["pdftotext", "-q", "-", "-"], {
      stdin: new Uint8Array(buf),
      stdout: "pipe",
      stderr: "ignore",
    });
    const t = await new Response(p.stdout).text();
    return t || null;
  } catch {
    return null;
  }
}

// 抓一个 URL → {ok, text} 或 {ok:false, note}。**任何异常都吞掉**（同 research-qc：
// 质检绝不能弄死一份跑了几十分钟的报告）。
export async function fetchPage(url, { timeout = 12000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/pdf,*/*" },
    });
    if (!res.ok) return { ok: false, note: `HTTP ${res.status}` };
    const ct = res.headers.get("content-type") || "";
    const buf = await res.arrayBuffer();
    if (/pdf/i.test(ct) || /\.pdf$/i.test(new URL(url).pathname)) {
      const t = await pdfToText(buf);
      if (!t) return { ok: false, note: "PDF 未能提取文本（缺 pdftotext 或为扫描件）" };
      return { ok: true, text: normalizePage(t) };
    }
    const html = await decodeBody(buf, ct);
    const text = stripTags(html);
    if (looksUnrendered(text)) return { ok: false, note: "页面正文过短，疑似 JS 渲染未落到 HTML" };
    return { ok: true, text: normalizePage(text) };
  } catch (e) {
    return { ok: false, note: e.name === "AbortError" ? "超时" : `抓取失败（${e.message}）` };
  } finally {
    clearTimeout(timer);
  }
}

// 带并发上限地抓一批 URL。
async function fetchAll(urls, { timeout, concurrency = 4, onProgress } = {}) {
  const map = new Map();
  let i = 0;
  const worker = async () => {
    while (i < urls.length) {
      const url = urls[i++];
      map.set(url, await fetchPage(url, { timeout }));
      onProgress?.(map.size, urls.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return map;
}

// ========== 主流程 ==========

// 上下文自称是推算出来的（「据两数推算」「＝382.40−250.05」）。**只标注、不排除**——
// 自称推算也可能是编的，那正是核验员该看的。标出来是为了让清单好读：核验员一眼能分出
// 「这条是派生值，核推算过程」还是「这条声称有来源，核来源」。
const DERIVED_RE = /推算|测算|折算|反算|据.{0,6}算|[＝=]\s*[\d(（]/;

// 组装待核清单。
//
// `localValues` = 能对回本地 `data/` 的数值集合。**本模块只管「联网数字」**——一个能在
// 自家取数里找到的数，不是联网来的，它归 research-qc 的数字对账管，重复列进来只会稀释
// 清单。2026-08-16 对中际旭创那篇真跑，14 条待质证里 11 条正是这一类（上下文明写
// 「取自 Stocks 库财务表」），噪声占了八成。
// 传 null 表示**没有 data/ 可比**（那台机器上取数没留档），此时一个都不排除——
// 「没测」绝不能当成「测过了」。
//
// ⚠️ **这一层的代价要认**（加一层保护先问是不是拆了另一层）：一个数字如果既能对回 `data/`、
// 又挂了条不相干的外链，排除之后 5.4b 不再看它，而 5.4a 只会说「对上了」——**「链接挂错」
// 这件事对这类数字就没人管了**。换来的是清单可读（实测噪声占八成），这笔交换是划算的，
// 但需要全量看时用 `--no-skip-local` 关掉它。
export function planChecks(html, { maxUrls = 60, localValues = null } = {}) {
  const blocks = blocksWithLinks(html);
  const items = [];
  const urls = [];
  let skippedLocal = 0;
  for (const b of blocks) {
    const nums = citedNumbers(b.text).filter((n) => {
      if (localValues && !localValues.has(n.value)) {
        skippedLocal += 1;
        return false;
      }
      return true;
    });
    if (!nums.length) continue;
    for (const u of b.urls) if (!urls.includes(u)) urls.push(u);
    for (const n of nums) {
      items.push({ ...n, urls: b.urls, derived: DERIVED_RE.test(n.context) });
    }
  }
  return { items, urls: urls.slice(0, maxUrls), urlsTotal: urls.length, skippedLocal };
}

// 取「对不回 data/ 的数值」集合。直接复用 research-qc 的 runQc——**口径必须同一份**，
// 各写一套对账逻辑就会出现「那边说对上了、这边说没有」的分家。
// 没有 data/（或质检没跑成）→ 返回 null，表示无从排除。
export function localUnmatchedValues(dirName, root = ARCHIVE) {
  try {
    const qc = runQc(dirName, root);
    if (!qc.ok || !qc.dataPresent) return null;
    return new Set(qc.numbersUnmatched.map((u) => Number(String(u.value).replace(/,/g, ""))));
  } catch {
    return null;
  }
}

export function classify(items, fetched) {
  const confirmed = [];
  const notFound = [];
  const untested = [];
  const scored = [];
  // 每个页面的数值集合只抽一次：一篇报告里同一条来源会被十几个数字共用，
  // 每次重抽一份几千个数的集合是白烧时间。
  const numsCache = new Map();
  const numsOf = (url, text) => {
    if (!numsCache.has(url)) numsCache.set(url, pageNumbers(text));
    return numsCache.get(url);
  };
  for (const it of items) {
    const pages = it.urls
      .map((u) => ({ url: u, ...(fetched.get(u) || { ok: false, note: "未抓取（超出上限）" }) }))
      .filter((p) => p.ok)
      .map((p) => ({ ...p, nums: numsOf(p.url, p.text) }));
    if (!pages.length) {
      const notes = it.urls.map((u) => `${u}（${fetched.get(u)?.note || "未抓取"}）`);
      untested.push({ ...it, notes });
      continue;
    }
    scored.push({ ...it, pages });
    const r = matchNumberInPages(it, pages);
    if (r.hit) confirmed.push({ ...it, url: r.url, form: r.form, scaled: Boolean(r.scaled) });
    else notFound.push({ ...it, tried: pages.map((p) => p.url) });
  }
  return { confirmed, notFound, untested, power: matchPower(scored) };
}

export async function verifyArchive(dirName, opts = {}) {
  const root = opts.root || ARCHIVE;
  const reportPath = join(root, dirName, "report.html");
  const base = { dir: dirName, ok: false, confirmed: [], notFound: [], untested: [] };
  try {
    if (!existsSync(reportPath)) return { ...base, error: `${join(dirName, "report.html")} 不存在` };
    const html = readFileSync(reportPath, "utf8");
    const localValues = opts.localValues !== undefined ? opts.localValues : localUnmatchedValues(dirName, root);
    const { items, urls, urlsTotal, skippedLocal } = planChecks(html, { ...opts, localValues });
    const meta = { urlsTotal, skippedLocal, hasLocalData: localValues != null };
    if (!items.length) return { ...base, ok: true, ...meta, urlsFetched: 0 };
    const fetched = await fetchAll(urls, opts);
    const failed = [...fetched.values()].filter((r) => !r.ok).length;
    return {
      ...base, ok: true, ...classify(items, fetched), ...meta,
      urlsFetched: urls.length, urlsFailed: failed,
    };
  } catch (e) {
    return { ...base, error: e.message };
  }
}

// ========== 输出 ==========

// 措辞纪律（照搬 research-qc 的教训）：**「搜不到」一律叫「待质证」，不叫「错误」**。
// 块内可能挂了不止一条来源、页面可能有分页、数字可能以中文数词写出——机器判不了这些，
// 报成「错误」会诱导为了有所交代去改本来对的地方。
export function renderReport(r) {
  const L = [];
  L.push(`🔗 联网数字回链核验 · ${r.dir}`);
  if (!r.ok) {
    L.push(`  ⛔ 未跑完（${r.error || "未知原因"}）——按「未测」对待，别当通过`);
    return L.join("\n");
  }
  const total = r.confirmed.length + r.notFound.length + r.untested.length;
  if (!total) {
    L.push("  ○ 正文里没有「挂了外链的数字」可核（本检查只管数字与它所挂来源的配对）");
    return L.join("\n");
  }
  L.push(
    `  · 待核 ${total} 个联网数字，抓取来源 ${r.urlsFetched}/${r.urlsTotal} 条` +
      (r.urlsFailed ? `（${r.urlsFailed} 条没抓到）` : "")
  );
  L.push(
    r.hasLocalData
      ? `  · 另有 ${r.skippedLocal} 个数字能对回本地 data/，不属联网数字，归 research-qc 数字对账管`
      : "  ○ 本篇无 data/ 取数留档，无法先筛掉「本就取自本地取数」的数字——下面的待质证清单会偏多"
  );
  const exact = r.confirmed.filter((c) => !c.scaled).length;
  L.push(
    `  ✅ 已在所挂页面内找到：${r.confirmed.length} 个` +
      `（${exact} 个原样搜到，${r.confirmed.length - exact} 个按亿/万/千元口径换算后对上）`
  );
  if (r.power != null) {
    const pct = Math.round(r.power * 100);
    if (r.power < 0.4) {
      L.push(`    ⚠️ **本轮比对判别力弱（${pct}%）**：所挂页面数字太密（招股书/年报常见），容差窗里随便一个数都能碰上——「找到了」基本说明不了问题，**别当作已核过**，该核的照旧回一手来源核。`);
    } else if (r.power < 0.8) {
      L.push(`    · 本轮比对判别力中等（${pct}%）：能抓住大部分对不上的数，但漏网仍有，不替代人工核对。`);
    } else {
      L.push(`    · 本轮比对判别力 ${pct}%：挂错来源的数字基本跑不掉。`);
    }
  }
  if (r.notFound.length) {
    L.push(`  ⚠️  抓到了页面、却搜不到这个数字：${r.notFound.length} 个（**待质证，不是判错**）`);
    for (const it of r.notFound.slice(0, 15)) {
      L.push(`      - ${it.raw}${it.derived ? "（上下文自称推算得来）" : ""}　…${it.context}…`);
      L.push(`        所挂来源：${it.tried.join(" ｜ ")}`);
    }
    if (r.notFound.length > 15) L.push(`      - （另有 ${r.notFound.length - 15} 条，从略）`);
  } else {
    L.push("  ✅ 抓到的页面里，每个数字都搜到了");
  }
  if (r.untested.length) {
    L.push(`  ○ 未测（所挂来源一条都没抓到）：${r.untested.length} 个——不算通过，该核的照旧回一手来源核`);
    const why = new Map();
    for (const it of r.untested) for (const n of it.notes) {
      const k = (n.match(/（(.+)）$/) || [, n])[1];
      why.set(k, (why.get(k) || 0) + 1);
    }
    L.push(`      原因分布：${[...why.entries()].map(([k, v]) => `${k} ×${v}`).join("、")}`);
  }
  return L.join("\n");
}

// 喂给 Step 5.5 核验员②的定向质证清单。只出「抓到了却搜不到」那一档——已确认的不必再看，
// 没抓到的机器说不出所以然（交给核验员按常规流程抓）。无发现 → 空串，不硬造质证点。
export function renderChallenge(r) {
  if (!r || !r.ok || !r.notFound.length) return "";
  const L = ["【联网数字回链核验（机器已抓页面，下列数字在所挂来源里搜不到——请逐条质证）】"];
  L.push(
    `说明：机器把这些页面抓下来、用数字的多种写法（原样／千分位／亿万换算）搜过，均未命中。` +
      `可能是数字挂错了来源、口径被并错、或该数根本不在页内（2026-08-16 中际旭创那篇的三条硬错都是这个形态）；` +
      `也可能是页面分页、数字以中文数词写出等机器判不了的情况。**逐条回到来源确认，别直接改。**`
  );
  for (const it of r.notFound.slice(0, 25)) {
    L.push(
      `- 数字「${it.raw}」${it.derived ? "（上下文自称是推算得来的——那就核推算过程与被减数／被除数本身有没有来源）" : ""}` +
        `——上下文：…${it.context}…`
    );
    L.push(`  所挂来源：${it.tried.join(" ｜ ")}`);
  }
  if (r.notFound.length > 25) L.push(`- （另有 ${r.notFound.length - 25} 条，同类从略）`);
  return L.join("\n");
}

// ========== CLI ==========

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => (argv.indexOf(k) !== -1 ? argv[argv.indexOf(k) + 1] : d);
  const dir = arg("--dir");
  if (!dir) {
    console.error("用法：bun run scripts/check-web-numbers.js --dir <归档目录名> [--challenge]");
    process.exit(2);
  }
  const challenge = argv.includes("--challenge");
  const r = await verifyArchive(dir.replace(/\/+$/, "").replace(/^research\//, ""), {
    // --no-skip-local：连「能对回 data/ 的数字」也一起回链核（清单会变长，但能查出
    // 「数字本身有本地取数支撑、却挂了条不相干外链」这类平时被筛掉的问题）
    localValues: argv.includes("--no-skip-local") ? null : undefined,
    maxUrls: Number(arg("--max-urls", 60)),
    timeout: Number(arg("--timeout", 12)) * 1000,
    concurrency: Number(arg("--concurrency", 4)),
    onProgress: challenge ? undefined : (a, b) => process.stderr.write(`\r  抓取 ${a}/${b}…   `),
  });
  if (!challenge) process.stderr.write("\r                    \r");
  const out = challenge ? renderChallenge(r) : renderReport(r);
  if (out) console.log(out);
  // 永远 0 退出：本模块不是闸（见文件头）。
}

if (import.meta.main) await main();
