#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────
# searchX · 两台机 git 自动同步（开发机 ⇄ 服务器）
# 由 Claude Code hooks 调用（见 .claude/settings.json）：
#   SessionStart(startup|resume) → git-sync.sh pull   开工前拉取另一台进度
#   SessionEnd                   → git-sync.sh push   收工：未提交改动自动提交后推
#
# 设计铁律：
#   1. 永不 force-push。
#   2. 任何冲突立即 rebase --abort 回滚到干净状态，大声报警，绝不留半残。
#   3. 脏工作区也安全（pull/rebase 一律 --autostash）。
#   4. 安全闸：仅当 origin 是本人仓库才动作（公开仓库被 clone 后自动空转）。
#   5. 没网 / 无上游 / 游离 HEAD → 静默跳过；改动至少已本地提交，下次补推。
# ───────────────────────────────────────────────────────────────
set -o pipefail

MODE="${1:-}"
REPO="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO" 2>/dev/null || { echo "[git-sync] 找不到仓库目录，跳过"; exit 0; }

warn(){ printf "\033[33m[git-sync] %s\033[0m\n" "$1"; }
ok(){   printf "\033[32m[git-sync] %s\033[0m\n" "$1"; }

# —— 即时通知对端拉取（仅 MacBook→Mac mini 方向；best-effort，绝不阻塞收工）——
# 自我识别：只有本机 ssh 配了别名 mac-mini→stocks 时才触发（Mac mini 无指向自己的别名，
# 故不会自 ping、不会反向回环）。对端睡眠/离线就静默跳过——它的定时自动拉 autopull 会补上。
# 触发的是对端的 pull 分支（不再 push），无递归。反向 mini→MacBook 仍靠 MacBook 的 SessionStart 拉。
notify_peer(){
  command -v ssh >/dev/null 2>&1 || return 0
  ssh -G mac-mini 2>/dev/null | grep -qiE '^hostname[[:space:]]+stocks$' || return 0
  if ssh -o ConnectTimeout=5 -o BatchMode=yes mac-mini \
       'bash /Users/yangqiuyuan/Coding/searchX/.claude/hooks/git-sync.sh pull' >/dev/null 2>&1; then
    ok "已即时通知 Mac mini 同步"
  else
    warn "Mac mini 没连上（睡眠/离线？）——改动已推 GitHub，其定时自动拉会补上"
  fi
}

# —— 安全闸：必须是本人的仓库 ——
ORIGIN="$(git remote get-url origin 2>/dev/null || true)"
case "$ORIGIN" in
  *qiuyuanqr/searchX*) : ;;
  *) exit 0 ;;
esac

# —— 与定时 runner 互斥：runner 跑研究期间不插手 git，避免三方并发写同一工作树 ——
# 1) 本会话若就是 runner spawn 出来的研究子进程（带哨兵）→ 直接跳过，别让会话级 pull/push
#    与 /research Step6 的 push 打架。
[ -n "${SEARCHX_IN_RUNNER:-}" ] && exit 0
# 2) 别的会话同步时，若 runner 正持锁跑研究 → 也跳过（同步可跳过、下次补，不丢活）。
RUNNER_LOCK="$HOME/Library/Application Support/searchx-runner/runner.lock"
if [ -f "$RUNNER_LOCK" ]; then
  LPID="$(tr -dc '0-9' < "$RUNNER_LOCK" 2>/dev/null)"
  # pid 有限会被 OS 回收复用：断电残留锁若正好被复用给别的常驻进程（甚至常驻 root 进程），
  # kill -0 会一直"判活"，没有年龄兜底就永久静默跳过同步。6 小时远大于一次研究批次最长可能
  # 占锁的时长（claude 超时默认 3h + push 余量），真在跑的合法长批次锁龄够不到这个上限。
  LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$RUNNER_LOCK" 2>/dev/null || date +%s) ))
  if [ -n "$LPID" ] && [ "$LOCK_AGE" -lt 21600 ] && kill -0 "$LPID" 2>/dev/null; then
    warn "runner 正在跑研究（pid=$LPID），本次 git 同步跳过（避免并发冲突，下次收工补）。"
    exit 0
  fi
fi

# —— 必须在某个分支上、且有上游 ——
BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || true)"
[ -n "$BRANCH" ] || { warn "处于游离 HEAD，跳过"; exit 0; }
git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1 \
  || { warn "分支 $BRANCH 无上游，跳过"; exit 0; }

