# 家庭控制台 HA Add-on
# 多阶段构建：Node 构建前端 → Python 运行后端

# ── Stage 1: 构建前端 ──
FROM node:22-alpine AS builder

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY src/ ./src/
COPY public/ ./public/
RUN npm run build

# ── Stage 2: 运行后端 ──
FROM python:3.12-slim

# 安装 uv
RUN pip install --no-cache-dir uv

WORKDIR /app

# 安装后端依赖
COPY server/pyproject.toml server/uv.lock ./server/
RUN cd server && uv sync --frozen --no-dev

# 复制后端代码
COPY server/home_console_server/ ./home_console_server/

# 复制前端构建产物
COPY --from=builder /build/dist/ ./dist/

# HA Add-on 持久化目录
VOLUME /data

EXPOSE 8765

# 直接启动后端服务（init: false 时 HA 用此 CMD）
CMD ["sh", "-c", "cd /app && uv run --project server python -m home_console_server --host ${HOME_CONSOLE_HOST:-0.0.0.0} --port ${HOME_CONSOLE_PORT:-8765} --data ${HOME_CONSOLE_DATA:-/data}"]
