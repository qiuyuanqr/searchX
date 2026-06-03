// services/intake-worker/src/validate.js
const LIMITS = { title: 160, focus: 500, message: 1000, email: 254 };

const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

const sanitize = (s) =>
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();

export function validateSubmission(input, limits = LIMITS) {
  const get = (k) => (typeof input?.[k] === "string" ? input[k] : "");
  const title = get("title").trim();
  const focus = get("focus").trim();
  const message = get("message").trim();
  const email = get("email").trim();

  const errors = [];
  if (!title) errors.push("title_required");
  if (title.length > limits.title) errors.push("title_too_long");
  if (focus.length > limits.focus) errors.push("focus_too_long");
  if (message.length > limits.message) errors.push("message_too_long");
  if (!email) errors.push("email_required");
  else if (email.length > limits.email || !isEmail(email)) errors.push("email_invalid");

  const clean = {
    title: sanitize(title),
    focus: sanitize(focus),
    message: sanitize(message),
    email,
  };
  return { ok: errors.length === 0, errors, clean };
}