case "$MODE" in
  pull)
    git fetch --quiet origin "$BRANCH" 2>/dev/null || { warn "fetch 失败（没网？），跳过拉取"; exit 0; }
    behind="$(git rev-list --count "HEAD..@{u}" 2>/dev/null || echo 0)"
    if [ "$behind" = "0" ]; then ok "已是最新（$BRANCH @ $(git rev-parse --short HEAD)）"; exit 0; fi
    if git pull --rebase --autostash --no-edit --quiet >/dev/null 2>&1; then
      # 关键：autostash 弹回可能在 rebase 成功**之后**才冲突 → 整条命令退出码仍是 0，
      # 但工作区残留 <<<<<<< 冲突标记、index 出现未合并条目。若不显式拦下，收工的
      # git add -A 会把冲突标记提交并推上公开仓，本地真实改动则困死在孤儿 stash 里。
      if [ -n "$(git ls-files -u 2>/dev/null)" ]; then
        git reset --hard HEAD >/dev/null 2>&1   # 丢弃弹回冲突残留；你的改动仍安全保存在 git stash
        warn "⚠️ 拉取后 autostash 弹回冲突：已恢复干净工作区。你的本地改动安全保留在 git stash（用 git stash list 查看、手动 git stash pop 解决）。先别收工，以免误提交冲突标记。"
        exit 0
      fi
      ok "已拉取并 rebase $behind 个提交（$BRANCH @ $(git rev-parse --short HEAD)）"
    else
      git rebase --abort >/dev/null 2>&1
      warn "⚠️ 拉取冲突，已回滚到拉取前状态。请手动 git pull --rebase 解决后再继续。"
    fi
    ;;

  push)
    # 1) 有未提交改动 → 自动提交（提交前两道终检闸）
    if [ -n "$(git status --porcelain)" ]; then
      git add -A
      # 闸1：暂存内容含 git 冲突标记 → 中止（多为 autostash/rebase 残留被误纳入，防其推上公开仓）
      if git diff --cached -U0 2>/dev/null | grep -qE '^\+(<{7}|={7}|>{7})([ \t]|$)'; then
        git reset -q >/dev/null 2>&1
        warn "⚠️ 暂存区检测到冲突标记（<<<<<<< / ======= / >>>>>>>），已取消本次自动提交。请手动 git diff 检查解决后再收工。"
        exit 0
      fi
      # 闸2：暂存文件名命中机密/敏感模式 → 中止（公开仓库，绝不自动提交机密/临时密钥）
      SENSITIVE="$(git diff --cached --name-only 2>/dev/null | grep -iE '(^|/)\.env($|\.)|\.(pem|key|p12|pfx|keystore)$|(^|/)(secret|secrets|credential|credentials|token)([._-]|$)|持仓|holding' || true)"
      if [ -n "$SENSITIVE" ]; then
        git reset -q >/dev/null 2>&1
        warn "⚠️ 暂存区出现疑似机密/敏感文件，已取消自动提交，避免推上公开仓："
        printf '%s\n' "$SENSITIVE" | sed 's/^/      /'
        warn "请确认后处理（如需忽略加入 .gitignore），再手动提交。"
        exit 0
      fi
      HOST="$(hostname -s 2>/dev/null || echo unknown)"
      STAMP="$(date '+%Y-%m-%d %H:%M')"
      if git commit --quiet -m "chore(sync): 自动同步 · ${HOST} · ${STAMP}"; then
        ok "已自动提交未保存改动"
      fi
    fi
    # 2) 远程若已前进，先 rebase 再推（避免 non-fast-forward）
    git fetch --quiet origin "$BRANCH" 2>/dev/null || { warn "fetch 失败（没网？），改动已本地提交，下次收工补推"; exit 0; }
    behind="$(git rev-list --count "HEAD..@{u}" 2>/dev/null || echo 0)"
    if [ "$behind" != "0" ]; then
      if ! git rebase --autostash --quiet "@{u}" >/dev/null 2>&1; then
        git rebase --abort >/dev/null 2>&1
        warn "⚠️ 推送前同步远程时冲突，已回滚。改动已本地提交，请手动解决后 git push。"
        exit 0
      fi
    fi
    # 3) 有领先提交才推
    ahead="$(git rev-list --count "@{u}..HEAD" 2>/dev/null || echo 0)"
    if [ "$ahead" = "0" ]; then ok "无待推送提交"; exit 0; fi
    if git push --quiet origin "$BRANCH" 2>/dev/null; then
      ok "已推送 $ahead 个提交到 origin/$BRANCH"
      notify_peer
    else
      warn "⚠️ 推送失败（鉴权/网络？）。改动已本地提交，下次收工自动补推。"
    fi
    ;;

  *)
    echo "[git-sync] 用法: git-sync.sh pull|push"; exit 0 ;;
esac
exit 0
