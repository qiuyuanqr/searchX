#!/bin/zsh
# Stocks 深度调研 → searchX 公开站 —— 每日无人值守同步（由 Mac mini 上的 LaunchAgent 调用）。
#
# 每 5 分钟跑一次（plist 里的 StartInterval，可随时调）。没有新报告时安静退出，空跑 0.14 秒。
# 这条通路不出网——读的是同一台机器上的 SQLite 文件，所以频率不受任何 API 配额约束；
# 真正出网的 push 与 CI 只在确有新报告时发生，次数等于报告篇数。
#
# 流程（任一步失败都不会把半成品推上线）：
#   1) 增量导入 —— 只处理没导过的报告；一篇都没有就安静退出（不发信、不提交）
#   2) 逐篇过机器质检 --strict —— 不过的**就地搁置**（写 .parked，构建会跳过它），
#      而不是整批放弃：一篇有问题不该拖着其它篇不上线
#   3) 构建自检 —— 本地先跑一遍 bun run build，拦住会让 CI 挂掉的报告
#   4) 精准 git add（只加本次新增的归档目录 + INDEX.md）→ 提交 → 推送 → CI 部署
#   5) 有搁置件或有失败时发一封限频报警（同 key 6 小时最多一封）
#
# 手动跑：bun run stocks-import  （只导，不提交不推送）
# 立刻触发定时任务：launchctl kickstart gui/$(id -u)/com.searchx.stocks-import
set -u

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="$HOME/Library/Logs/searchx-stocks-import"
LOG="$LOG_DIR/stocks-import.log"
# 锁文件用固定路径 + 环境变量可覆盖。**别用 $TMPDIR**：ssh 与 launchd 拿到的值不一样，
# 互斥会形同虚设，测试也没法隔离（CLAUDE.md 的既有约定）。
LOCK="${STOCKS_IMPORT_LOCK:-$HOME/Library/Application Support/searchx-stocks-import/run.lock}"

mkdir -p "$LOG_DIR" "$(dirname "$LOCK")"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
say() { echo "[$(ts)] $*" >> "$LOG"; }
alert() { bun services/runner/src/alert-cli.js "$1" "$2" >> "$LOG" 2>&1 || true; }
# 本轮日志 = 最后一条「tick：」分隔线之后的内容。失败时喂给 alert-cli，让它识别错误类型、
# 挑出关键错误行、给出处置办法，再连同末尾几行现场一起发信——只报一个退出码的旧写法，
# 每次都得先 ssh 上来翻日志才知道该干什么（2026-08-26 的 401 事故就白等了十小时）。
tick_log() { tail -n 300 "$LOG" | awk '/──────── tick：/{buf=""} {buf=buf $0 ORS} END{printf "%s", buf}'; }
# 失败类报警走这个（附本轮日志尾部）；detail 已写清原因和处置办法的（如 parked）仍走 alert。
alert_failed() {
  TICK_LOG="$(tick_log)"
  printf '%s' "$TICK_LOG" | bun services/runner/src/alert-cli.js "$1" "$2" \
    --log-path "$LOG" --log-stdin >> "$LOG" 2>&1 || true
}

# 日志超 5MB 滚一次
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 5000000 ]; then mv -f "$LOG" "$LOG.1"; fi

cd "$REPO" 2>/dev/null || { say "进不去仓库目录：$REPO"; exit 1; }

# —— 互斥：mkdir 是原子的；陈旧锁（>2 小时）自动回收 ——
if ! mkdir "$LOCK" 2>/dev/null; then
  # BSD 与 GNU 的 stat 取修改时间参数完全不同，且 GNU 的 -f 不报错、会打印挂载点，
  # 「|| 兜底」拦不住——所以按平台显式分支（CLAUDE.md 的既有教训）。
  if [ "$(uname)" = "Darwin" ]; then lock_mtime=$(stat -f %m "$LOCK" 2>/dev/null)
  else lock_mtime=$(stat -c %Y "$LOCK" 2>/dev/null); fi
  now=$(date +%s)
  if [ -n "${lock_mtime:-}" ] && [ $((now - lock_mtime)) -gt 7200 ]; then
    say "回收陈旧锁（已 $((now - lock_mtime)) 秒）"
    rmdir "$LOCK" 2>/dev/null
    mkdir "$LOCK" 2>/dev/null || { say "抢锁失败，本次跳过"; exit 0; }
  else
    say "上一轮还在跑，本次跳过"
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

say "──────── tick：检查 Stocks 有无新的深度调研报告"

# —— 0) 先补推「已提交但没推出去」的 ——
# 与下面 1b) 是同一类缺口的另一半：push 失败后（网络抖动、或凭证在非 GUI session 取不到）
# 本地提交仍然在，而下一轮若没有新报告就安静退出——那个提交会永远躺在本机，报告也就
# 永远不上线。所以每轮先看一眼有没有欠着的提交。
# 失败只记日志、不发报警、不中止：每 5 分钟一轮，报警会变成轰炸，而下一轮本就会再试。
unpushed=$(git rev-list --count @{u}..HEAD 2>/dev/null || echo 0)
if [ "${unpushed:-0}" -gt 0 ]; then
  say "有 $unpushed 个提交没推出去，先补推"
  if git push -q >> "$LOG" 2>&1; then
    say "补推成功，CI 将自动部署"
  else
    say "补推失败，下一轮再试（若持续失败，多半是凭证或网络）"
  fi
