// services/runner/src/invite-watch-cli.js
// 新链接自检（跑在 Mac mini，由 scheduled-run.sh 每个 tick 顺带调用）：
// 拉 /people 授权列表 → 对比本地「已见」→ 新 token 逐条自检（主端点 /verify + 站点 + 备用域）
// → 邮件告知作者「✅ 可发 / ❌ 先别发」。首次运行只纳管存量、不发信（防对着老授权轰一轮）。
// 事件驱动、极低频（只有新增/换钥才发信），不需要限频。
import nodemailer from "nodemailer";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { splitInvites, nextSeenTokens, composeInviteReport } from "./invite-selftest.js";

const TIMEOUT_MS = 10_000;
const trim = (u) => (u || "").trim().replace(/\/+$/, "");

const primary = trim(process.env.RUNNER_WORKER_URL);
const fallback = trim(process.env.RUNNER_WORKER_FALLBACK_URL) || "https://searchx-intake.qiuyuanqr.workers.dev";
const site = trim(process.env.RUNNER_SITE_BASE) || "https://qiuyuanqr.github.io/searchX";
const subSecret = (process.env.RUNNER_SUB_SECRET || "").trim();
const smtpUser = (process.env.RUNNER_SMTP_USER || "").trim();
const smtpPass = (process.env.RUNNER_SMTP_PASS || "").trim();
const authorEmail = (process.env.RUNNER_AUTHOR_EMAIL || smtpUser).trim();

function stateFile() {
  return join(homedir(), "Library", "Application Support", "searchx-runner", "invites-seen.json");
}
function readSeen() {
  try {
    const d = JSON.parse(readFileSync(stateFile(), "utf8"));
    return Array.isArray(d.tokens) ? d.tokens : null;
  } catch { return null; }
}
function writeSeen(tokens) {
  mkdirSync(join(stateFile(), ".."), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify({ tokens }, null, 2));
}

async function fetchJson(url, headers = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers });
  return r.ok ? r.json() : null;
}

// 主备域轮流取授权列表：单边被墙不至于取不到
async function fetchPeople() {
  for (const base of [primary, fallback].filter(Boolean)) {
    try {
      const j = await fetchJson(base + "/people", { "x-sub-secret": subSecret });
      if (j && j.ok && Array.isArray(j.people)) return j.people;
    } catch {}
  }
  return null;
}

async function verifyOk(base, token) {
  try {
    const j = await fetchJson(`${base}/verify?k=${encodeURIComponent(token)}`);
    return !!(j && j.ok);
  } catch { return false; }
}
async function siteReachable() {
  try {
    const r = await fetch(site + "/", { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
    return r.status < 500;
  } catch { return false; }
}

if (!primary || !subSecret) {
  console.error("✗ 链接自检：缺 RUNNER_WORKER_URL / RUNNER_SUB_SECRET，跳过");
  process.exit(0);
}

const people = await fetchPeople();
if (!people) {
  console.log("链接自检：取授权列表失败（主备域均不通）——端点可达性由探活负责报警，本轮跳过");
  process.exit(0);
}

const seen = readSeen();
if (seen === null) {
  writeSeen(people.map((p) => p.token));
  console.log(`链接自检：首次运行，纳管存量 ${people.length} 条授权（不发信）`);
  process.exit(0);
}

const { fresh } = splitInvites(seen, people);
if (!fresh.length) {
  writeSeen(nextSeenTokens(people, [], seen)); // 无新增也重写：让被撤销的掉出「已见」
  console.log(`链接自检：无新增授权（现有 ${people.length} 条）`);
  process.exit(0);
}

if (!smtpUser || !smtpPass) {
  console.error(`✗ 链接自检：发现 ${fresh.length} 条新授权但缺 SMTP 配置，发不了通知（下个 tick 重试）`);
  process.exit(0);
}
const transport = nodemailer.createTransport({
  host: "smtp.gmail.com", port: 465, secure: true, auth: { user: smtpUser, pass: smtpPass },
});

const notified = [];
for (const person of fresh) {
  const [primaryOk, fallbackOk, siteOk] = await Promise.all([
    verifyOk(primary, person.token),
    verifyOk(fallback, person.token),
    siteReachable(),
  ]);
  const link = `${site}/?k=${encodeURIComponent(person.token)}`;
  const msg = composeInviteReport({ person, link, primaryOk, fallbackOk, siteOk, authorEmail, fromEmail: smtpUser });
  try {
    await transport.sendMail(msg);
    notified.push(person.token);
    console.log(`✉️ 链接自检${msg.pass ? "✅ 通过" : "❌ 未过"}，已通知作者：${person.email}`);
  } catch (e) {
    console.error(`✗ 链接自检通知发送失败（${person.email}，下个 tick 重试）：${e.message}`);
  }
}
writeSeen(nextSeenTokens(people, notified, seen));
