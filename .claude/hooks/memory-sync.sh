#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────
# searchX · 两台机 memory 自动同步（MacBook 开发机 ⇄ Mac mini 常驻）
# .claude-memory/ 被 .gitignore 排除（不进公开仓库），走不了 git 那套同步，单独 rsync over SSH。
# 由 Claude Code hooks 调用（见 .claude/settings.json）：
#   SessionStart(startup|resume) → memory-sync.sh pull   开工：拉回另一台新增的记忆
#   SessionEnd                   → memory-sync.sh push   收工：把本机新增的记忆推过去
#
# 设计铁律：
#   1. 复用 git-sync 那条 SSH 通道（别名 mac-mini→stocks）。仅当本机配了该别名才动作——
#      Mac mini 无此别名，天然不自 ping、不回环（与 git-sync.sh notify_peer 同款自我识别）。
#   2. 双向增量 + `-u`（只在源更新时才覆盖，绝不拿旧盖新）+ **绝不 --delete**：
#      不丢任一边独有的记忆（Mac mini 上 runner 也会写记忆，如 akshare 抓数教训）。
#   3. MEMORY.md 是单文件索引、两边同时改的情况罕见；-u 取较新，最坏只丢较旧一方的少量新增
#      索引行，可在主力机（MacBook）补回——换取零复杂度、绝不误删，值得。
#   4. best-effort：对端睡眠/离线/失败一律静默退出，绝不阻塞开工或收工。
# ───────────────────────────────────────────────────────────────
set -o pipefail

MODE="${1:-}"
MEM="/Users/yangqiuyuan/Coding/searchX/.claude-memory"

[ -d "$MEM" ] || exit 0
command -v ssh   >/dev/null 2>&1 || exit 0
command -v rsync >/dev/null 2>&1 || exit 0

# 自我识别：只有 MacBook 的 ssh 配了别名 mac-mini→stocks；Mac mini 侧匹配不到 → 直接退出。
ssh -G mac-mini 2>/dev/null | grep -qiE '^hostname[[:space:]]+stocks$' || exit 0

SSH="ssh -o ConnectTimeout=6 -o BatchMode=yes"
PEER="mac-mini:$MEM/"

case "$MODE" in
  pull) rsync -au -e "$SSH" "$PEER"  "$MEM/"  >/dev/null 2>&1 || exit 0 ;;  # Mac mini → 本机
  push) rsync -au -e "$SSH" "$MEM/"  "$PEER"  >/dev/null 2>&1 || exit 0 ;;  # 本机 → Mac mini
  *) exit 0 ;;
esac
exit 0
