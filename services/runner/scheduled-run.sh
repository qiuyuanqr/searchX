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

# 墙内视角探活（站点 + Worker 主备端点，各 10s 超时）：海外的 probe.yml 测不到墙内
# SNI 阻断，只有这台机器测得到。失败会给作者发限频报警邮件（同类 6 小时最多一封）。
# 探活自身出错不拦 runner——监控挂了不能连累主链路。
bun services/runner/src/probe-cli.js >> "$LOG" 2>&1 || true

# 新链接自检：发现新增/换钥授权 → 自动验证 → 邮件告知作者「可发 / 先别发」。
bun services/runner/src/invite-watch-cli.js >> "$LOG" 2>&1 || true

bun run runner >> "$LOG" 2>&1
code=$?
echo "[$(ts)] ──────── 结束 (exit=$code)" >> "$LOG"

# runner 真失败才报警（跳过/空队列都是 exit 0）：失败不能只躺在这份没人看的日志里。
# 常见失败=研究未产出，会被下个 tick 自动重跑；报警是让作者知道「在烧额度重试」，可及时人工介入。
if [ "$code" -ne 0 ]; then
  bun services/runner/src/alert-cli.js runner-failed "定时 runner 退出码 $code，日志：$LOG" >> "$LOG" 2>&1 || true
fi
exit "$code"
