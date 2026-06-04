#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────
# searchX · Mac mini 定时自动拉（由 com.searchx.autopull LaunchAgent 周期调用）
#
# 目的：让常驻的 Mac mini 不必开 Claude 窗口、也不必人工，就能持续把另一台
#       （及 runner 自己、GitHub 网页）push 的进度自动拉下来。源无关：谁推都拉。
#
# 这层包装只负责四件事，真正的同步与安全全交给 git-sync.sh：
#   1) 补 PATH —— launchd 拉起时 PATH 几乎为空，git 在 /usr/bin；
#   2) cd 到仓库根（与机器无关，从脚本位置推导）；
#   3) 自锁 —— 上一轮没跑完（网络挂住）就跳过本轮，不叠跑；
#   4) 静默日志 —— 只在"真的拉到东西"或"告警"时记一行，"已是最新"不记，防膨胀。
#
# 复用的安全（全在 git-sync.sh）：runner 锁互斥（runner 写工作树时跳过同步）、
#   autostash、冲突立即 rebase --abort 回滚、安全闸（仅本人仓库才动）、无网静默跳过。
# 只在 Mac mini 上由 LaunchAgent 加载；MacBook 即使同步到本脚本也不会自动跑（没装 plist）。
# ───────────────────────────────────────────────────────────────
set -o pipefail
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="$HOME/Library/Logs/searchx-runner"
LOG="$LOG_DIR/autopull.log"
LOCK="/tmp/searchx-autopull.lock"
mkdir -p "$LOG_DIR"

ts(){ date '+%Y-%m-%d %H:%M:%S'; }

# —— 自锁：拿不到锁＝上一轮还在跑 → 跳过本轮。锁超 10 分钟视作残留，清掉重拿 ——
if ! mkdir "$LOCK" 2>/dev/null; then
  age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || date +%s) ))
  if [ "$age" -gt 600 ]; then rmdir "$LOCK" 2>/dev/null; mkdir "$LOCK" 2>/dev/null || exit 0
  else exit 0; fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

cd "$REPO" 2>/dev/null || exit 0

# 日志超 2MB 滚动一次
[ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt 2000000 ] && mv -f "$LOG" "$LOG.1"

# 捕获并剥掉 ANSI 颜色码（git-sync.sh 输出带色，日志只要纯文本）
OUT="$(bash "$REPO/.claude/hooks/git-sync.sh" pull 2>&1 | sed $'s/\033\\[[0-9;]*m//g')"
# 只在"已拉取/告警"时落日志；"已是最新"忽略
if printf '%s' "$OUT" | grep -qE '已拉取|⚠'; then
  printf '[%s] %s\n' "$(ts)" "$OUT" >> "$LOG"
fi
exit 0
