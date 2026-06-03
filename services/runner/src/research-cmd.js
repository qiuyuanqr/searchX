// services/runner/src/research-cmd.js
// 拼给本机 Claude Code 跑的 /research 命令。
// 所有请求一律走全力档（用户决定）：不注入任何收敛标记，跑完整调研。

export function buildResearchPrompt({ topic, focus }) {
  const t = String(topic || "").trim();
  const f = String(focus || "").trim();
  return f ? `/research ${t} | ${f}` : `/research ${t}`;
}
