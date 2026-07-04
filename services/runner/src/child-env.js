// services/runner/src/child-env.js
// claude 子进程的环境装配，research runner 与 check-runner 共用。
// - 剥掉 RUNNER_* 与 CHECK_RUNNER_* 两组机密（PAT / SMTP 密码 / 共享密钥）：子会话跑在
//   bypassPermissions 下且直接消化外部内容，这些凭据它一概不需要。语义防线（分隔线注入
//   边界）挡不住一条 Bash `env`，剥干净环境才是这层防御的全部——两组前缀必须一起剥，
//   两个 runner 按 README 共用仓库根同一个 .env，只剥自己那组等于把另一组白送。
// - 打哨兵 SEARCHX_IN_RUNNER=1：git-sync 钩子在子会话的 SessionStart/SessionEnd 里据此
//   跳过自动 pull/push，避免把 runner 期间的脏工作树（含被 park 隔离的报告草稿）推上公开仓。
export function buildChildEnv(env) {
  const childEnv = { ...env, SEARCHX_IN_RUNNER: "1" };
  for (const k of Object.keys(childEnv)) {
    if (k.startsWith("RUNNER_") || k.startsWith("CHECK_RUNNER_")) delete childEnv[k];
  }
  return childEnv;
}
