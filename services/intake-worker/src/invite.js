// services/intake-worker/src/invite.js
// token 生成 + 白名单 KV 读写。纯逻辑，注入 kv / now / gen，离线可测。
// 双向键：invite:<token>→email（提交时 O(1) 反查）、allow:<encEmail>→{token,addedAt}（列表/撤销）。
// 永不过期：put 不带 TTL；唯一失效途径是 revoke / rotate。
export function genToken(rand = (arr) => crypto.getRandomValues(arr)) {
  const a = new Uint8Array(16);
  rand(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const inviteKey = (token) => `invite:${token}`;
export const allowKey = (email) => `allow:${encodeURIComponent(email)}`;

// 容错解析 allow:* 值：损坏（非法 JSON）返回 null，绝不抛出。
// 纵深防御——不假设 KV 数据一定干净（如控制台误改/未来其它写入路径），
// 单条坏数据不该让整张授权列表或某次撤销崩成 500。
function parseAllow(raw) {
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" && typeof o.token === "string" ? o : null;
  } catch {
    return null;
  }
}

export async function emailForToken(kv, token) {
  if (!token) return null;
  return (await kv.get(inviteKey(token))) || null;
}

export async function mintInvite(kv, email, { now = Date.now, gen = genToken } = {}) {
  const existing = await kv.get(allowKey(email));
  const parsed = existing && parseAllow(existing);
  if (parsed) {
    // 自愈半写：invite 生效键若缺失（下方写序的失败半写、或控制台误删），幂等补写——
    // 保证 allow 追踪到的 token 一定可用，重试一次 mint 即恢复。
    await kv.put(inviteKey(parsed.token), email);
    return { email, token: parsed.token, addedAt: parsed.addedAt };
  }
  // 无记录或记录损坏 → 重新铸一个有效的（自愈，覆盖坏数据）。
  const token = gen();
  const addedAt = now();
  // 写序有讲究：先写 allow（追踪键）再写 invite（生效键）。两键不原子，中途失败留下的
  // 是「被追踪但尚未生效」的半写（重试 mint 走上面的自愈补写即修复），而不是反序会产生的
  // 「已生效却不被任何列表追踪、revoke/rotate 都够不着」的孤儿 token。
  await kv.put(allowKey(email), JSON.stringify({ token, addedAt }));
  await kv.put(inviteKey(token), email);
  const idx = (await readEmailIndex(kv)) || (await rebuildEmailIndex(kv));
  if (!idx.includes(email)) await writeEmailIndex(kv, [...idx, email]);
  return { email, token, addedAt };
}

// 授权邮箱索引键：把「列名单」从 list 降级成一次 read。
// /people 被 runner 每 5 分钟一 tick 的新链接自检调用（约 288 次/天），全表 list 会吃掉
// 免费版 list 日额度（约 1000/天）的近三成——正是 2026-07-06 打爆过额度的同一模式。
// 索引只存邮箱清单，token/addedAt 仍逐条 read（授权名单是个位数规模，read 额度充裕）。
const IDX_KEY = "allow:idx";

async function readEmailIndex(kv) {
  try {
    const raw = await kv.get(IDX_KEY);
    const p = raw ? JSON.parse(raw) : null;
    return Array.isArray(p) ? p.filter((x) => typeof x === "string") : null;
  } catch { return null; }
}

async function writeEmailIndex(kv, emails) {
  try { await kv.put(IDX_KEY, JSON.stringify([...new Set(emails)])); } catch {}
}

// 用一次全表 list 重建邮箱索引（仅索引缺失时走）。
async function rebuildEmailIndex(kv) {
  // list 不可用（额度耗尽 / 调用方注入的极简 kv）时降级为空清单，绝不抛错拖成 500——
  // 授权列表少列几个人远好过整个端点崩掉，且下一次 mint 会把索引补回来。
  let keys = [];
  try { ({ keys = [] } = await kv.list({ prefix: "allow:" })); } catch { return []; }
  const emails = keys
    .map(({ name }) => name)
    .filter((name) => name !== IDX_KEY)
    .map((name) => decodeURIComponent(name.slice("allow:".length)));
  await writeEmailIndex(kv, emails);
  return emails;
}

export async function listPeople(kv) {
  let emails = await readEmailIndex(kv);
  if (!emails) emails = await rebuildEmailIndex(kv);   // 无索引（首次/被清）→ 重建一次
  const out = [];
  for (const email of emails) {
    const raw = await kv.get(allowKey(email));
    if (!raw) continue;                                 // 索引滞后于删除 → 跳过
    const parsed = parseAllow(raw);
    if (!parsed) continue;                              // 跳过损坏条目，不拖垮整列表
    out.push({ email, token: parsed.token, addedAt: parsed.addedAt });
  }
  return out;
}

export async function revoke(kv, email) {
  const raw = await kv.get(allowKey(email));
  if (!raw) return false;
  const parsed = parseAllow(raw);
  if (parsed) await kv.delete(inviteKey(parsed.token)); // 能解析出 token 才删对应 invite 键
  // 穷尽清理：并发/重试的重复 mint 或历史半写可能留下 allow 记录之外的孤儿 invite token
  //（listPeople 看不见、上面按记录删也够不着，却仍然有效）。按前缀扫一遍，把指向该邮箱的
  // invite 键全部删掉，保证「撤销」语义彻底。授权名单是个位数规模，全量扫描代价可忽略
  //（KV list 单页 1000 条，远未触及分页）。
  const { keys } = await kv.list({ prefix: "invite:" });
  for (const { name } of keys) {
    if ((await kv.get(name)) === email) await kv.delete(name);
  }
  await kv.delete(allowKey(email));                      // 无论是否损坏，都清掉 allow 记录
  const idx = await readEmailIndex(kv);
  if (idx) await writeEmailIndex(kv, idx.filter((e) => e !== email));
  return true;
}

export async function rotate(kv, email, deps = {}) {
  const existed = await revoke(kv, email);
  if (!existed) return null;
  return mintInvite(kv, email, deps);
}
