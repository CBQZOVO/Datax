import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../middleware/auth.js';
import { loadConfig } from '../config.js';
import { connectionService } from '../services/connectionService.js';
import { isForbiddenCommand, isReadonlyCommand, redisService } from '../services/redisService.js';
import { hasDataPermission, insertAuditLog, listAuthorizedDatabases } from '../db/store.js';

const execSchema = z.object({
  connectionId: z.number().int().positive(),
  /** db0..db15 */
  database: z.string().max(16).optional().default('db0'),
  command: z.string().trim().min(1).max(10_000),
});

const inspectSchema = z.object({
  connectionId: z.number().int().positive(),
  database: z.string().max(16).optional().default('db0'),
  key: z.string().min(1).max(4096),
});

const createKeySchema = inspectSchema.extend({
  type: z.enum(['string', 'hash', 'list', 'set', 'zset']),
  value: z.string().max(100_000).optional().default(''),
  ttl: z.number().int().min(0).max(2_147_483_647).optional(),
});

/** agent 写 key 的权限与 SQL 写通道一致（AGENT_WRITE_ENABLED + 连接白名单） */
function agentWriteAllowed(connectionId: number): boolean {
  const cfg = loadConfig().agentWrite;
  return cfg.enabled
    && (cfg.connectionIds.length === 0 || cfg.connectionIds.includes(connectionId));
}

/** 写操作审计（不记录完整值，避免大对象/敏感内容进日志表） */
function writeKeyLog(user: { id: number; username: string; isAgent?: 0 | 1 }, conn: { id: number; name: string }, sql: string, result: string): void {
  insertAuditLog({
    userId: user.id,
    username: user.username,
    connectionId: conn.id,
    connectionName: conn.name,
    sql,
    riskLevel: 'medium',
    rulesHit: '',
    aiSummary: 'redis key 管理',
    decision: user.isAgent ? 'agent_write' : 'auto_allow',
    executed: 1,
    elapsedMs: 0,
    result,
  });
}

