import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { authRoutes } from './routes/auth.js';
import { connectionRoutes } from './routes/connections.js';
import { metadataRoutes } from './routes/metadata.js';
import { queryRoutes } from './routes/query.js';
import { logRoutes } from './routes/logs.js';
import { systemRoutes } from './routes/system.js';
import { esRoutes } from './routes/es.js';
import { redisRoutes } from './routes/redis.js';

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
    bodyLimit: 5 * 1024 * 1024, // 5MB SQL 上限
    // 信任反代下发的 X-Forwarded-For：否则 nginx/ingress 反代后所有请求都是 127.0.0.1，
    // 登录限流会变成全站共享（5 次即锁死所有人）
    trustProxy: true,
  });

  const allowedOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.register(cors, {
    origin: allowedOrigins.length === 0 ? false : allowedOrigins,
    credentials: false,
  });

  // 全局限流；登录接口在路由级单独收紧（见 routes/auth.ts，防暴力破解）
  app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    return payload;
  });
  app.register(authRoutes, { prefix: '/api/auth' });

  app.register(connectionRoutes, { prefix: '/api/connections' });
  app.register(metadataRoutes, { prefix: '/api/metadata' });
  app.register(queryRoutes, { prefix: '/api/query' });
  app.register(logRoutes, { prefix: '/api/logs' });
  app.register(systemRoutes, { prefix: '/api/system' });
  app.register(esRoutes, { prefix: '/api/es' });
  app.register(redisRoutes, { prefix: '/api/redis' });

  // 统一错误处理：错误信息不要直接泄漏堆栈
  app.setErrorHandler((err, req, reply) => {
    req.log.error(err);
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    reply.code(status).send({ error: status < 500 ? err.message : 'Internal Server Error' });
  });

  return app;
}
