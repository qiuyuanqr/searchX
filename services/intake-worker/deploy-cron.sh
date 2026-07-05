#!/bin/zsh
# searchX intake-worker —— 每小时兜底自动部署（仅在 wrangler 已登录的 MacBook 上加载）。
#
# 只做一件事：若本机 HEAD 里 services/intake-worker 的源码/配置自上次部署以来变了，
# 就 wrangler deploy；没变则秒退、不刷无意义 version。
#
# 刻意不主动 git pull —— 让 HEAD 保持最新是双机同步机制（two-machine-autosync）的职责，
# 各司其职、互不打架。worker 改动几乎都在 MacBook 上做+commit，本机 HEAD 天然最新。
# 只在装了 plist 的机器跑；Mac mini 同步到本脚本但没装 plist，不会跑（避免双机重复部署）。
set -u

# 仓库根 = 本脚本所在的 services/intake-worker/ 往上两级
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

LOG_DIR="$HOME/Library/Logs/searchx-worker-deploy"
LOG="$LOG_DIR/worker-deploy.log"
STAMP="$LOG_DIR/last-deployed.sha"     # 上次已部署的 worker commit（本机状态，不入库）
mkdir -p "$LOG_DIR"

# launchd 拉起时 PATH 几乎是空的，否则找不到 ~/.bun/bin/bun
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# 日志超 5MB 滚动一次
[ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 5000000 ] && mv -f "$LOG" "$LOG.1"

cd "$REPO" 2>/dev/null || { echo "[$(ts)] 进不去仓库：$REPO" >> "$LOG"; exit 1; }

# 影响 worker 产物的路径的最新 commit（src + wrangler.toml；dist 是构建产物，不算）
CUR="$(git log -1 --format=%H -- services/intake-worker/src services/intake-worker/wrangler.toml 2>/dev/null)"
[ -z "$CUR" ] && { echo "[$(ts)] 取不到 worker commit，跳过本轮" >> "$LOG"; exit 0; }

LAST="$(cat "$STAMP" 2>/dev/null || echo '')"
[ "$CUR" = "$LAST" ] && exit 0          # intake-worker 无变化，秒退

echo "[$(ts)] intake-worker 有变化（${CUR:0:9}），开始 wrangler deploy" >> "$LOG"
cd services/intake-worker || exit 1
if bun x wrangler deploy >> "$LOG" 2>&1; then
  echo "$CUR" > "$STAMP"
  echo "[$(ts)] ✓ 部署成功（$CUR）" >> "$LOG"
else
  echo "[$(ts)] ✗ 部署失败——不落 stamp，下轮自动重试" >> "$LOG"
fi
