#!/bin/sh
# 仅静态制品发布，不加载 .env、不构建本机仓库、不启动研究或核查。
set -eu
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
exec /usr/bin/python3 "$SCRIPT_DIR/publisher.py" "$@"