export async function redisRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authGuard);

  /** db 列表 + 各库 key 数量（树节点标注用；普通用户按授权 db 过滤） */
  app.get('/databases', async (req, reply) => {
    const id = Number((req.query as { connectionId?: string }).connectionId);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: '参数错误：connectionId 必填' });
    }
    const conn = connectionService().get(id);
    if (!conn || conn.type !== 'redis') {
      return reply.code(400).send({ error: '非 Redis 数据源' });
    }
    const user = req.user!;
    const allowed = listAuthorizedDatabases(user, id);
    if (allowed !== null && allowed.length === 0) {
      return reply.code(403).send({ error: '无权访问该数据源' });
    }
    const counts = await redisService().keyCounts(conn).catch(() => ({} as Record<string, number>));
    const all = Array.from({ length: 16 }, (_, i) => `db${i}`);
    const visible = allowed === null ? all : all.filter((db) => allowed.includes(db));
    return { databases: visible.map((db) => ({ db, keys: counts[db] ?? 0 })) };
  });

  /** 新增 key（可选类型与 TTL）；agent 需写权限开关 */
  app.post('/key', async (req, reply) => {
    const parsed = createKeySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    const { connectionId, database, key, type, value, ttl } = parsed.data;
    const user = req.user!;
    if (!hasDataPermission(user, connectionId, database)) {
      return reply.code(403).send({ error: '无权访问该数据源或数据库' });
    }
    const conn = connectionService().get(connectionId);
    if (!conn || conn.type !== 'redis') return reply.code(400).send({ error: '非 Redis 数据源' });
    if (user.isAgent && !agentWriteAllowed(connectionId)) {
      return reply.code(403).send({ error: 'agent token 未开启写权限' });
    }
    try {
      const cmd = await redisService().createKey(conn, database, { key, type, value, ttl });
      writeKeyLog(user, conn, `CREATE KEY ${key} (type=${type}, cmd=${cmd})`, `${cmd} 执行成功`);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** 删除 key；agent 需写权限开关 */
  app.post('/key/delete', async (req, reply) => {
    const parsed = inspectSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    const { connectionId, database, key } = parsed.data;
    const user = req.user!;
    if (!hasDataPermission(user, connectionId, database)) {
      return reply.code(403).send({ error: '无权访问该数据源或数据库' });
    }
    const conn = connectionService().get(connectionId);
    if (!conn || conn.type !== 'redis') return reply.code(400).send({ error: '非 Redis 数据源' });
    if (user.isAgent && !agentWriteAllowed(connectionId)) {
      return reply.code(403).send({ error: 'agent token 未开启写权限' });
    }
    try {
      const n = await redisService().deleteKey(conn, database, key);
      writeKeyLog(user, conn, `DELETE KEY ${key}`, n > 0 ? '已删除' : 'key 不存在');
      return { deleted: n };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** 点 key 看值：自动按数据类型执行对应命令（只读，agent 亦可用） */
  app.post('/inspect', async (req, reply) => {
    const parsed = inspectSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    const { connectionId, database, key } = parsed.data;
    const user = req.user!;
    if (!hasDataPermission(user, connectionId, database)) {
      return reply.code(403).send({ error: '无权访问该数据源或数据库' });
    }
    const conn = connectionService().get(connectionId);
    if (!conn || conn.type !== 'redis') return reply.code(400).send({ error: '非 Redis 数据源' });
    try {
      const { type, result } = await redisService().inspectKey(conn, database, key);
      insertAuditLog({
        userId: user.id,
        username: user.username,
        connectionId,
        connectionName: conn.name,
        sql: `INSPECT ${key}`,
        riskLevel: 'low',
        rulesHit: '',
        aiSummary: 'redis 值查看',
        decision: user.isAgent ? 'agent_readonly' : 'auto_allow',
        executed: 1,
        elapsedMs: result.elapsedMs,
        result: `TYPE ${type} · ${result.message}`,
      });
      return { type, result };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /**
   * 执行 Redis 命令（GET / SCAN / HGETALL / INFO ...）。
   * agent token 仅允许只读命令白名单；所有执行写审计日志。
   */
  app.post('/execute', async (req, reply) => {
    const parsed = execSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    const { connectionId, database, command } = parsed.data;
    const user = req.user!;

    if (!hasDataPermission(user, connectionId, database)) {
      return reply.code(403).send({ error: '无权访问该数据源或数据库' });
    }
    const conn = connectionService().get(connectionId);
    if (!conn) return reply.code(400).send({ error: '数据源不存在' });
    if (conn.type !== 'redis') {
      return reply.code(400).send({ error: '非 Redis 数据源，请使用 SQL 查询' });
    }
    // 全员黑名单：危险命令（CONFIG SET / MODULE LOAD 等 RCE 链路）与阻塞命令（挂死共享连接）
    if (isForbiddenCommand(command)) {
      return reply.code(403).send({ error: '该 Redis 命令被平台禁用（危险或阻塞命令）' });
    }
    // agent 写权限：需 AGENT_WRITE_ENABLED 开启，且连接在白名单内（若配置了白名单）
    const readonly = isReadonlyCommand(command);
    const agentWriteCfg = loadConfig().agentWrite;
    const writeAllowed = agentWriteCfg.enabled
      && (agentWriteCfg.connectionIds.length === 0 || agentWriteCfg.connectionIds.includes(connectionId));
    if (user.isAgent && !readonly && !writeAllowed) {
      return reply.code(403).send({ error: 'agent token 仅允许只读 Redis 命令' });
    }

    const start = Date.now();
    try {
      const { result, readonly: executedReadonly } = await redisService().execute(conn, database, command);
      insertAuditLog({
        userId: user.id,
        username: user.username,
        connectionId,
        connectionName: conn.name,
        sql: command,
        riskLevel: executedReadonly ? 'low' : 'medium',
        rulesHit: '',
        aiSummary: 'redis 命令',
        decision: user.isAgent
          ? (executedReadonly ? 'agent_readonly' : 'agent_write')
          : 'auto_allow',
        executed: 1,
        elapsedMs: result.elapsedMs,
        result: result.message,
      });
      return { result };
    } catch (e) {
      const msg = (e as Error).message;
      insertAuditLog({
        userId: user.id,
        username: user.username,
        connectionId,
        connectionName: conn.name,
        sql: command,
        riskLevel: readonly ? 'low' : 'medium',
        rulesHit: '',
        aiSummary: 'redis 命令',
        decision: user.isAgent
          ? (readonly ? 'agent_readonly' : 'agent_write')
          : 'auto_allow',
        executed: 0,
        elapsedMs: Date.now() - start,
        result: msg.slice(0, 500),
      });
      return reply.code(400).send({ error: msg });
    }
  });
}
