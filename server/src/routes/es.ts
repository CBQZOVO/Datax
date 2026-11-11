import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../middleware/auth.js';
import { loadConfig } from '../config.js';
import { connectionService } from '../services/connectionService.js';
import { esService } from '../services/esService.js';
import { indexAuthorized, insertAuditLog, listAuthorizedConnectionIds, listAuthorizedDatabases, listHiddenDatabasesFor } from '../db/store.js';
import type { DataSource } from '../types.js';

const conditionSchema = z.object({
  field: z.string().min(1).max(100).regex(/^[\w.@*-]+$/, '非法字段名'),
  value: z.string().min(1).max(500),
});

const searchSchema = z
  .object({
    connectionId: z.number().int().positive(),
    index: z.string().min(1).max(200),
    q: z.string().max(500).optional(),
    qField: z.string().max(100).regex(/^[\w.@-]+$/, '非法字段名').optional(),
    conditions: z.array(conditionSchema).max(10).optional(),
    /** 键值检索语法（field:value / -排除 / 范围 / 通配），与 q、conditions 互斥 */
    query: z.string().max(2000).optional(),
    start: z.string().max(64).optional(),
    end: z.string().max(64).optional(),
    timeField: z.string().max(100).regex(/^[\w.@-]+$/, '非法字段名').optional(),
    fields: z.array(z.string().min(1).max(100)).max(20).optional(),
    sort: z.string().max(200).optional(),
    size: z.number().int().min(1).max(2000).optional(),
    lines: z.boolean().optional().default(false),
  })
  .superRefine((data, ctx) => {
    const hasQuery = data.query !== undefined && data.query.trim() !== '';
    const hasLegacy =
      (data.q !== undefined && data.q.trim() !== '') ||
      (data.conditions !== undefined && data.conditions.length > 0);
    if (hasQuery && hasLegacy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['query'],
        message: 'query 与 q/conditions 互斥，请二选一',
      });
    }
  });

const dslSchema = z.object({
  connectionId: z.number().int().positive(),
  index: z.string().min(1).max(200),
  dsl: z.record(z.unknown()),
});

const deleteByIdSchema = z.object({
  connectionId: z.number().int().positive(),
  index: z.string().min(1).max(200),
  id: z.string().min(1).max(512),
});

const deleteQuerySchema = z.object({
  connectionId: z.number().int().positive(),
  index: z.string().min(1).max(200),
  field: z.string().min(1).max(100).regex(/^[\w.@*-]+$/, '非法字段名'),
  /** 值必填：禁止无条件删除 */
  value: z.string().min(1).max(500),
  start: z.string().max(64).optional(),
  end: z.string().max(64).optional(),
  /** 单次删除硬上限 */
  maxDocs: z.number().int().min(1).max(10000).optional().default(1000),
});

/** 按 _id 部分更新：doc 为要合并的字段（非全量替换，未提及字段保持原值） */
const updateByIdSchema = z.object({
  connectionId: z.number().int().positive(),
  index: z.string().min(1).max(200),
  id: z.string().min(1).max(512),
  doc: z.record(z.unknown()),
});

/** 创建索引：可选 settings / mappings（均为对象） */
const createIndexSchema = z.object({
  connectionId: z.number().int().positive(),
  index: z.string().min(1).max(200),
  settings: z.record(z.unknown()).optional(),
  mappings: z.record(z.unknown()).optional(),
});

/** 给已有索引加字段：mappings 对象（仅新增字段） */
const putMappingSchema = z.object({
  connectionId: z.number().int().positive(),
  index: z.string().min(1).max(200),
  mappings: z.record(z.unknown()),
});

/** 删除索引：index 具体索引名 */
const deleteIndexSchema = z.object({
  connectionId: z.number().int().positive(),
  index: z.string().min(1).max(200),
});

/** 递归检测 DSL 中是否含脚本执行字段（painless 沙箱历史上有逃逸风险，全员禁用） */
function containsScript(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(containsScript);
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'script' || k === 'script_fields' || k === 'runtime_mappings' || k === 'runtime') return true;
      if (containsScript(v)) return true;
    }
  }
  return false;
}

