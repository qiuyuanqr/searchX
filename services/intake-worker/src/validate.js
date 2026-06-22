// services/intake-worker/src/validate.js
const LIMITS = { title: 160, focus: 500, message: 1000 };

// 提示注入初筛：只挑"高信号"特征，命中只作红旗（不拦提交）——研究内容会喂给全权限 headless
// claude，审批人看到红旗就能逐字核对，避免被藏在侧重点里的"忽略以上指令/执行某命令"骗过。
// 故意从严克制、少误报（误报多了等于狼来了，红旗会被无视）。返回中文标签数组（去重）。
const INJECTION_PATTERNS = [
  { label: "疑似指令覆盖（忽略以上指令 / ignore previous）",
    re: /(ignore|disregard|forget)\b[^.\n]{0,24}\b(previous|above|prior|earlier|instruction|system\s*prompt)|(忽略|无视|忘记|忘掉)(以上|上述|之前|前面|先前|刚才)[^。\n]{0,8}(指令|提示|规则|要求|设定|命令)/i },
  { label: "疑似对话角色标记（system:/assistant:）",
    re: /^[ \t>]*(system|assistant|developer)\s*[:：]/im },
  { label: "shell 命令执行特征（curl|sh / rm -rf / $() / sudo）",
    re: /\brm\s+-rf\b|\b(curl|wget)\b[^\n]{0,40}\|\s*(sh|bash)\b|\|\s*(sh|bash)\b|\bsudo\b|\$\([^)]/i },
  { label: "代码围栏（```）", re: /```/ },
  { label: "脚本/JS 注入（<script / javascript:）", re: /<\s*script|javascript:/i },
  { label: "敏感路径（../ 或 /etc/ 或 ~/.ssh 或 .env）", re: /\.\.\/|\/etc\/|~\/\.ssh|(^|[^\w.])\.env\b/i },
  { label: "敏感字样（process.env / api key / 私钥）", re: /process\.env|\bapi[_-]?key\b|私钥/i },
];

export function screenSubmission(clean) {
  const flags = new Set();
  const blob = [clean.title, clean.focus, clean.message].filter(Boolean).join("\n");
  for (const p of INJECTION_PATTERNS) if (p.re.test(blob)) flags.add(p.label);
  if (/https?:\/\//i.test(clean.title || "")) flags.add("题目里出现网址");
  return [...flags];
}

const sanitize = (s) =>
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();

// 只校验内容（题目/侧重点/留言）。邮箱不再来自表单——由提交链接里的 token 反查得到，
// 故这里不收、不校验 email，杜绝用户在表单里冒充他人或往邮箱字段塞注入。
export function validateContent(input, limits = LIMITS) {
  const get = (k) => (typeof input?.[k] === "string" ? input[k] : "");
  const title = get("title").trim();
  const focus = get("focus").trim();
  const message = get("message").trim();

  const errors = [];
  if (!title) errors.push("title_required");
  if (title.length > limits.title) errors.push("title_too_long");
  if (focus.length > limits.focus) errors.push("focus_too_long");
  if (message.length > limits.message) errors.push("message_too_long");

  const clean = {
    title: sanitize(title),
    focus: sanitize(focus),
    message: sanitize(message),
  };
  // flags 始终计算（不影响 ok）：作为放行前的红旗，命中则降级人工复核。
  return { ok: errors.length === 0, errors, clean, flags: screenSubmission(clean) };
}
