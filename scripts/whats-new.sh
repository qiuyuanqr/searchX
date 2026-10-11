#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────
# searchX · 开工简报：自上次开工以来，仓库里别人（另一个维护者 / 后台）改了什么
#
#   scripts/whats-new.sh claude          Claude 开工（.claude/settings.json 的 SessionStart 自动调）
#   scripts/whats-new.sh codex           Codex 开工（AGENTS.md 要求开工先跑）
#   scripts/whats-new.sh <谁> --peek     只看，不更新「已读到哪」的记号
#
# 两条独立通路，任何一条漏了另一条还在：
#   1. git 提交本身（谁、何时、动了哪些文件）——对方忘了写流水也看得到；
#   2. docs/CHANGES.md 顶部几条——提交里看不出来的东西（为什么改、验证到哪、
#      Mac mini 上不进 git 的服务/配置改动）。
#
# 「已读到哪」记在 .git/searchx-seen-<谁>，每个维护者各一份、不进仓库、不跨机器。
# 只读 git，不 fetch、不改工作区；拉取由 git-sync.sh pull 负责，本脚本排在它后面跑。
# ───────────────────────────────────────────────────────────────
set -o pipefail

WHO="${1:-}"
PEEK="${2:-}"
case "$WHO" in
  claude|codex) : ;;
  *) echo "[whats-new] 用法: whats-new.sh claude|codex [--peek]"; exit 0 ;;
esac

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" 2>/dev/null || exit 0
GIT_DIR="$(git rev-parse --absolute-git-dir 2>/dev/null)" || exit 0
MARK="$GIT_DIR/searchx-seen-$WHO"
HEAD_SHA="$(git rev-parse HEAD 2>/dev/null)" || exit 0

# 后台自动产生的提交（报告交付、Stocks 搬运、行情快照）只报数量，不逐条列。
NOISE='^research(\((stocks|series)\))?: '

echo "══ searchX 开工简报（$WHO）══"

# —— 同步状态：按最近一次 fetch 的结果算，落后/领先/未提交都要喊出来 ——
if git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
  AHEAD="$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)"
  BEHIND="$(git rev-list --count 'HEAD..@{u}' 2>/dev/null || echo 0)"
  [ "$BEHIND" != "0" ] && echo "⚠️ 本机落后远端 $BEHIND 个提交（开工拉取没成功？先 git pull --rebase 再动手）"
  [ "$AHEAD" != "0" ] && echo "⚠️ 本机有 $AHEAD 个提交没推上去——对方和 Mac mini 都还看不到"
fi
DIRTY="$(git -c core.quotePath=false status --porcelain 2>/dev/null | grep -c . || true)"
if [ "${DIRTY:-0}" != "0" ]; then
  echo "⚠️ 工作区有 $DIRTY 个未提交文件（可能是对方进行中的改动，别替它提交）："
  git -c core.quotePath=false status --porcelain 2>/dev/null | head -8 | sed 's/^/    /'
fi

# —— 提交：上次读到的位置 → HEAD；没有记号（第一次）或记号已不在历史里就看最近 7 天 ——
SEEN=""; [ -f "$MARK" ] && SEEN="$(tr -dc '0-9a-f' < "$MARK" 2>/dev/null)"
if [ -n "$SEEN" ] && git merge-base --is-ancestor "$SEEN" HEAD 2>/dev/null; then
  RANGE="$SEEN..HEAD"; SINCE=(); LABEL="自上次开工（$(git rev-parse --short "$SEEN")）以来"
else
  RANGE="HEAD"; SINCE=(--since='7 days ago'); LABEL="最近 7 天（首次运行或记号失效）"
fi

TOTAL="$(git rev-list --count "${SINCE[@]}" "$RANGE" 2>/dev/null || echo 0)"
AUTO="$(git log "${SINCE[@]}" --format='%s' "$RANGE" 2>/dev/null | grep -cE "$NOISE" || true)"
echo "── $LABEL：$TOTAL 个提交，其中后台自动产出 ${AUTO:-0} 个（报告/行情，不逐条列）"

SHOWN=0
while IFS= read -r sha; do
  [ -n "$sha" ] || continue
  subj="$(git log -1 --format='%s' "$sha")"
  printf '%s\n' "$subj" | grep -qE "$NOISE" && continue
  SHOWN=$((SHOWN + 1))
  if [ "$SHOWN" -gt 20 ]; then echo "  …更多提交略，自己跑 git log $RANGE"; break; fi
  body="$(git log -1 --format='%B' "$sha")"
  if   printf '%s' "$body" | grep -qiE '^Co-Authored-By: *Claude'; then tag="Claude"
  elif printf '%s' "$body" | grep -qiE '^(Agent|Co-Authored-By): *Codex'; then tag="Codex"
  elif printf '%s' "$subj" | grep -qE '^chore\(sync\)'; then tag="收工自动提交·没写说明"
  else tag="未署名"; fi
  echo "• $(git log -1 --format='%h %ad' --date=format:'%m-%d %H:%M' "$sha") [$tag] $subj"
  FILES="$(git -c core.quotePath=false show --format= --name-only "$sha" 2>/dev/null | grep -v '^$')"
  N="$(printf '%s\n' "$FILES" | grep -c . || true)"
  printf '%s\n' "$FILES" | head -8 | sed 's/^/    /'
  [ "${N:-0}" -gt 8 ] && echo "    …共 $N 个文件"
done < <(git rev-list "${SINCE[@]}" "$RANGE" 2>/dev/null)
[ "$SHOWN" = "0" ] && echo "  （没有人工改动）"

# —— 改动流水顶部：最新 3 条 ——
if [ -f docs/CHANGES.md ]; then
  echo "── docs/CHANGES.md 最新 3 条（更早的自己翻）"
  awk '/^## /{n++} n>=1 && n<=3' docs/CHANGES.md | head -60
fi
echo "══ 简报完。当前状态与待办看 HANDOFF.md；自己改完记得往 docs/CHANGES.md 顶部加一条 ══"

[ "$PEEK" = "--peek" ] || printf '%s\n' "$HEAD_SHA" > "$MARK" 2>/dev/null
exit 0