/** 删除条件 DSL：字段 match_phrase + 可选 @timestamp 范围 */
function buildDeleteDsl(field: string, value: string, start?: string, end?: string): Record<string, unknown> {
  const filter: unknown[] = [];
  if (start || end) {
    const range: Record<string, string> = {};
    if (start) range.gte = start;
    if (end) range.lt = end;
    filter.push({ range: { '@timestamp': range } });
  }
  return {
    query: {
      bool: {
        must: [{ match_phrase: { [field]: value } }],
        ...(filter.length ? { filter } : {}),
      },
    },
  };
}

/** ES 写操作（删除/修改）权限：仅管理员；agent 需写开关 + 白名单；且必须在授权视图范围内 */
function assertWritePermission(
  user: { id: number; role: 'admin' | 'user'; isAgent?: 0 | 1 },
  connectionId: number,
  index: string,
  reply: FastifyReply
): boolean {
  if (user.role !== 'admin' && !user.isAgent) {
    reply.code(403).send({ error: '仅管理员可修改/删除 ES 文档' });
    return false;
  }
  if (user.isAgent) {
    const cfg = loadConfig().agentWrite;
    if (!cfg.enabled || (cfg.connectionIds.length > 0 && !cfg.connectionIds.includes(connectionId))) {
      reply.code(403).send({ error: 'agent token 未开启写权限' });
      return false;
    }
  }
  return checkIndexPermission(user, connectionId, index, reply);
}

function logEsWrite(
  user: { id: number; username: string; isAgent?: 0 | 1 },
  conn: { id: number; name: string },
  aiSummary: string,
  sql: string,
  result: string
): void {
  insertAuditLog({
    userId: user.id,
    username: user.username,
    connectionId: conn.id,
    connectionName: conn.name,
    sql,
    riskLevel: 'high',
    rulesHit: '',
    aiSummary,
    decision: user.isAgent ? 'agent_write' : 'auto_allow',
    executed: 1,
    elapsedMs: 0,
    result,
  });
}

/** 连接级权限检查：返回 true 放行；false 时已写好 403 响应 */
function checkConnectionPermission(
  user: { id: number; role: 'admin' | 'user'; isAgent?: 0 | 1 },
  connectionId: number,
  reply: FastifyReply
): boolean {
  if (user.isAgent || user.role === 'admin') return true;
  const allowed = listAuthorizedConnectionIds(user);
  if (allowed === null || allowed.includes(connectionId)) return true;
  reply.code(403).send({ error: '无权访问该数据源' });
  return false;
}

/** database（视图）级权限：请求的 index 须命中授权条目（支持前缀模式，双向兼容旧授权的具体索引名） */
function checkIndexPermission(
  user: { id: number; role: 'admin' | 'user'; isAgent?: 0 | 1 },
  connectionId: number,
  index: string,
  reply: FastifyReply
): boolean {
  if (user.isAgent || user.role === 'admin') return true;
  const allowed = listAuthorizedDatabases(user, connectionId) ?? [];
  if (allowed.some((a) => indexAuthorized(a, index))) return true;
  reply.code(403).send({ error: '无权访问该视图' });
  return false;
}

/** 取 ES 数据源并校验类型；异常时返回 undefined（响应已写好） */
function getEsDataSource(
  user: { id: number; role: 'admin' | 'user'; isAgent?: 0 | 1 },
  connectionId: number,
  reply: FastifyReply
): { ok: false } | { ok: true; ds: DataSource } {
  const ds = connectionService().get(connectionId);
  if (!ds) {
    reply.code(404).send({ error: '数据源不存在' });
    return { ok: false };
  }
  if (ds.type !== 'elasticsearch') {
    reply.code(400).send({ error: '非 ES 数据源，请使用 SQL 查询' });
    return { ok: false };
  }
  if (!checkConnectionPermission(user, connectionId, reply)) return { ok: false };
  return { ok: true, ds };
}

