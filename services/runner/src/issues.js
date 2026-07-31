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
// 翻页取全：GitHub 每页最多 100 条，approved 队列若超过 100 条，不翻页会静默漏掉尾部、永不处理。
export async function listApprovedIssues({ owner, repo, token }, fetchImpl = fetch) {
  const perPage = 100;
  const all = [];
  for (let page = 1; ; page++) {
    const url = `${API}/repos/${owner}/${repo}/issues?state=open&labels=approved&per_page=${perPage}&page=${page}`;
    const res = await fetchImpl(url, { headers: ghHeaders(token) });
    if (!res.ok) {
      // 带上 status：上层（runner.js）据此区分 5xx 外部瞬时故障（防抖）vs 4xx 配置问题（立即报警）。
      const e = new Error(`list issues failed: ${res.status} ${await errText(res)}`.trim());
      e.status = res.status;
      throw e;
    }
    const arr = await res.json();
    all.push(...arr);
    if (arr.length < perPage) break; // 拿到的不足一整页 → 已是最后一页
  }
  return all
    .filter((it) => !it.pull_request)
    .map((it) => ({
      number: it.number,
      title: it.title,
      body: it.body || "",
      labels: (it.labels || []).map((l) => (typeof l === "string" ? l : l.name)),
    }))
    .filter((it) => it.labels.includes("approved") && !it.labels.includes("done"));
}

// 重查单条 Issue 的当前状态与标签。
// 用途：一轮 runner 串行处理整个队列、每条可能跑上几小时，而队列快照是开跑前一次性取的。
// 期间作者若撤了 approved 或关掉 Issue（发现题目有问题、提交者说不用了），对已在批次里的条目
// 完全无效——照样烧一次全力档研究。开跑前花一次便宜的 GET 挡住它。
// 取不到（网络故障等）时由调用方决定降级策略，绝不因为这个可选检查中断主流程。
export async function fetchIssueState({ owner, repo, token, number }, fetchImpl = fetch) {
  const url = `${API}/repos/${owner}/${repo}/issues/${number}`;
  const res = await fetchImpl(url, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`get issue failed: ${res.status} ${await errText(res)}`.trim());
  const it = await res.json();
  return {
    state: it.state,
    labels: (it.labels || []).map((l) => (typeof l === "string" ? l : l.name)),
  };
}

export async function addLabel({ owner, repo, token, number, label }, fetchImpl = fetch) {
  const url = `${API}/repos/${owner}/${repo}/issues/${number}/labels`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: ghHeaders(token),
    body: JSON.stringify({ labels: [label] }),
    // 贴标签效果幂等（贴一个已存在的标签是 no-op），网络抖动可安全重试；
    // 下面的发评论则不行——重试会在 Issue 下留重复评论，故不加这个标记。
    retrySafe: true,
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
