#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────
# searchX · Mac mini 一键迁移自检
# 用法：整个 searchX 文件夹拷到 Mac mini 同路径后，在项目根目录运行：
#     bash setup-macmini.sh
# 能自动的全自动（记忆软链 / 装 bun / 装依赖 / 跑门禁 / 查鉴权），
# 只把唯一必须你本人做的事（GitHub 推送授权）清楚拎出来。反复运行安全。
# ───────────────────────────────────────────────────────────────
set -o pipefail

REPO="/Users/yangqiuyuan/Coding/searchX"
MEM_REAL="$REPO/.claude-memory"
MEM_LINK="$HOME/.claude/projects/-Users-yangqiuyuan-Coding-searchX/memory"
TODO=()

b(){    printf "\n\033[1m%s\033[0m\n" "$1"; }
ok(){   printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn(){ printf "  \033[33m⚠\033[0m %s\n" "$1"; }
err(){  printf "  \033[31m✗\033[0m %s\n" "$1"; }

# ── 0. 位置确认 ────────────────────────────────────────────────
b "0/7 确认项目位置"
if [ ! -d "$REPO/.git" ] || [ ! -f "$REPO/CLAUDE.md" ]; then
  err "没在预期路径找到 searchX：$REPO"
  echo "     请确认整个文件夹已拷到这个路径（两台机用户名都是 yangqiuyuan）。"
  exit 1
fi
cd "$REPO" || exit 1
ok "项目在 $REPO"

# ── 1. 重建 Claude 记忆软链接 ─────────────────────────────────
b "1/7 重建 Claude 记忆软链接（让这台的 Claude 读仓库内记忆）"
if [ ! -d "$MEM_REAL" ]; then
  warn "没找到 $MEM_REAL —— 记忆真身没随文件夹拷来？"
  echo "     （.claude-memory/ 是隐藏目录，Finder 拷整个文件夹会带上；AirDrop 同理。）"
  TODO+=("把 MacBook 的 searchX/.claude-memory/ 补拷到 Mac mini 同路径")
else
  mkdir -p "$(dirname "$MEM_LINK")"
  if [ -L "$MEM_LINK" ]; then
    ok "软链接已存在 → $(readlink "$MEM_LINK")"
  elif [ -e "$MEM_LINK" ]; then
    if [ -z "$(ls -A "$MEM_LINK" 2>/dev/null)" ]; then
      rmdir "$MEM_LINK" && ln -s "$MEM_REAL" "$MEM_LINK" && ok "空目录已替换为软链接 → $MEM_REAL"
    else
      warn "$MEM_LINK 是非空真实目录，未动它（避免覆盖你已有的记忆）。"
      TODO+=("人工确认 $MEM_LINK 内容后，删除并改为软链接到 $MEM_REAL")
    fi
  else
    ln -s "$MEM_REAL" "$MEM_LINK" && ok "已建软链接 → $MEM_REAL"
  fi
fi

# ── 2. bun ────────────────────────────────────────────────────
b "2/7 检查 bun（主运行时）"
if command -v bun >/dev/null 2>&1; then
  ok "bun 已装：$(bun --version)"
else
  warn "未装 bun，正在自动安装官方版本…"
  if curl -fsSL https://bun.sh/install | bash; then
    export PATH="$HOME/.bun/bin:$PATH"
    if command -v bun >/dev/null 2>&1; then
      ok "bun 装好：$(bun --version)（新终端自动可用，本次已临时入 PATH）"
    else
      err "bun 装了但当前 shell 找不到 —— 重开终端再跑一次本脚本即可。"
      TODO+=("重开终端后重跑 bash setup-macmini.sh"); fi
  else
    err "bun 自动安装失败（没网/权限？）。手动：curl -fsSL https://bun.sh/install | bash"
    TODO+=("手动安装 bun 后重跑本脚本"); fi
fi

# ── 3. 依赖 ───────────────────────────────────────────────────
b "3/7 安装依赖（bun install）"
if command -v bun >/dev/null 2>&1; then
  if bun install >/tmp/sx_bun_install.log 2>&1; then ok "依赖就绪"
  else
    warn "bun install 报错，清 node_modules 重装…"
    rm -rf node_modules
    if bun install >/tmp/sx_bun_install.log 2>&1; then ok "重装成功"
    else err "依赖安装失败，看 /tmp/sx_bun_install.log"; TODO+=("手动排查 bun install"); fi
  fi
else warn "跳过（bun 不可用）"; fi

# ── 4. 本机机密/配置文件就位（不打印内容）─────────────────────
b "4/7 检查随文件夹拷来的本机文件"
if [ -f "$REPO/CLAUDE.local.md" ]; then ok "CLAUDE.local.md 在（本机路径变量）"
else err "缺 CLAUDE.local.md"; TODO+=("补 CLAUDE.local.md（ARCHIVE_ROOT / OBSIDIAN_VAULT 两行）"); fi
if [ -f "$REPO/.env" ]; then ok ".env 在（runner 机密已就位）"
else warn ".env 不在 —— 只跑 /research、/stock 不受影响；要跑 bun run runner 才需要它。"; fi

# ── 5. Obsidian 库 ────────────────────────────────────────────
b "5/7 检查 Obsidian 库路径"
VAULT=""
[ -f "$REPO/CLAUDE.local.md" ] && VAULT=$(grep -E 'OBSIDIAN_VAULT`?[[:space:]]*=' "$REPO/CLAUDE.local.md" | head -1 | sed -E 's/.*=[[:space:]]*`?//; s/`.*//')
if [ -n "$VAULT" ] && [ -d "$VAULT" ]; then
  ok "Obsidian 库在：$VAULT"
elif [ -n "$VAULT" ]; then
  warn "CLAUDE.local.md 指的 Obsidian 库不存在：$VAULT"
  echo "     改好目录后，把 CLAUDE.local.md 里 OBSIDIAN_VAULT 那行换成新路径即可，skill 会自动用。"
  echo "     （Step5 只是落笔记，不影响报告上线。）"
  TODO+=("设定 Obsidian 库并更新 CLAUDE.local.md 的 OBSIDIAN_VAULT 那一行")
else warn "没从 CLAUDE.local.md 读到 OBSIDIAN_VAULT"; fi

# ── 6. 构建门禁（证明迁移成功）────────────────────────────────
b "6/7 验证构建门禁"
if command -v bun >/dev/null 2>&1; then
  if bun test >/tmp/sx_test.log 2>&1; then ok "bun test 通过（$(grep -Eo '[0-9]+ pass' /tmp/sx_test.log | head -1)）"
  else err "bun test 失败，看 /tmp/sx_test.log"; TODO+=("排查 bun test 失败"); fi
  if bun run web/build/cli.js >/tmp/sx_build.log 2>&1; then ok "站点构建通过（$(grep -Eo 'Built [0-9]+ entries' /tmp/sx_build.log | head -1)）"
  else err "站点构建失败，看 /tmp/sx_build.log"; TODO+=("排查站点构建失败"); fi
else warn "跳过（bun 不可用）"; fi

# ── 7. GitHub 推送鉴权（唯一可能要你本人做的一步）─────────────
b "7/7 检查 GitHub 推送鉴权（自动上线 / runner 需要）"
if git push --dry-run origin HEAD >/tmp/sx_push.log 2>&1; then
  ok "推送鉴权 OK，git push 可用 —— 全自动上线链路就绪"
else
  warn "这台机器还不能推 GitHub（自动上线那步会失败）。一次配好、永久有效："
  if command -v gh >/dev/null 2>&1; then
    echo "       gh auth login        # 按提示，在浏览器点一下 Authorize"
  else
    echo "       brew install gh      # 没 brew 就去 https://cli.github.com 下载"
    echo "       gh auth login        # 按提示，在浏览器点一下 Authorize"
  fi
  echo "     这步是登录授权，必须你本人在浏览器点 —— 脚本/Claude 不能替你点。"
  echo "     懒得记命令？在项目里直接跟 Claude 说「帮我配好 GitHub 推送」，它带你走完。"
  TODO+=("配 GitHub 推送鉴权：gh auth login（浏览器点 Authorize）")
fi

# ── 总结 ──────────────────────────────────────────────────────
b "—— 迁移自检完成 ——"
if [ ${#TODO[@]} -eq 0 ]; then
  printf "  \033[32m全部就绪，无需人工。直接开跑 /stock、/research、bun run runner。\033[0m\n\n"
else
  printf "  其余已自动完成；还剩 %d 件需要你手动：\n" "${#TODO[@]}"
  i=1; for t in "${TODO[@]}"; do printf "    \033[33m%d.\033[0m %s\n" "$i" "$t"; i=$((i+1)); done
  echo
fi
