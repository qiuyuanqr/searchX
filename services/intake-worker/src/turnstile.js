// services/intake-worker/src/turnstile.js
const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(token, secret, remoteip, fetchImpl = fetch) {
  if (!token) return false;
  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (remoteip) form.set("remoteip", remoteip);

  const res = await fetchImpl(VERIFY_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) return false;
  const data = await res.json();
  return data.success === true;
}
