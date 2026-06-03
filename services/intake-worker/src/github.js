// services/intake-worker/src/github.js
export async function createIssue(
  { owner, repo, token, title, body, labels, assignees },
  fetchImpl = fetch
) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "searchx-intake",
    },
    body: JSON.stringify({ title, body, labels, assignees }),
  });
  if (!res.ok) {
    const error = await res.text().catch(() => "");
    return { ok: false, status: res.status, error };
  }
  const data = await res.json();
  return { ok: true, number: data.number, url: data.html_url };
}
