#!/bin/zsh
# searchX intake-worker —— 自动部署（仅在常驻的 Mac mini 上加载；MacBook 是笔记本、不常驻，不装）。
#
# 只做一件事：若本机 HEAD 里 services/intake-worker 的源码/配置自上次部署以来变了，
# 就 wrangler deploy；没变则秒退、不刷无意义 version。
#
# 刻意不主动 git pull —— Mac mini 的 autopull（每 600s，见 .claude/hooks/autopull.sh）已负责把
# 任何来源 push 的新代码拉下来、保 HEAD 最新；本脚本只管「HEAD 的 worker 变了就部署」，各司其职。
# 只在装了 plist 的 Mac mini 跑；MacBook 同步到本脚本但没装 plist、不会跑（与 check-runner 同构）。
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

# 凭据：wrangler 的 OAuth 登录态会过期（2026-07-31 到期后本脚本静默失败了一个半月才被发现），
# 无人值守机器该用长期的 API token——放在仓库根未入库的 .env 里（CLOUDFLARE_API_TOKEN=…），这里
# 原样导出给 wrangler。没有 token 时仍退回 OAuth 登录态（GUI 会话里 `bun x wrangler login` 可续）。
if [ -f "$REPO/.env" ]; then
  set -a; . "$REPO/.env" 2>/dev/null; set +a
fi

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
  # 鉴权类失败每轮都会重复，单独点名，别让人翻整段 wrangler 输出才知道是登录态没了
  if tail -n 15 "$LOG" | grep -q "CLOUDFLARE_API_TOKEN\|not logged in\|Not logged in\|Authentication error"; then
    echo "[$(ts)] ✗ 原因：wrangler 无有效凭据（OAuth 登录态过期）。修法：在 $REPO/.env 加 CLOUDFLARE_API_TOKEN=<Workers 编辑权限的 API token>，或在 Mac mini 图形会话里 cd services/intake-worker && bun x wrangler login" >> "$LOG"
  fi
fi
