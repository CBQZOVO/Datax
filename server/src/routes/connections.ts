import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { connectionService } from '../services/connectionService.js';
import { authGuard, requireAdmin } from '../middleware/auth.js';
import { listAuthorizedConnectionIds } from '../db/store.js';

const connectionSchema = z.object({
  id: z.number().int().optional(),
  name: z.string().min(1).max(128),
  type: z.enum(['mysql', 'postgres', 'elasticsearch', 'redis']),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  // Redis 常规部署只用密码（无 ACL 用户名），其余类型仍强制要求用户名
  username: z.string().max(128),
  password: z.string(),
  database: z.string().optional().default(''),
  schema: z.string().optional().default(''),
}).superRefine((value, ctx) => {
  if (value.type !== 'redis' && !value.username.trim()) {
    ctx.addIssue({ code: 'custom', message: '请输入用户名', path: ['username'] });
  }
});

/** 路由参数 id → number；非法值返回 undefined（调用方返回 400） */
function parseId(raw: string): number | undefined {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authGuard);

  // 测试未保存的连接（需注册在 /:id 之前）
  app.post('/test', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = connectionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    const { id: _id, ...input } = parsed.data;
    try {
      const res = await connectionService().testDraft(input);
      return res;
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  });

  app.get('/', async (req) => {
    const allowedIds = listAuthorizedConnectionIds(req.user!);
    const connections = connectionService().list();
    return { connections: allowedIds === null ? connections : connections.filter((conn) => allowedIds.includes(conn.id)) };
  });

  app.get('/:id', async (req, reply) => {
    const connectionId = parseId((req.params as { id: string }).id);
    if (connectionId === undefined) return reply.code(400).send({ error: '参数错误：id 必须为正整数' });
    const allowedIds = listAuthorizedConnectionIds(req.user!);
    if (allowedIds !== null && !allowedIds.includes(connectionId)) {
      return reply.code(403).send({ error: '无权访问该数据源' });
    }
    const ds = connectionService().get(connectionId);
    if (!ds) return reply.code(404).send({ error: '数据源不存在' });
    const { passwordEnc: _pw, ...rest } = ds;
    return { connection: rest };
  });

  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = connectionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误', detail: parsed.error.issues });
    try {
      const conn = connectionService().save(parsed.data);
      return { connection: conn };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.put('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === undefined) return reply.code(400).send({ error: '参数错误：id 必须为正整数' });
    const parsed = connectionSchema.safeParse({ ...(req.body as object), id });
    if (!parsed.success) return reply.code(400).send({ error: '参数错误', detail: parsed.error.issues });
    try {
      const conn = connectionService().save(parsed.data);
      return { connection: conn };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.delete('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === undefined) return reply.code(400).send({ error: '参数错误：id 必须为正整数' });
    connectionService().remove(id);
    return { ok: true };
  });

  app.post('/:id/test', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === undefined) return reply.code(400).send({ error: '参数错误：id 必须为正整数' });
    return connectionService().test(id);
  });

  app.get('/meta/types', async () => {
    const { supportedTypes } = await import('../drivers/index.js');
    return { types: supportedTypes };
  });
}
