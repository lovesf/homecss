#!/usr/bin/env bashio
# HA Add-on 启动脚本
set -e

# 从 Add-on options 读取配置（如果 HA 自动注入环境变量则跳过）
export HOME_CONSOLE_HOST="${HOME_CONSOLE_HOST:-0.0.0.0}"
export HOME_CONSOLE_PORT="${HOME_CONSOLE_PORT:-8765}"
export HOME_CONSOLE_DATA="${HOME_CONSOLE_DATA:-/config/home_console}"

# 确保数据目录存在
mkdir -p "${HOME_CONSOLE_DATA}"

echo "[家庭控制台] 启动: host=${HOME_CONSOLE_HOST} port=${HOME_CONSOLE_PORT} data=${HOME_CONSOLE_DATA}"

cd /app
exec uv run --project server python -m home_console_server \
  --host "${HOME_CONSOLE_HOST}" \
  --port "${HOME_CONSOLE_PORT}" \
  --data "${HOME_CONSOLE_DATA}"
