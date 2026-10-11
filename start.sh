#!/usr/bin/env bash
# 启动斗地主服务端（Linux / macOS）
# 用法： ./start.sh   或   PORT=9000 ./start.sh
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8080}"
echo "正在启动斗地主服务端，端口 $PORT ..."
exec node server/index.js
