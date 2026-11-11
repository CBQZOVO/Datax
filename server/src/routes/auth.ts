import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authService } from '../services/authService.js';
import { authGuard, requireAdmin } from '../middleware/auth.js';
import {
  findUserById,
  getDataSource,
  listAllHiddenDatabases,
  listUserPermissions,
  replaceHiddenDatabases,
  replaceUserPermissions,
} from '../db/store.js';

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  oldPassword: z.string(),
  newPassword: z.string().min(8).max(128),
});

const createUserSchema = z.object({
  username: z.string().min(2).max(64),
  password: z.string().min(8),
  role: z.enum(['admin', 'user']),
});

const permissionSchema = z.object({
  permissions: z.array(z.object({
    connectionId: z.number().int().positive(),
    database: z.string().trim().min(1).max(256),
  })).max(10_000),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    try {
      const { token, user } = authService().login(parsed.data.username, parsed.data.password);
      return { token, user };
    } catch (e) {
      return reply.code(401).send({ error: (e as Error).message });
    }
  });

  app.post('/change-password', { preHandler: authGuard }, async (req, reply) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    try {
      authService().changePassword(req.user!.id, parsed.data.oldPassword, parsed.data.newPassword);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get('/me', { preHandler: authGuard }, async (req) => {
    const user = findUserById(req.user!.id);
    if (!user) throw new Error('用户不存在');
    return { user };
  });

  // 管理用户（仅 admin）
  app.get('/users', { preHandler: [authGuard, requireAdmin] }, async () => ({ users: authService().listUsers() }));

  app.post('/users', { preHandler: [authGuard, requireAdmin] }, async (req, reply) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    try {
      authService().adminCreateUser(parsed.data.username, parsed.data.password, parsed.data.role);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get('/users/:id/permissions', { preHandler: [authGuard, requireAdmin] }, async (req, reply) => {
    const userId = Number((req.params as { id: string }).id);
    const user = findUserById(userId);
    if (!user) return reply.code(404).send({ error: '用户不存在' });
    return { permissions: listUserPermissions(userId) };
  });

  app.put('/users/:id/permissions', { preHandler: [authGuard, requireAdmin] }, async (req, reply) => {
    const userId = Number((req.params as { id: string }).id);
    const user = findUserById(userId);
    if (!user) return reply.code(404).send({ error: '用户不存在' });
    if (user.role === 'admin') return reply.code(400).send({ error: '管理员默认拥有全部数据，无需分配权限' });
    const parsed = permissionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    // 先按连接去重再校验存在性，避免逐条查询数据源（N+1）
    const connectionIds = [...new Set(parsed.data.permissions.map((p) => p.connectionId))];
    for (const connectionId of connectionIds) {
      if (!getDataSource(connectionId)) {
        return reply.code(400).send({ error: `数据源 ${connectionId} 不存在` });
      }
    }
    const unique = new Map<string, { connectionId: number; database: string }>();
    for (const permission of parsed.data.permissions) {
      unique.set(`${permission.connectionId}\u0000${permission.database}`, permission);
    }
    replaceUserPermissions(userId, [...unique.values()]);
    return { permissions: listUserPermissions(userId) };
  });

  const hiddenSchema = z.object({
    hidden: z.array(z.object({
      connectionId: z.number().int().positive(),
      database: z.string().trim().min(1).max(256),
    })).max(10_000),
  });

  /** 管理员的隐藏配置：仅影响管理员侧显示 */
  app.get('/users/:id/hidden-databases', { preHandler: [authGuard, requireAdmin] }, async (req, reply) => {
    const userId = Number((req.params as { id: string }).id);
    const user = findUserById(userId);
    if (!user) return reply.code(404).send({ error: '用户不存在' });
    if (user.role !== 'admin') return reply.code(400).send({ error: '仅管理员支持隐藏配置' });
    return { hidden: listAllHiddenDatabases(userId) };
  });

  app.put('/users/:id/hidden-databases', { preHandler: [authGuard, requireAdmin] }, async (req, reply) => {
    const userId = Number((req.params as { id: string }).id);
    const user = findUserById(userId);
    if (!user) return reply.code(404).send({ error: '用户不存在' });
    if (user.role !== 'admin') return reply.code(400).send({ error: '仅管理员支持隐藏配置' });
    const parsed = hiddenSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    const connectionIds = [...new Set(parsed.data.hidden.map((h) => h.connectionId))];
    for (const connectionId of connectionIds) {
      if (!getDataSource(connectionId)) {
        return reply.code(400).send({ error: `数据源 ${connectionId} 不存在` });
      }
    }
    const unique = new Map<string, { connectionId: number; database: string }>();
    for (const item of parsed.data.hidden) {
      unique.set(`${item.connectionId}\u0000${item.database}`, item);
    }
    replaceHiddenDatabases(userId, [...unique.values()]);
    return { hidden: listAllHiddenDatabases(userId) };
  });
}
