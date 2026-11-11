# 镜像地址可通过构建参数覆盖，便于使用内网镜像仓库，默认走 Docker Hub
ARG REGISTRY=""
ARG NODE_IMAGE=node:20-alpine

# ===== 构建阶段 =====
FROM ${REGISTRY}${NODE_IMAGE} AS builder
# better-sqlite3 是原生模块：Debian 基础镜像有预编译包；Alpine 需要编译工具链
RUN if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache python3 make g++; \
    else \
      apt-get update \
      && apt-get install -y --no-install-recommends python3 make g++ \
      && rm -rf /var/lib/apt/lists/*; \
    fi
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# 在同镜像内裁剪为生产依赖，保留已编译的原生模块
RUN npm prune --omit=dev

# ===== 运行阶段 =====
FROM ${REGISTRY}${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/data /app/exports
EXPOSE 8080
VOLUME ["/app/data", "/app/exports"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/system/healthz || exit 1
CMD ["node", "dist/index.js"]
