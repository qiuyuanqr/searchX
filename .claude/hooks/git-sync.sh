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

# —— 安全闸：必须是本人的仓库 ——
ORIGIN="$(git remote get-url origin 2>/dev/null || true)"
case "$ORIGIN" in
  *qiuyuanqr/searchX*) : ;;
  *) exit 0 ;;
esac

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
      ok "已拉取并 rebase $behind 个提交（$BRANCH @ $(git rev-parse --short HEAD)）"
    else
      git rebase --abort >/dev/null 2>&1
      warn "⚠️ 拉取冲突，已回滚到拉取前状态。请手动 git pull --rebase 解决后再继续。"
    fi
    ;;

  push)
    # 1) 有未提交改动 → 自动提交
    if [ -n "$(git status --porcelain)" ]; then
      git add -A
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
    else
      warn "⚠️ 推送失败（鉴权/网络？）。改动已本地提交，下次收工自动补推。"
    fi
    ;;

  *)
    echo "[git-sync] 用法: git-sync.sh pull|push"; exit 0 ;;
esac
exit 0
