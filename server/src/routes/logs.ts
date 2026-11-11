import type { FastifyInstance } from 'fastify';
import { clearAuditLogs, getAuditLogById, listAuditLogs } from '../db/store.js';
import { connectionService } from '../services/connectionService.js';
import { esService } from '../services/esService.js';
import { llmAnalyzeSlowSql } from '../services/aiAuditService.js';
import { extractTableHints } from '../services/queryService.js';
import { leadingVerb } from '../drivers/sqlSplit.js';
import { authGuard, requireAdmin } from '../middleware/auth.js';
import { listAuthorizedConnectionIds } from '../db/store.js';
import type { DataSource } from '../types.js';

/** 慢 SQL 阈值（与前端展示标红一致） */
export const SLOW_SQL_MS = 1000;

/** 尽力而为地取上下文：失败返回 fallback，不阻塞分析 */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/** SQL 慢查询的证据上下文：涉及表的建表语句/索引/行数估算 + EXPLAIN 计划 */
async function buildSqlAnalysisContext(conn: DataSource, log: { sql: string }): Promise<string> {
  const driver = connectionService().getDriver(conn.id);
  const db = conn.database || '';
  const parts: string[] = [];
  try {
    const tables = extractTableHints(log.sql).slice(0, 3);
    if (tables.length > 0) {
      const tableRows = new Map(
        (await safe(() => driver.fetchTables(db, null), []))
          .map((t) => [t.name.toLowerCase(), t.rowCount])
      );
      for (const t of tables) {
        const rc = tableRows.get(t.toLowerCase());
        if (conn.type === 'mysql') {
          const createSql = await safe(async () => {
            const r = await driver.executeQuery(`SHOW CREATE TABLE \`${t.replace(/`/g, '``')}\``);
            return r.rows[0]?.[1] ?? '';
          }, '');
          if (createSql) parts.push(`表 ${t}（行数估算 ${rc ?? '未知'}）建表语句（含索引）：\n${createSql}`);
        } else {
          const cols = await safe(() => driver.fetchColumns(db, null, t), []);
          if (cols.length) parts.push(`表 ${t}（行数估算 ${rc ?? '未知'}）列：${cols.map((c) => `${c.name} ${c.dataType}`).join(', ')}`);
          const idx = await safe(async () => {
            const r = await driver.executeQuery(
              `SELECT indexdef FROM pg_indexes WHERE tablename = '${t.replace(/'/g, "''")}'`
            );
            return r.rows.map((row) => row[0]).join('\n');
          }, '');
          if (idx) parts.push(`表 ${t} 索引定义：\n${idx}`);
        }
      }
    }
    // 读语句再跑一次 EXPLAIN（不真正执行），把执行计划交给 LLM
    const verb = leadingVerb(log.sql);
    if (verb === 'SELECT' || verb === 'WITH') {
      const explain = await safe(async () => {
        const r = await driver.explain(log.sql);
        return r.rows.map((row) => row.join(' | ')).join('\n');
      }, '');
      if (explain) parts.push(`EXPLAIN 执行计划：\n${explain}`);
    }
  } catch {
    // 任何异常都不影响分析本身
  }
  return parts.join('\n\n').slice(0, 6000);
}

/** ES 慢搜索的证据上下文：实际搜索参数 + Mapping 字段 + 关键 Settings + 索引规模 */
async function buildEsAnalysisContext(conn: DataSource, log: { sql: string }): Promise<string> {
  const es = esService();
  const parts: string[] = [`实际搜索参数：${log.sql.slice(0, 1000)}`];
  try {
    const index = (JSON.parse(log.sql) as { index?: string }).index ?? '';
    if (index) {
      const fields = await safe(() => es.listFields(conn, index), []);
      if (fields.length) parts.push(`索引 Mapping 字段（${fields.length} 个）：${fields.join(', ').slice(0, 2000)}`);
      const settings = await safe(() => es.getIndexSettings(conn, index), {});
      if (Object.keys(settings).length) parts.push(`索引关键 Settings：${JSON.stringify(settings)}`);
      const indices = await safe(() => es.listIndices(conn, index), []);
      if (indices.length) {
        const totalDocs = indices.reduce((sum, it) => sum + it.docs, 0);
        parts.push(`模式匹配到 ${indices.length} 个索引，文档总量约 ${totalDocs}`);
      }
    }
  } catch {
    // 忽略：至少把搜索参数给到 LLM
  }
  return parts.join('\n');
}

export async function logRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authGuard);

  app.get('/', async (req) => {
    const q = req.query as { page?: string; pageSize?: string; userId?: string };
    const rawPage = Number(q.page ?? 1);
    const rawPageSize = Number(q.pageSize ?? 20);
    const page = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1;
    const pageSize = Number.isFinite(rawPageSize) ? Math.min(200, Math.max(1, Math.floor(rawPageSize))) : 20;
    const userId = req.user!.role === 'admin'
      ? (q.userId && Number.isInteger(Number(q.userId)) ? Number(q.userId) : undefined)
      : req.user!.id;
    const { items, total } = listAuditLogs({
      limit: pageSize,
      offset: (page - 1) * pageSize,
      userId,
    });
    return { items, total, page, pageSize };
  });

  /** 清空全部审计日志（仅管理员） */
  app.delete('/', { preHandler: requireAdmin }, async () => {
    clearAuditLogs();
    return { ok: true };
  });

  /** 慢 SQL 的 AI 分析（与日志列表同款可见性：普通用户仅限自己的日志） */
  app.post('/:id/analyze', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: '参数错误' });
    }
    const log = getAuditLogById(id);
    if (!log) return reply.code(404).send({ error: '日志不存在' });
    if (req.user!.role !== 'admin' && log.userId !== req.user!.id) {
      return reply.code(403).send({ error: '无权访问该日志' });
    }
    // 连接可能被改绑/转移：普通用户对日志涉及的连接已无权限时，不得借分析端点探测库结构
    // （agent 走 hasDataPermission 的全连接只读放行，不在此限制内）
    if (
      req.user!.role !== 'admin'
      && !req.user!.isAgent
      && log.connectionId != null
      && !(listAuthorizedConnectionIds(req.user!) ?? []).includes(log.connectionId)
    ) {
      return reply.code(403).send({ error: '无权访问该日志关联的数据源' });
    }
    if (!log.executed) {
      return reply.code(400).send({ error: '该记录未执行成功，无法分析' });
    }
    if (log.elapsedMs < SLOW_SQL_MS) {
      return reply.code(400).send({ error: '该记录耗时不足 1 秒，不属于慢 SQL' });
    }
    const conn = log.connectionId != null ? connectionService().get(log.connectionId) : null;
    // 把真实证据（表结构/索引/执行计划 或 ES mapping/settings/规模）一并交给 LLM
    const context = conn == null
      ? ''
      : conn.type === 'elasticsearch'
        ? await buildEsAnalysisContext(conn, log)
        : await buildSqlAnalysisContext(conn, log);
    let analysis: string;
    try {
      analysis = await llmAnalyzeSlowSql({
        sql: log.sql,
        elapsedMs: log.elapsedMs,
        databaseType: conn?.type ?? '未知',
        result: log.result,
        context,
      });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    return { analysis };
  });
}
