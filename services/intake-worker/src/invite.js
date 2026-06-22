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

export async function emailForToken(kv, token) {
  if (!token) return null;
  return (await kv.get(inviteKey(token))) || null;
}

export async function mintInvite(kv, email, { now = Date.now, gen = genToken } = {}) {
  const existing = await kv.get(allowKey(email));
  if (existing) {
    const { token, addedAt } = JSON.parse(existing);
    return { email, token, addedAt };
  }
  const token = gen();
  const addedAt = now();
  await kv.put(inviteKey(token), email);
  await kv.put(allowKey(email), JSON.stringify({ token, addedAt }));
  return { email, token, addedAt };
}

export async function listPeople(kv) {
  const { keys } = await kv.list({ prefix: "allow:" });
  const out = [];
  for (const { name } of keys) {
    const raw = await kv.get(name);
    if (!raw) continue;
    const { token, addedAt } = JSON.parse(raw);
    out.push({ email: decodeURIComponent(name.slice("allow:".length)), token, addedAt });
  }
  return out;
}

export async function revoke(kv, email) {
  const raw = await kv.get(allowKey(email));
  if (!raw) return false;
  const { token } = JSON.parse(raw);
  await kv.delete(inviteKey(token));
  await kv.delete(allowKey(email));
  return true;
}

export async function rotate(kv, email, deps = {}) {
  const existed = await revoke(kv, email);
  if (!existed) return null;
  return mintInvite(kv, email, deps);
}
