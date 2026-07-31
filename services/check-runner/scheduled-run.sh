#!/bin/zsh
# searchX check-runner —— 定时无人值守包装（由 Mac mini 上的 LaunchAgent 调用）
#
# 这层包装只负责三件事：
#   1) 补 PATH —— launchd 拉起时 PATH 几乎是空的，否则找不到 ~/.bun/bin/bun、~/.local/bin/claude；
#   2) cd 到仓库根 —— check-runner 入口用到 services/runner/src/email.js（相对路径）；
#   3) 统一落日志 —— 方便手机/远程查看自动跑的结果。
# 并发互斥不在这里做：由 runner 本体的「全局单实例锁」负责（见 src/index.js）。
# 只在 Mac mini 上由 LaunchAgent 加载；MacBook 即使同步到本脚本也不会自动跑（没装 plist）。
set -u

# 仓库根 = 本脚本所在的 services/check-runner/ 往上两级
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

LOG_DIR="$HOME/Library/Logs/searchx-check-runner"
LOG="$LOG_DIR/check-runner.log"
mkdir -p "$LOG_DIR"

export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# 日志超 5MB 滚动一次
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 5000000 ]; then mv -f "$LOG" "$LOG.1"; fi

cd "$REPO" 2>/dev/null || { echo "[$(ts)] 进不去仓库目录：$REPO" >> "$LOG"; exit 1; }

echo "[$(ts)] ──────── tick：尝试运行 check-runner @ $REPO" >> "$LOG"
bun run check-runner >> "$LOG" 2>&1
code=$?
echo "[$(ts)] ──────── 结束 (exit=$code)" >> "$LOG"

# —— 持续失败要报警（对齐 research runner 的运维约定）——
# 没有这个，密钥单边轮换（/check/pending 静默 401）或 claude 不在 PATH 这类故障会每 5 分钟
# 失败一次、只写进这份没人看的日志：手机上提交的核查任务一直显示 pending，7 天后随 KV TTL
# 静默消失，全程零信号。
# 防抖：连续 STREAK_MAX 个 tick 都失败才发（单次网络抖动不打扰），alert-cli 自身再限频 6 小时一封。
STREAK_FILE="$HOME/Library/Application Support/searchx-check-runner/fail-streak"
STREAK_MAX=3
mkdir -p "$(dirname "$STREAK_FILE")"
if [ "$code" -ne 0 ]; then
  streak=$(( $(tr -dc '0-9' < "$STREAK_FILE" 2>/dev/null || echo 0) + 1 ))
  echo "$streak" > "$STREAK_FILE"
  if [ "$streak" -ge "$STREAK_MAX" ]; then
    echo "[$(ts)] 连续 $streak 个 tick 失败，发报警" >> "$LOG"
    bun services/runner/src/alert-cli.js check-runner-failed \
      "定时 check-runner 连续 $streak 次退出码非 0（本次 $code），日志：$LOG" >> "$LOG" 2>&1 || true
  else
    echo "[$(ts)] 失败第 $streak/$STREAK_MAX 次，先不报警（防瞬时抖动）" >> "$LOG"
  fi
else
  echo 0 > "$STREAK_FILE"
fi
exit "$code"
