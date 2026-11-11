import type { FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { loadConfig } from '../config.js';
import { findUserById } from '../db/store.js';
import type { User } from '../types.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

export interface JwtPayload {
  uid: number;
  username: string;
  role: 'admin' | 'user';
  /** 改密后递增的 token 版本，用于吊销旧 JWT */
  tv?: number;
}

/** AGENT_TOKEN 虚拟用户：只读、全连接放行、不查数据库 */
const AGENT_USER: User = {
  id: 0,
  username: 'agent',
  role: 'user',
  mustChangePassword: 0,
  isAgent: 1,
  tokenVersion: 0,
  createdAt: '',
};

/** 与配置 token 比对；先 sha256 定长化再 timingSafeEqual，防时序侧信道 */
function matchAgentToken(token: string): boolean {
  const tokens = loadConfig().agentTokens;
  if (tokens.length === 0) return false;
  const hash = crypto.createHash('sha256').update(token).digest();
  return tokens.some((candidate) => {
    const candidateHash = crypto.createHash('sha256').update(candidate).digest();
    return crypto.timingSafeEqual(hash, candidateHash);
  });
}

export function signToken(user: User): string {
  const cfg = loadConfig();
  const payload: JwtPayload = { uid: user.id, username: user.username, role: user.role, tv: user.tokenVersion };
  return jwt.sign(payload, cfg.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: cfg.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });
}

export function verifyToken(token: string): JwtPayload {
  const cfg = loadConfig();
  return jwt.verify(token, cfg.jwtSecret, { algorithms: ['HS256'] }) as JwtPayload;
}

/** Fastify 插件：校验 Authorization: Bearer <token>（JWT 或 AGENT_TOKEN） */
export async function authGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const token = header.slice(7);
  try {
    const payload = verifyToken(token);
    const user = findUserById(payload.uid);
    // token_version 不一致（改密后递增）即判定失效，支持改密后吊销旧 JWT
    if (!user || user.username !== payload.username || (payload.tv ?? 0) !== user.tokenVersion) {
      return reply.code(401).send({ error: 'Invalid or expired token' });
    }
    req.user = user;
    // 用已匹配路由的 pattern 判断，避免 ";path" 后缀伪造 req.url 绕过强制改密
    const routePath = req.routeOptions.url ?? req.url.split('?')[0];
    const isPasswordRoute = routePath.endsWith('/auth/me')
      || routePath.endsWith('/auth/change-password')
      || routePath === '/me'
      || routePath === '/change-password';
    if (user.mustChangePassword && !isPasswordRoute) {
      return reply.code(403).send({ error: '首次登录必须先修改密码' });
    }
  } catch {
    if (matchAgentToken(token)) {
      req.user = { ...AGENT_USER };
      return;
    }
    return reply.code(401).send({ error: 'Invalid or expired token' });
  }
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.user?.role !== 'admin') {
    return reply.code(403).send({ error: '无权限' });
  }
}
