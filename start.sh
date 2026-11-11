#!/usr/bin/env bash
# 一键启动本地开发环境：后端 (8080) + 前端 (5173)
# 用法: ./start.sh   (Ctrl+C 同时停掉两个进程)
set -e
cd "$(dirname "$0")"

command -v npm >/dev/null || { echo "错误: 未找到 npm，请先安装 Node.js"; exit 1; }

# 依赖缺失时自动安装（有 node_modules 则跳过，改了依赖请手动重装）
[ -d server/node_modules ] || (cd server && npm install)
[ -d web/node_modules ]    || (cd web && npm install)

echo "==> 启动后端 dev (http://localhost:8080)"
(cd server && npm run dev) &
SERVER_PID=$!

echo "==> 启动前端 dev (http://localhost:5173)"
(cd web && npm run dev) &
WEB_PID=$!

# 任一方式退出时，把两个子进程一起带走
trap 'kill "$SERVER_PID" "$WEB_PID" 2>/dev/null || true' EXIT

echo "==> 浏览器打开 http://localhost:5173 (默认账号 admin / admin123)"
wait
