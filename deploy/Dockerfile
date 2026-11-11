# datax 单镜像：nginx 托管前端静态文件并反代本机 node 后端（前后端一个容器）
# 构建上下文为仓库根目录：
#   docker build --platform linux/amd64 -f deploy/Dockerfile -t <tag> .
# 说明：指定的 nginx 镜像为 debian 基础（glibc），构建阶段必须用 glibc 系 node
# 镜像（bookworm-slim），否则 better-sqlite3 原生模块的 ABI 与运行时不匹配。
ARG NODE_IMAGE=library/node:20
ARG NGINX_IMAGE=library/nginx:1.31.5

# ===== 前端构建 =====
FROM ${NODE_IMAGE} AS web-builder
WORKDIR /web
COPY web/package*.json ./
RUN npm install
COPY web/ .
RUN npm run build

# ===== 后端构建 =====
FROM ${NODE_IMAGE} AS server-builder
# better-sqlite3 是原生模块，需要编译工具链（按本阶段 node 的 ABI 编译）
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /server
COPY server/package*.json ./
RUN npm install
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev

# ===== 运行时：拷入构建产物与 node =====
FROM ${NGINX_IMAGE} AS runtime
# node 运行需要 libstdc++，nginx 基础镜像未自带；ca-certificates 备 https 出网调用使用
RUN apt-get update \
 && apt-get install -y --no-install-recommends libstdc++6 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=server-builder /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=server-builder /server/package*.json ./
COPY --from=server-builder /server/node_modules ./node_modules
COPY --from=server-builder /server/dist ./dist
RUN mkdir -p /app/data /app/exports
COPY --from=web-builder /web/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENV NODE_ENV=production
EXPOSE 80
# 镜像内无 wget/curl，用 node 探测（经 nginx 反代验证两个进程都活着）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1/api/system/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/entrypoint.sh"]
