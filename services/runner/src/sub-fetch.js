// services/runner/src/sub-fetch.js
// 经 Worker 只读端点取提交者真实邮箱（共享密钥头鉴权）。

export async function fetchSubmitterEmail({ workerUrl, secret, issueNumber }, fetchImpl = fetch) {
  const res = await fetchImpl(`${workerUrl}/sub/${issueNumber}`, {
    headers: { "x-sub-secret": secret },
  });
  if (!res.ok) throw new Error(`fetch submitter email failed: ${res.status}`);
  const data = await res.json();
  if (!data || !data.email) throw new Error("submitter email missing");
  return data.email;
}
