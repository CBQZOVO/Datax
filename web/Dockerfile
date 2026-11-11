# 镜像地址可通过构建参数覆盖，便于使用内网镜像仓库，默认走 Docker Hub
ARG REGISTRY=""
ARG NODE_IMAGE=node:20-alpine
ARG NGINX_IMAGE=nginx:1.27-alpine

# ===== 构建阶段 =====
FROM ${REGISTRY}${NODE_IMAGE} AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# ===== 运行阶段（Nginx 托管静态文件 + 反代 API） =====
FROM ${REGISTRY}${NGINX_IMAGE} AS runtime
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ || exit 1
