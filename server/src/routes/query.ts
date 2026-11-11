import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { queryService, GateError } from '../services/queryService.js';
import { authGuard, requireAdmin } from '../middleware/auth.js';
import { connectionService } from '../services/connectionService.js';
import { hasDataPermission } from '../db/store.js';
import { getApprovalRequest, listApprovalRequests } from '../db/store.js';
import { leadingVerb, splitSqlStatements } from '../drivers/sqlSplit.js';
import type { ApprovalRequest } from '../types.js';

const queryInputSchema = z.object({
  connectionId: z.number().int().positive(),
  sql: z.string().trim().min(1).max(1_000_000),
  database: z.string().max(256).optional().default(''),
  /** 仅 agent 通道生效：结果集行数上限，默认 1000，最大 10000 */
  maxRows: z.number().int().min(1).max(10_000).optional().default(1000),
});

const explainSchema = z.object({
  auditId: z.string().uuid(),
});

const confirmSchema = z.object({
  auditId: z.string().uuid(),
  confirmed: z.boolean(),
});

const approvalStatusSchema = z.enum(['pending', 'processing', 'approved', 'rejected', 'failed', 'cancelled']);
const reviewSchema = z.object({
  approved: z.boolean(),
  comment: z.string().trim().max(1000).optional().default(''),
});

/** QueryResult → CSV（RFC 4180；NULL 输出为 \N，空串输出为空字段） */
function toCsv(result: { columns: string[]; rows: (string | null)[][]; truncated?: boolean }): string {
  const escape = (value: string | null): string => {
    if (value === null) return '\\N';
    // CSV 公式注入防护：以 = + @ 开头的值加前缀（- 不转义，避免破坏负数）
    if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
    if (/^[=+@]/.test(value)) return `'${value}`;
    return value;
  };
  const lines = [result.columns.map(escape).join(',')];
  for (const row of result.rows) {
    lines.push(row.map((cell) => escape(cell === null ? null : String(cell))).join(','));
  }
  if (result.truncated) {
    lines.push(`-- truncated at ${result.rows.length} rows (more rows exist)`);
  }
  return lines.join('\n');
}

/**
 * 程序化生成筛选/排序 SQL：子查询包裹原 SQL，按列 LIKE 过滤 + 排序。
 * 原最外层的尾缀 LIMIT/OFFSET 会被剥离，保证筛选/排序作用于全量结果而非截断后的行。
 * 值原样保留用户输入的 % 通配符。
 */
function buildFilterSql(
  sql: string,
  filters: { column: string; value: string }[],
  dbType: 'mysql' | 'postgres',
  sort?: { column: string; order: 'asc' | 'desc' } | null
): string {
  const inner = sql.trim()
    .replace(/;\s*$/, '')
    .replace(/\s+LIMIT\s+\d+(?:\s*,\s*\d+)?(?:\s+OFFSET\s+\d+)?\s*$/i, '');
  const lit = (v: string) =>
    dbType === 'mysql'
      ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
      : `'${v.replace(/'/g, "''")}'`;
  const ident = (c: string) =>
    dbType === 'mysql' ? `\`${c.replace(/`/g, '``')}\`` : `"${c.replace(/"/g, '""')}"`;
  // LIKE 的列引用：PG 的 LIKE 仅支持文本，非文本列（数值/时间）需 ::text；MySQL 隐式转换无需 cast
  const likeCol = (c: string) =>
    dbType === 'mysql'
      ? `\`${c.replace(/`/g, '``')}\``
      : `"${c.replace(/"/g, '""')}"::text`;
  const parts: string[] = [`SELECT * FROM (\n${inner}\n) AS __datax_filter`];
  if (filters.length > 0) {
    parts.push(`WHERE ${filters.map((f) => `${likeCol(f.column)} LIKE ${lit(f.value)}`).join(' AND ')}`);
  }
  if (sort) {
    parts.push(`ORDER BY ${ident(sort.column)} ${sort.order === 'asc' ? 'ASC' : 'DESC'}`);
  }
  // 外层保护性上限：筛选作用于全量结果，但最多返回 1 万行（同时避免被审计判为「未分页」中危）
  parts.push('LIMIT 10000');
  return parts.join('\n');
}

