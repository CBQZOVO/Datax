#!/bin/sh
# nginx 后台跑（托管前端 + 反代 /api），node 前台跑（退出即容器退出，由编排重启）
nginx
exec node dist/index.js