export async function esRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authGuard);

  /** 索引列表：GET /api/es/indices?connectionId=2&pattern=xxx* */
  app.get('/indices', async (req, reply) => {
    const { connectionId, pattern } = req.query as { connectionId?: string; pattern?: string };
    const id = Number(connectionId);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: '参数错误：connectionId 必填' });
    }
    const got = getEsDataSource(req.user!, id, reply);
    if (!got.ok) return;
    try {
      let indices = await esService().listIndices(got.ds, pattern);
      // 普通用户只见授权视图覆盖的索引（树的视图聚合基于此列表，自然只剩授权视图）；
      // 管理员剔除自己配置的隐藏视图（隐藏条目存的是视图模式，如 xxx-*）
      if (!req.user!.isAgent && req.user!.role !== 'admin') {
        const allowed = listAuthorizedDatabases(req.user!, id) ?? [];
        indices = indices.filter((it) => allowed.some((a) => indexAuthorized(a, it.name)));
      } else if (req.user!.role === 'admin') {
        const hidden = listHiddenDatabasesFor(req.user!.id, id);
        indices = indices.filter((it) => !hidden.some((h) => indexAuthorized(h, it.name)));
      }
      return { indices };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** 集群版本：GET /api/es/version?connectionId=2（供前端展示，写端点据此自适应） */
  app.get('/version', async (req, reply) => {
    const { connectionId } = req.query as { connectionId?: string };
    const id = Number(connectionId);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: '参数错误：connectionId 必填' });
    }
    const got = getEsDataSource(req.user!, id, reply);
    if (!got.ok) return;
    try {
      return { version: await esService().getMajorVersion(got.ds) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** 索引详情：GET /api/es/detail?connectionId&index（只读，完整 settings + mapping） */
  app.get('/detail', async (req, reply) => {
    const { connectionId, index } = req.query as { connectionId?: string; index?: string };
    const id = Number(connectionId);
    if (!Number.isInteger(id) || id <= 0 || !index) {
      return reply.code(400).send({ error: '参数错误：connectionId 与 index 必填' });
    }
    const got = getEsDataSource(req.user!, id, reply);
    if (!got.ok) return;
    if (!checkIndexPermission(req.user!, id, index, reply)) return;
    try {
      return await esService().getIndexDetail(got.ds, index);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** 创建索引（可选 settings / mappings） */
  app.post('/create-index', async (req, reply) => {
    const parsed = createIndexSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误：index 必填，settings/mappings 须为对象' });
    const { connectionId, index, settings, mappings } = parsed.data;
    const got = getEsDataSource(req.user!, connectionId, reply);
    if (!got.ok) return;
    if (!assertWritePermission(req.user!, connectionId, index, reply)) return;
    try {
      const created = await esService().createIndex(got.ds, index, { settings, mappings });
      logEsWrite(req.user!, got.ds, 'ES 创建索引', `CREATE INDEX ${index}`, created ? '已创建' : '索引可能已存在');
      return { created };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** 给已有索引加字段（仅新增字段，不改已有字段类型） */
  app.post('/put-mapping', async (req, reply) => {
    const parsed = putMappingSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误：mappings 须为对象' });
    const { connectionId, index, mappings } = parsed.data;
    const got = getEsDataSource(req.user!, connectionId, reply);
    if (!got.ok) return;
    if (!assertWritePermission(req.user!, connectionId, index, reply)) return;
    try {
      const updated = await esService().putMapping(got.ds, index, mappings);
      logEsWrite(req.user!, got.ds, 'ES 更新映射', `PUT MAPPING ${index}`, updated ? '已更新' : '无变化');
      return { updated };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** 删除索引（不可恢复，仅管理员；前端二次确认 + 输入索引名） */
  app.post('/delete-index', async (req, reply) => {
    const parsed = deleteIndexSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误：index 必填' });
    const { connectionId, index } = parsed.data;
    const got = getEsDataSource(req.user!, connectionId, reply);
    if (!got.ok) return;
    if (req.user!.role !== 'admin') {
      return reply.code(403).send({ error: '仅管理员可删除索引' });
    }
    try {
      const deleted = await esService().deleteIndex(got.ds, index);
      logEsWrite(req.user!, got.ds, 'ES 删除索引', `DROP INDEX ${index}`, deleted ? '已删除' : '索引不存在');
      return { deleted };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** 字段列表：GET /api/es/fields?connectionId=2&index=xxx（mapping 展平后的字段点路径） */
  app.get('/fields', async (req, reply) => {
    const { connectionId, index } = req.query as { connectionId?: string; index?: string };
    const id = Number(connectionId);
    if (!Number.isInteger(id) || id <= 0 || !index) {
      return reply.code(400).send({ error: '参数错误：connectionId 与 index 必填' });
    }
    const got = getEsDataSource(req.user!, id, reply);
    if (!got.ok) return;
    if (!checkIndexPermission(req.user!, id, index, reply)) return;
    try {
      return { fields: await esService().listFields(got.ds, index) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** 按 _id 取文档原文（读权限即可，供编辑前回显） */
  app.get('/doc', async (req, reply) => {
    const { connectionId, index, id } = req.query as { connectionId?: string; index?: string; id?: string };
    const cid = Number(connectionId);
    if (!Number.isInteger(cid) || cid <= 0 || !index || !id) {
      return reply.code(400).send({ error: '参数错误：connectionId / index / id 必填' });
    }
    const got = getEsDataSource(req.user!, cid, reply);
    if (!got.ok) return;
    if (!checkIndexPermission(req.user!, cid, index, reply)) return;
    try {
      const doc = await esService().getDocById(got.ds, index, id);
      return { doc };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** 按 _id 部分更新文档（doc 合并写，未提及字段保持原值）；权限与删除同闸 */
  app.post('/update-by-id', async (req, reply) => {
    const parsed = updateByIdSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误：doc 须为字段对象' });
    const { connectionId, index, id, doc } = parsed.data;
    const got = getEsDataSource(req.user!, connectionId, reply);
    if (!got.ok) return;
    if (!assertWritePermission(req.user!, connectionId, index, reply)) return;
    try {
      const updated = await esService().updateById(got.ds, index, id, doc);
      logEsWrite(req.user!, got.ds, 'ES 文档更新', `UPDATE ${index}/${id} ${JSON.stringify(doc).slice(0, 2000)}`, updated ? '已更新 1 条' : '文档未变更');
      return { updated };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** 按 _id 删除单条文档（index 须为具体索引） */
  app.post('/delete-by-id', async (req, reply) => {
    const parsed = deleteByIdSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    const { connectionId, index, id } = parsed.data;
    const got = getEsDataSource(req.user!, connectionId, reply);
    if (!got.ok) return;
    if (!assertWritePermission(req.user!, connectionId, index, reply)) return;
    try {
      const deleted = await esService().deleteById(got.ds, index, id);
      logEsWrite(req.user!, got.ds, 'ES 文档删除', `DELETE BY ID ${index}/${id}`, deleted > 0 ? '已删除 1 条' : '文档不存在');
      return { deleted };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** 条件删除预览：仅 _count，不产生变更 */
  app.post('/delete-by-query/preview', async (req, reply) => {
    const parsed = deleteQuerySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    const { connectionId, index, field, value, start, end } = parsed.data;
    const got = getEsDataSource(req.user!, connectionId, reply);
    if (!got.ok) return;
    if (!assertWritePermission(req.user!, connectionId, index, reply)) return;
    try {
      const count = await esService().countByQuery(got.ds, index, buildDeleteDsl(field, value, start, end));
      return { count };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** 条件删除：执行前重新 _count 校验，超过 maxDocs 直接拒绝 */
  app.post('/delete-by-query', async (req, reply) => {
    const parsed = deleteQuerySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    const { connectionId, index, field, value, start, end, maxDocs } = parsed.data;
    const got = getEsDataSource(req.user!, connectionId, reply);
    if (!got.ok) return;
    if (!assertWritePermission(req.user!, connectionId, index, reply)) return;
    try {
      const dsl = buildDeleteDsl(field, value, start, end);
      const count = await esService().countByQuery(got.ds, index, dsl);
      if (count > maxDocs) {
        return reply.code(400).send({ error: `匹配 ${count} 条，超过单次上限 ${maxDocs}，请缩小条件或调大上限` });
      }
      const deleted = await esService().deleteByQuery(got.ds, index, dsl, maxDocs);
      logEsWrite(req.user!, got.ds, 'ES 文档删除', `DELETE BY QUERY ${index} WHERE ${field} LIKE ${value}`, `已删除 ${deleted} 条`);
      return { deleted };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** 原生 DSL 查询：POST /{index}/_search，body 即 ES 查询 DSL */
  app.post('/dsl', async (req, reply) => {
    const parsed = dslSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误：dsl 须为 JSON 对象' });
    const { connectionId, index, dsl } = parsed.data;
    const got = getEsDataSource(req.user!, connectionId, reply);
    if (!got.ok) return;
    if (!checkIndexPermission(req.user!, connectionId, index, reply)) return;

    const user = req.user!;
    // 全员禁用脚本执行（script / script_fields / runtime_mappings），避免 painless 执行面被放大
    if (containsScript(dsl)) {
      return reply.code(403).send({ error: 'DSL 不允许使用脚本（script / script_fields / runtime_mappings）' });
    }

    const start0 = Date.now();
    const logInput = {
      userId: user.id,
      username: user.username,
      connectionId,
      connectionName: got.ds.name,
      sql: JSON.stringify(dsl).slice(0, 4000),
      riskLevel: 'low' as const,
      rulesHit: '',
      aiSummary: 'es dsl 查询',
      decision: (user.isAgent ? 'agent_readonly' : 'auto_allow') as 'agent_readonly' | 'auto_allow',
      executed: 1,
      elapsedMs: 0,
      result: '',
    };
    try {
      const result = await esService().searchDsl(got.ds, index, dsl);
      insertAuditLog({ ...logInput, elapsedMs: Date.now() - start0, result: `total=${result.total}` });
      const format = (req.query as { format?: string }).format;
      if (format === 'csv') {
        const cols = result.hits.length > 0 ? Object.keys(result.hits[0]) : [];
        const esc = (v: unknown) => {
          const s = v == null ? '' : String(v);
          if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
          if (/^[=+@]/.test(s)) return `'${s}`; // CSV 公式注入防护
          return s;
        };
        return reply.type('text/csv; charset=utf-8').send([
          cols.map(esc).join(','),
          ...result.hits.map((hit) => cols.map((c) => esc(hit[c])).join(',')),
        ].join('\n'));
      }
      return result;
    } catch (e) {
      insertAuditLog({
        ...logInput,
        executed: 0,
        elapsedMs: Date.now() - start0,
        result: (e as Error).message.slice(0, 500),
      });
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** 参数化搜索：POST /api/es/search（支持 ?format=csv 且 lines=true 时输出行文本） */
  app.post('/search', async (req, reply) => {
    const parsed = searchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误', detail: parsed.error.issues });
    const { connectionId, index, q, qField, conditions, query, start, end, timeField, fields, sort, size, lines } = parsed.data;

    const got = getEsDataSource(req.user!, connectionId, reply);
    if (!got.ok) return;
    if (!checkIndexPermission(req.user!, connectionId, index, reply)) return;

    const user = req.user!;
    const start0 = Date.now();
    const logInput = {
      userId: user.id,
      username: user.username,
      connectionId,
      connectionName: got.ds.name,
      sql: JSON.stringify({ index, q, conditions, query, start, end, timeField, size, fields }),
      riskLevel: 'low' as const,
      rulesHit: '',
      aiSummary: 'es search',
      decision: (user.isAgent ? 'agent_readonly' : 'auto_allow') as 'agent_readonly' | 'auto_allow',
      executed: 1,
      elapsedMs: 0,
      result: '',
    };
    try {
      const result = await esService().search(got.ds, { index, q, qField, conditions, query, start, end, timeField, fields, sort, size, lines });
      insertAuditLog({ ...logInput, elapsedMs: Date.now() - start0, result: `共匹配 ${result.total} 条 · 返回 ${result.hits.length} 行` });
      const format = (req.query as { format?: string }).format;
      if (format === 'csv' && result.lines) {
        return reply.type('text/csv; charset=utf-8').send(result.lines.join('\n'));
      }
      return result;
    } catch (e) {
      insertAuditLog({
        ...logInput,
        executed: 0,
        elapsedMs: Date.now() - start0,
        result: (e as Error).message.slice(0, 500),
      });
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
}