export async function queryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authGuard);

  /**
   * 执行 SQL（自动 AI 审计）。
   * 返回三种结果之一：
   * - { needsConfirm: false, result }
   * - { needsConfirm: true, auditId, audit }  → 前端展示审计结论 → /explain → /confirm
   * agent token：走只读通道 executeReadonly，支持 ?format=csv
   */
  app.post('/execute', async (req, reply) => {
    const parsed = queryInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    const { connectionId, sql, database, maxRows } = parsed.data;
    const user = req.user!;

    if (user.isAgent) {
      try {
        const result = await queryService().executeReadonly(connectionId, sql, database, user, maxRows);
        const format = (req.query as { format?: string }).format;
        if (format === 'csv') {
          return reply.type('text/csv; charset=utf-8').send(toCsv(result));
        }
        return { needsConfirm: false, result };
      } catch (e) {
        return reply.code(e instanceof GateError ? 403 : 400)
          .send({ error: (e as Error).message });
      }
    }

    try {
      const audit = await queryService().audit(connectionId, sql, database, user);
      if (audit.needsConfirm) {
        return { needsConfirm: true, auditId: audit.auditId, audit: audit.audit };
      }
      const result = await queryService().executeLowRisk(connectionId, sql, database, audit.audit, user);
      return { needsConfirm: false, result };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** EXPLAIN 预查询：不真正执行写操作，返回执行计划 */
  app.post('/explain', async (req, reply) => {
    if (req.user!.isAgent) return reply.code(403).send({ error: 'agent token 仅允许只读查询' });
    const parsed = explainSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    try {
      const explain = await queryService().explain(parsed.data.auditId, req.user!);
      return { explain };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** 二次确认：confirmed=true 执行，false 拒绝；均写审计日志 */
  app.post('/confirm', async (req, reply) => {
    if (req.user!.isAgent) return reply.code(403).send({ error: 'agent token 仅允许只读查询' });
    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    try {
      const out = await queryService().confirm(parsed.data.auditId, parsed.data.confirmed, req.user!);
      return out;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** 仅审计，不执行（编辑器实时安全提示） */
  app.post('/audit-only', async (req, reply) => {
    // agent 走只读执行通道，不调 LLM；此处对写 SQL 会触发 LLM 审计，拒掉避免用 agent token 放大 LLM 成本
    if (req.user!.isAgent) return reply.code(403).send({ error: 'agent token 仅允许只读查询' });
    const parsed = queryInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    try {
      const audit = await queryService().auditOnly(
        parsed.data.connectionId,
        parsed.data.sql,
        parsed.data.database,
        req.user!
      );
      return { audit };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/is-write', async (req, reply) => {
    const parsed = queryInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    return { isWrite: queryService().isWrite(parsed.data.sql) };
  });

  const filterSqlSchema = z.object({
    connectionId: z.number().int().positive(),
    database: z.string().max(256).optional().default(''),
    sql: z.string().trim().min(1).max(1_000_000),
    filters: z.array(z.object({
      column: z.string().min(1).max(200),
      value: z.string().min(1).max(1000),
    })).max(20).optional().default([]),
    sort: z.object({
      column: z.string().min(1).max(200),
      order: z.enum(['asc', 'desc']),
    }).optional(),
  });

  /**
   * 结果集筛选/排序：原 SQL + 列筛选条件 + 排序 → 程序化生成新查询 SQL（确定性、毫秒级，不调 LLM）。
   * 只生成不执行；执行仍由前端走 /execute 的审计链路，生成结果回显编辑器可复核。
   */
  app.post('/filter-sql', async (req, reply) => {
    const parsed = filterSqlSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    const { connectionId, database, sql, filters, sort } = parsed.data;
    if (filters.length === 0 && !sort) {
      return reply.code(400).send({ error: '请至少提供一个筛选条件或排序' });
    }
    if (!hasDataPermission(req.user!, connectionId, database)) {
      return reply.code(403).send({ error: '无权访问该数据源或数据库' });
    }
    const conn = connectionService().get(connectionId);
    if (!conn) return reply.code(400).send({ error: '数据源不存在' });
    if (conn.type === 'elasticsearch') {
      return reply.code(400).send({ error: 'ES 数据源不支持 SQL 筛选，请用条件栏过滤' });
    }
    const verb = leadingVerb(splitSqlStatements(sql)[0] ?? '');
    if (verb !== 'SELECT' && verb !== 'WITH') {
      return reply.code(400).send({ error: '仅支持对查询结果筛选（原 SQL 须为 SELECT / WITH）' });
    }
    return { sql: buildFilterSql(sql, filters, conn.type === 'postgres' ? 'postgres' : 'mysql', sort) };
  });

  app.get('/approvals', async (req, reply) => {
    const statusRaw = (req.query as { status?: string }).status;
    const parsedStatus = statusRaw ? approvalStatusSchema.safeParse(statusRaw) : null;
    if (parsedStatus && !parsedStatus.success) return reply.code(400).send({ error: '审批状态无效' });
    const opts: { status?: ApprovalRequest['status']; requesterId?: number } = {};
    if (parsedStatus?.success) opts.status = parsedStatus.data;
    if (req.user!.role !== 'admin') opts.requesterId = req.user!.id;
    return { approvals: listApprovalRequests(opts) };
  });

  app.get('/approvals/:id', async (req, reply) => {
    const approval = getApprovalRequest((req.params as { id: string }).id);
    if (!approval) return reply.code(404).send({ error: '审批单不存在' });
    if (req.user!.role !== 'admin' && approval.requesterId !== req.user!.id) {
      return reply.code(403).send({ error: '无权查看该审批单' });
    }
    return { approval };
  });

  app.post('/approvals/:id/cancel', async (req, reply) => {
    if (req.user!.role === 'admin') return reply.code(403).send({ error: '管理员不能取消用户的审批申请' });
    try {
      return { approval: queryService().cancelApproval((req.params as { id: string }).id, req.user!) };
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  app.post('/approvals/:id/review', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    try {
      return await queryService().reviewApproval(
        (req.params as { id: string }).id,
        parsed.data.approved,
        parsed.data.comment,
        req.user!
      );
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
}
