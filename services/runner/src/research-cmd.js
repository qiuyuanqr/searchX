// services/runner/src/research-cmd.js
// 拼给本机 Claude Code 跑的 /research 命令。
// 朋友请求默认走「轻量档」：末尾注入 [轻量]，SKILL Step 0 据此收敛检索/规模。

export function buildResearchPrompt({ topic, focus }) {
  const t = String(topic || "").trim();
  const f = String(focus || "").trim();
  const head = f ? `/research ${t} | ${f}` : `/research ${t}`;
  return `${head} [轻量]`;
}
