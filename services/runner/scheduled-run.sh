#!/bin/zsh
# searchX runner —— 定时无人值守包装（由 Mac mini 上的 LaunchAgent 调用）
#
# 这层包装只负责三件事：
#   1) 补 PATH —— launchd 拉起时 PATH 几乎是空的，否则找不到 ~/.bun/bin/bun、~/.local/bin/claude；
#   2) cd 到仓库根 —— runner 与 /research Step6 的 git push 都依赖正确 cwd；
#   3) 统一落日志 —— 方便手机/远程查看自动跑的结果。
# 并发互斥不在这里做：由 runner 本体的「全局单实例锁」负责（见 src/index.js），
# 这样无论定时器、手动 kickstart、还是直接 `bun run runner` 都共用同一把锁，绝不撞车。
# 只在 Mac mini 上由 LaunchAgent 加载；MacBook 即使同步到本脚本也不会自动跑（没装 plist）。
set -u

# 仓库根 = 本脚本所在的 services/runner/ 往上两级（与机器无关，便于两机通用）
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

LOG_DIR="$HOME/Library/Logs/searchx-runner"
LOG="$LOG_DIR/runner.log"
mkdir -p "$LOG_DIR"

# 关键：把 bun 与 claude 所在目录补进 PATH
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# 日志超 5MB 滚动一次，避免无限增长
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 5000000 ]; then mv -f "$LOG" "$LOG.1"; fi

cd "$REPO" 2>/dev/null || { echo "[$(ts)] 进不去仓库目录：$REPO" >> "$LOG"; exit 1; }

echo "[$(ts)] ──────── tick：尝试运行 runner @ $REPO" >> "$LOG"
bun run runner >> "$LOG" 2>&1
code=$?
echo "[$(ts)] ──────── 结束 (exit=$code)" >> "$LOG"
exit "$code"
