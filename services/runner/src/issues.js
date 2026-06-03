// services/runner/src/issues.js
// GitHub REST 封装（注入 fetch，离线可测）。用作者 fine-grained PAT（Issues 读写）。

const API = "https://api.github.com";
const ghHeaders = (token) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "content-type": "application/json",
  "user-agent": "searchx-runner",
});

// 非 2xx 时尽量带上 GitHub 返回的错误正文，便于排查（如 PAT scope 不足）。
// 守卫 typeof：单测的假响应没有 text() 方法时退化为空串。
const errText = async (res) =>
  typeof res.text === "function" ? await res.text().catch(() => "") : "";

// 取 approved 且未 done 的开放 Issue（排除 PR）。
export async function listApprovedIssues({ owner, repo, token }, fetchImpl = fetch) {
  const url = `${API}/repos/${owner}/${repo}/issues?state=open&labels=approved&per_page=100`;
  const res = await fetchImpl(url, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`list issues failed: ${res.status} ${await errText(res)}`.trim());
  const arr = await res.json();
  return arr
    .filter((it) => !it.pull_request)
    .map((it) => ({
      number: it.number,
      title: it.title,
      body: it.body || "",
      labels: (it.labels || []).map((l) => (typeof l === "string" ? l : l.name)),
    }))
    .filter((it) => it.labels.includes("approved") && !it.labels.includes("done"));
}

export async function addLabel({ owner, repo, token, number, label }, fetchImpl = fetch) {
  const url = `${API}/repos/${owner}/${repo}/issues/${number}/labels`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: ghHeaders(token),
    body: JSON.stringify({ labels: [label] }),
  });
  if (!res.ok) throw new Error(`add label failed: ${res.status} ${await errText(res)}`.trim());
  return true;
}

export async function commentIssue({ owner, repo, token, number, body }, fetchImpl = fetch) {
  const url = `${API}/repos/${owner}/${repo}/issues/${number}/comments`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: ghHeaders(token),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`comment failed: ${res.status} ${await errText(res)}`.trim());
  return true;
}
