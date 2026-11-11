#!/usr/bin/env bash
# 一键构建 datax 单镜像（linux/amd64，nginx 托管前端 + node 后端）
# 流程：本地编译验证（tsc/vite，快速失败）→ docker 多阶段构建镜像
# 用法: ./build.sh [tag]                # tag 默认 latest，仅本地构建
#   IMAGE=docker.io/yourname/datax ./build.sh v1.0.0   # 构建并推送到指定镜像仓库
set -e
cd "$(dirname "$0")"

command -v npm >/dev/null || { echo "错误: 未找到 npm，请先安装 Node.js"; exit 1; }

echo "==> 安装后端依赖"
(cd server && npm install)

echo "==> 编译后端 (tsc -> server/dist)"
(cd server && npm run build)

echo "==> 安装前端依赖"
(cd web && npm install)

echo "==> 构建前端 (vite -> web/dist)"
(cd web && npm run build)

echo ""
echo "==> 编译完成: server/dist 与 web/dist（可用于本地运行）"

IMAGE="${IMAGE:-datax}"
TAG="${1:-latest}"
PLATFORM="linux/amd64"
DOCKERFILE="deploy/Dockerfile"

command -v docker >/dev/null || { echo "错误: 未找到 docker"; exit 1; }

echo "==> 构建镜像 ${IMAGE}:${TAG} (${PLATFORM})"
docker build --platform "$PLATFORM" -f "$DOCKERFILE" -t "${IMAGE}:${TAG}" .

if [ -n "$DOCKER_PUSH" ]; then
  echo "==> 推送 ${IMAGE}:${TAG}"
  docker push "${IMAGE}:${TAG}"
else
  echo ""
  echo "完成（未推送）。推送到仓库请设置环境变量 DOCKER_PUSH=1："
  echo "  IMAGE=docker.io/yourname/datax DOCKER_PUSH=1 ./build.sh $TAG"
fi