fi

# —— 1) 增量导入 ——
NEW_DIRS=$(bun run services/stocks-import/src/index.js --porcelain 2>>"$LOG")
code=$?
if [ "$code" -ne 0 ]; then
  say "导入脚本退出码 $code，本次中止"
  alert_failed stocks-import-failed "Stocks→searchX 每日同步 · 导入阶段退出码 $code"
  exit "$code"
fi
# —— 1b) 补上「已导入但没走完提交」的目录 ——
# 导入与提交不是原子的：手工跑过 `bun run stocks-import`（README 列为支持用法）、或上一轮
# 在质检/构建/推送阶段中断（构建失败那条路径注释里就写着「已导入但未提交」），都会把目录
# 留在磁盘上。而幂等判据是「扫 research/ 看哪些 id 已落盘」——下一轮它算「已导过」，
# NEW_DIRS 为空，脚本安静退出，**那批报告从此再也不会上线**，报警也只发过那一次。
# 所以每轮都要把磁盘上未提交的导入目录一并纳入，让任何原因造成的中断都能自愈。
#
# 只认带 `source_system: stocks` 的：research/ 下还可能有 /research、/stock 手工跑出来的
# 未提交调研，那些不归这条流水线管，替它们提交就是越权。
ORPHANS=""
while IFS= read -r p; do
  [ -z "$p" ] && continue
  d="${p#research/}"; d="${d%/}"
  case "$d" in ""|*/*) continue;; esac          # 只要 research/ 下一级的整个未跟踪目录
  [ -f "research/$d/notes.md" ] || continue
  grep -q '^source_system: stocks$' "research/$d/notes.md" 2>/dev/null || continue
  printf '%s\n' "$NEW_DIRS" | grep -qxF "$d" && continue   # 本轮刚导的，别重复
  ORPHANS="${ORPHANS}${d}
"
done <<< "$(git -c core.quotePath=false ls-files --others --exclude-standard --directory research/ 2>/dev/null)"

if [ -n "$(printf '%s' "$ORPHANS" | grep . 2>/dev/null)" ]; then
  say "发现 $(printf '%s\n' "$ORPHANS" | grep -c .) 篇此前已导入但未提交，本轮一并处理：$(printf '%s\n' "$ORPHANS" | tr '\n' ' ')"
  NEW_DIRS="$(printf '%s\n%s' "$NEW_DIRS" "$ORPHANS" | grep .)"
fi

if [ -z "$NEW_DIRS" ]; then
  say "没有新报告，安静退出"
  exit 0
fi
say "本轮处理：$(printf '%s\n' "$NEW_DIRS" | tr '\n' ' ')"

# —— 2) 逐篇机器质检；不过的就地搁置 ——
PARKED=""
while IFS= read -r d; do
  [ -z "$d" ] && continue
  if ! bun run scripts/research-qc.js --dir "$d" --strict >> "$LOG" 2>&1; then
    : > "research/$d/.parked"
    PARKED="$PARKED $d"
    say "⚠️ $d 未过机器质检，已搁置（.parked，构建会跳过，不会上线）"
  fi
done <<< "$NEW_DIRS"

# —— 3) 构建自检：本地先构一遍，别把会让 CI 挂掉的东西推上去 ——
if ! bun run build >> "$LOG" 2>&1; then
  say "构建失败，本次不提交"
  alert_failed stocks-import-failed "Stocks→searchX 每日同步 · 构建自检失败（已导入但未提交）"
  exit 1
fi

# —— 4) 精准提交并推送 ——
# 中文路径会被 git 转成八进制转义串，凡是解析 git 输出的地方一律关掉 quotePath。
git -c core.quotePath=false add research/INDEX.md >> "$LOG" 2>&1
while IFS= read -r d; do
  [ -z "$d" ] && continue
  git -c core.quotePath=false add "research/$d" >> "$LOG" 2>&1
done <<< "$NEW_DIRS"

count=$(echo "$NEW_DIRS" | grep -c .)
if git diff --cached --quiet; then
  say "没有待提交内容（可能全部被 .gitignore 排除），跳过提交"
else
  git commit -q -m "research(stocks): 从 Stocks 同步 ${count} 篇个股深度调研

由 services/stocks-import 每日自动导入，已过系统参数过滤与机器质检。" >> "$LOG" 2>&1
  if git push -q >> "$LOG" 2>&1; then
    say "已推送 ${count} 篇，CI 将自动部署"
  else
    say "push 失败"
    alert_failed stocks-import-failed "Stocks→searchX 每日同步 · git push 失败（已本地提交）"
    exit 1
  fi
fi

# —— 5) 有搁置件就告诉作者（限频） ——
if [ -n "$PARKED" ]; then
  alert stocks-import-parked "Stocks→searchX 每日同步：以下报告未过机器质检、已搁置未上线：$PARKED。跑 \`bun run scripts/research-qc.js --dir <目录> \` 看具体条目，处理后删掉 .parked 再 push。"
fi

say "──────── 结束"
exit 0
