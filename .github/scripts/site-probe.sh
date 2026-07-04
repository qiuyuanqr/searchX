#!/usr/bin/env bash
# 线上冒烟探测（CI 用，海外视角）：三条硬断言，全过才算活——
#   1) 首页可达；
#   2) 首页里注入的提交端点与仓库配置一致（防「部署完就是坏的」：坏配置/旧构建上线）；
#   3) Worker 主端点可达（GET /verify 无参约定应答 {"ok":false}，见 intake-worker/src/verify.js）。
# 备用端点（workers.dev）只测不拦：它挂了主链路仍通，打条警告即可。
# 墙内视角（SNI 阻断类，如 2026-07-03 巨轮智能提交丢失）本脚本测不到，
# 由 Mac mini 上的 services/runner/src/probe-cli.js 负责。
# 用法：site-probe.sh [尝试次数] [间隔秒]
#   部署后 Pages CDN 缓存最长 10 分钟才刷新，冒烟场景用多次重试等它（deploy.yml 传 10 45）。
set -euo pipefail

ATTEMPTS="${1:-3}"
SLEEP_SECS="${2:-30}"
SITE="${SITE_BASE:-https://qiuyuanqr.github.io/searchX}"
CONFIG="web/src/site.config.json"

WORKER=$(jq -r '.WORKER_URL' "$CONFIG")
FALLBACK=$(jq -r '.WORKER_FALLBACK_URL // empty' "$CONFIG")

probe_once() {
  local html body
  if ! html=$(curl -fsS --max-time 20 "$SITE/?smoke=$(date +%s)"); then
    echo "✗ 首页不可达：$SITE"
    return 1
  fi
  if ! grep -qF "data-worker=\"$WORKER\"" <<<"$html"; then
    echo "✗ 首页提交端点与配置不一致（期望 $WORKER）——线上可能是旧构建或坏配置"
    return 1
  fi
  if ! body=$(curl -fsS --max-time 15 "$WORKER/verify"); then
    echo "✗ Worker 主端点不可达：$WORKER"
    return 1
  fi
  if ! grep -q '"ok"' <<<"$body"; then
    echo "✗ Worker /verify 应答异常：$body"
    return 1
  fi
  return 0
}

for i in $(seq 1 "$ATTEMPTS"); do
  if probe_once; then
    echo "✓ 冒烟通过（第 $i 次尝试）：首页可达 + 配置一致 + Worker 可达"
    if [ -n "$FALLBACK" ] && ! curl -fsS --max-time 15 "$FALLBACK/verify" >/dev/null 2>&1; then
      echo "⚠ 备用端点不可达（主链路正常，不拦）：$FALLBACK"
    fi
    exit 0
  fi
  if [ "$i" -lt "$ATTEMPTS" ]; then
    echo "…第 $i 次未过，${SLEEP_SECS}s 后重试（等 CDN 刷新）"
    sleep "$SLEEP_SECS"
  fi
done

echo "✗ 冒烟失败：$ATTEMPTS 次尝试均未通过"
exit 1
