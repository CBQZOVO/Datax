import pg from 'pg';
import type {
  ColumnInfo, ConnectionOptions, DatabaseDriver, ExplainResult, QueryResult, TableInfo,
} from './types.js';
import { splitSqlStatements, leadingVerb } from './sqlSplit.js';

const WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE']);

/** PG 计划节点类型 → 中文说明 */
const PG_NODE_CN: Record<string, string> = {
  'Seq Scan': '全表扫描',
  'Index Scan': '索引扫描',
  'Index Only Scan': '仅索引扫描',
  'Bitmap Heap Scan': '位图取数',
  'Bitmap Index Scan': '位图索引',
  'Tid Scan': '按行号扫描',
  'Nested Loop': '嵌套循环连接',
  'Hash Join': '哈希连接',
  'Merge Join': '合并连接',
  'Hash': '构建哈希表',
  'Sort': '排序',
  'Aggregate': '聚合',
  'GroupAggregate': '分组聚合',
  'HashAggregate': '哈希聚合',
  'Limit': '限制行数',
  'Gather': '并行汇总',
  'Gather Merge': '并行归并',
  'Result': '结果',
  'Function Scan': '函数扫描',
  'Values Scan': '常量扫描',
  'CTE Scan': 'CTE 扫描',
  'Subquery Scan': '子查询',
  'Append': '合并结果',
  'Unique': '去重',
  'SetOp': '集合运算',
};

/** 把 PG JSON 计划的单个节点渲染为中文缩进树（扫描方式/表/索引/预估行数），递归子计划 */
function formatPlanNode(node: Record<string, unknown>, depth: number, out: string[]): void {
  const nodeType = typeof node['Node Type'] === 'string' ? node['Node Type'] : '';
  const segs: string[] = [];
  const label = PG_NODE_CN[nodeType] ?? nodeType;
  if (label) segs.push(label);
  if (typeof node['Relation Name'] === 'string') segs.push(`表 ${node['Relation Name']}`);
  if (typeof node['Index Name'] === 'string') segs.push(`索引 ${node['Index Name']}`);
  const rows = node['Plan Rows'];
  if (typeof rows === 'number' && Number.isFinite(rows)) segs.push(`预计 ${rows.toLocaleString('en-US')} 行`);
  const indent = '    '.repeat(depth);
  out.push(`${indent}${depth > 0 ? '→ ' : ''}${segs.join(' · ')}`);
  const children = node.Plans;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (child && typeof child === 'object') formatPlanNode(child as Record<string, unknown>, depth + 1, out);
    }
  }
}

/** 把计划树翻译成一行普通用户能懂的结论（放计划文本最前） */
function planSummaryLine(verb: string, rows: number | null, planLines: string): string {
  const isWrite = WRITE_VERBS.has(verb);
  const rowsText = rows != null ? `约 ${rows.toLocaleString('en-US')} 行` : '行数无法预估';
  const usedIndex = planLines.includes('索引');
  const seqOnly = !usedIndex && planLines.includes('全表扫描');
  let text = isWrite ? `本次写操作预计影响 ${rowsText}` : `本次查询预计读取 ${rowsText}`;
  if (usedIndex) text += '，已使用索引';
  else if (seqOnly) text += '，全表扫描（未使用索引）';
  if (seqOnly && rows != null && rows > 10_000) {
    text += ' · 数据量较大且未走索引，建议检查 WHERE 条件或相关索引';
  }
  return `【结论】${text}`;
}

const { Pool } = pg;

// DATE/TIMESTAMP/TIMESTAMPTZ 保留 PG 原始文本，避免被解析成 JS Date
// 后 String() 成 "Thu Nov 12 2020 ..." 的难看格式
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1114, (v) => v);
pg.types.setTypeParser(1184, (v) => v);

export class PostgresDriver implements DatabaseDriver {
  private pool: pg.Pool;

  constructor(private opts: ConnectionOptions) {
    this.pool = new Pool({
      host: opts.host,
      port: opts.port,
      user: opts.username,
      password: opts.password,
      database: opts.database || 'postgres',
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      application_name: 'datax',
    });
  }

  /**
   * 设置当前连接的语句超时（毫秒），返回还原函数；与 MySQL 驱动的 60s 默认行为对齐。
   * 查询失败可能留下 aborted 事务（如显式 BEGIN 中途超时），此时连接必须销毁而非归还池，
   * 因此 executeQuery 在失败路径以 release(err) 销毁连接。
   */
  private async applyStatementTimeout(c: pg.PoolClient, timeoutMs?: number): Promise<() => Promise<void>> {
    const ms = Math.max(1000, Math.floor(timeoutMs ?? 60_000));
    await c.query(`SET statement_timeout = ${ms}`);
    return async () => {
      await c.query('SET statement_timeout = 0').catch(() => undefined);
    };
  }

  private async withConn<T>(db: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      if (db && db !== this.opts.database) {
        // pg.Pool 绑定到构造时的 database，运行时无法切换；这里只做存在性校验，
        // 真正的库切换由 ConnectionService.getDriverForDatabase 负责
        const exists = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
        if (exists.rowCount === 0) throw new Error(`Database "${db}" does not exist`);
      }
      return await fn(c);
    } finally {
      c.release();
    }
  }

  async testConnection(): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('SELECT 1');
    } finally {
      c.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async fetchDatabases(): Promise<string[]> {
    return this.withConn('', async (c) => {
      const r = await c.query('SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname');
      return r.rows.map((x) => x.datname as string);
    });
  }

  async fetchSchemas(db: string): Promise<string[]> {
    return this.withConn(db || this.opts.database || 'postgres', async (c) => {
      const r = await c.query(
        `SELECT schema_name FROM information_schema.schemata
         WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema'
         ORDER BY schema_name`
      );
      return r.rows.map((x) => x.schema_name as string);
    });
  }

  async fetchTables(db: string, schema: string | null, limit?: number): Promise<TableInfo[]> {
    return this.withConn(db || this.opts.database || 'postgres', async (c) => {
      const sch = schema || this.opts.schema || 'public';
      const r = await c.query(
        `SELECT c.relname AS name, COALESCE(s.n_live_tup, c.reltuples, 0)::bigint AS "rowCount",
                obj_description(c.oid) AS comment
         FROM pg_class c
         JOIN pg_namespace n ON c.relnamespace = n.oid
         LEFT JOIN pg_stat_user_tables s ON c.relname = s.relname AND n.nspname = s.schemaname
         WHERE c.relkind = 'r' AND n.nspname = $1
         ORDER BY c.relname
         ${limit ? `LIMIT ${Math.floor(limit)}` : ''}`,
        [sch]
      );
      return r.rows.map((x) => ({
        name: x.name as string,
        rowCount: x.rowCount == null ? null : Number(x.rowCount),
        comment: x.comment ? String(x.comment) : null,
      }));
    });
  }

  async fetchViews(db: string, schema: string | null): Promise<string[]> {
    return this.withConn(db || this.opts.database || 'postgres', async (c) => {
      const sch = schema || this.opts.schema || 'public';
      const r = await c.query(
        `SELECT table_name AS name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'VIEW' ORDER BY table_name`,
        [sch]
      );
      return r.rows.map((x) => x.name as string);
    });
  }

  async searchTables(db: string, schema: string | null, keyword: string, limit = 50): Promise<TableInfo[]> {
    const kw = keyword.trim();
    if (!kw) return [];
    return this.withConn(db || this.opts.database || 'postgres', async (c) => {
      const sch = schema || this.opts.schema || 'public';
      const r = await c.query(
        `SELECT c.relname AS name, COALESCE(s.n_live_tup, c.reltuples, 0)::bigint AS "rowCount",
                obj_description(c.oid) AS comment
         FROM pg_class c
         JOIN pg_namespace n ON c.relnamespace = n.oid
         LEFT JOIN pg_stat_user_tables s ON c.relname = s.relname AND n.nspname = s.schemaname
         WHERE c.relkind = 'r' AND n.nspname = $1 AND c.relname ILIKE $2
         ORDER BY c.relname
         LIMIT $3`,
        [sch, `%${kw}%`, limit]
      );
      return r.rows.map((x) => ({
        name: x.name as string,
        rowCount: x.rowCount == null ? null : Number(x.rowCount),
        comment: x.comment ? String(x.comment) : null,
      }));
    });
  }

  async fetchColumns(db: string, schema: string | null, table: string): Promise<ColumnInfo[]> {
    return this.withConn(db || this.opts.database || 'postgres', async (c) => {
      const sch = schema || this.opts.schema || 'public';
      const r = await c.query(
        `SELECT c.column_name AS name, c.data_type AS "dataType", c.is_nullable AS nullable,
                c.column_default AS "defaultValue",
                col_description(
                  (SELECT pc.oid FROM pg_class pc
                   JOIN pg_namespace pn ON pn.oid = pc.relnamespace
                   WHERE pn.nspname = $1 AND pc.relname = $2 AND pc.relkind = 'r' LIMIT 1),
                  c.ordinal_position::int
                ) AS comment,
                CASE WHEN pk.column_name IS NOT NULL THEN 't' ELSE 'f' END AS "isPk"
         FROM information_schema.columns c
         LEFT JOIN (
           SELECT ku.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage ku
             ON tc.constraint_name = ku.constraint_name AND tc.table_schema = ku.table_schema
           WHERE tc.constraint_type = 'PRIMARY KEY'
             AND tc.table_name = $2 AND tc.table_schema = $1
         ) pk ON pk.column_name = c.column_name
         WHERE c.table_name = $2 AND c.table_schema = $1
         ORDER BY c.ordinal_position`,
        [sch, table]
      );
      return r.rows.map((x) => ({
        name: x.name as string,
        dataType: x.dataType as string,
        nullable: x.nullable === 'YES',
        defaultValue: x.defaultValue == null ? null : String(x.defaultValue),
        isPrimaryKey: x.isPk === 't',
        comment: x.comment ? String(x.comment) : null,
      }));
    });
  }

  async executeQuery(sql: string, opts?: { database?: string; timeoutMs?: number }): Promise<QueryResult> {
    const stmts = splitSqlStatements(sql);
    // 多语句：同一连接顺序执行，返回最后一条查询语句的结果集；
    // 某条失败即中止，并说明前面哪些语句已生效（不做隐式事务回滚）
    if (stmts.length > 1) {
      const start = Date.now();
      const c = await this.pool.connect();
      let restoreTimeout: (() => Promise<void>) | null = null;
      let failed = false;
      try {
        restoreTimeout = await this.applyStatementTimeout(c, opts?.timeoutMs);
        let columns: string[] = [];
        let rows: (string | null)[][] = [];
        let affectedRows = 0;
        let resultSets = 0;
        for (let i = 0; i < stmts.length; i++) {
          let r: pg.QueryArrayResult;
          try {
            r = await c.query({ text: stmts[i], rowMode: 'array' as const });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const applied = i > 0 ? `（前 ${i} 条语句已执行，未回滚）` : '';
            throw new Error(`第 ${i + 1}/${stmts.length} 条语句执行失败: ${msg}${applied}`);
          }
          if (r.fields.length > 0) {
            resultSets++;
            const cols = r.fields.map((f) => f.name);
            columns = cols;
            rows = (r.rows as unknown[]).map((row) =>
              (row as unknown[]).map((v) => (v == null ? null : String(v)))
            );
          } else {
            affectedRows += r.rowCount ?? 0;
          }
        }
        const elapsedMs = Date.now() - start;
        return {
          columns,
          rows,
          message: `已顺序执行 ${stmts.length} 条语句${resultSets > 0 ? '，返回最后一条查询的结果集' : ''}，累计影响 ${affectedRows} 行，耗时 ${elapsedMs}ms`,
          elapsedMs,
          affectedRows,
        };
      } catch (e) {
        failed = true;
        throw e;
      } finally {
        if (restoreTimeout) await restoreTimeout();
        // 失败时销毁连接：语句超时/显式事务中途出错可能留下 aborted 状态，归还池会污染后续复用
        c.release(failed ? new Error('query failed, destroy pooled connection') : undefined);
      }
    }

    const start = Date.now();
    const c = await this.pool.connect();
    let restoreTimeout: (() => Promise<void>) | null = null;
    let failed = false;
    try {
      restoreTimeout = await this.applyStatementTimeout(c, opts?.timeoutMs);
      const r = await c.query({ text: sql, rowMode: 'array' as const });
      const elapsedMs = Date.now() - start;
      if (r.fields.length > 0) {
        const cols = r.fields.map((f) => f.name);
        const rows = r.rows.map((row) =>
          (row as unknown[]).map((v) => (v == null ? null : String(v)))
        );
        return { columns: cols, rows, message: `返回 ${rows.length} 行 · 耗时 ${elapsedMs}ms`, elapsedMs };
      }
      return {
        columns: [],
        rows: [],
        message: `执行成功 · 影响 ${r.rowCount ?? 0} 行 · 耗时 ${elapsedMs}ms`,
        elapsedMs,
        affectedRows: r.rowCount ?? 0,
      };
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      if (restoreTimeout) await restoreTimeout();
      c.release(failed ? new Error('query failed, destroy pooled connection') : undefined);
    }
  }

  async explain(sql: string, opts?: { database?: string }): Promise<ExplainResult> {
    const stmts = splitSqlStatements(sql);
    const c = await this.pool.connect();
    try {
      if (stmts.length > 1) {
        // 多语句：逐条 EXPLAIN，块间加结论与分隔行；
        // 预估影响行数只累计写语句（读语句的 Plan Rows 是扫描行数）
        const parts: string[] = [];
        let estimatedRows: number | null = null;
        for (let i = 0; i < stmts.length; i++) {
          const one = await this.explainOne(c, stmts[i]);
          parts.push(
            `── 语句 ${i + 1}/${stmts.length} ──`,
            planSummaryLine(leadingVerb(stmts[i]), one.estimatedRows, one.lines),
            ...one.lines.split('\n')
          );
          if (one.estimatedRows != null && WRITE_VERBS.has(leadingVerb(stmts[i]))) {
            estimatedRows = (estimatedRows ?? 0) + one.estimatedRows;
          }
        }
        return {
          columns: ['QUERY PLAN'],
          rows: parts.map((l) => [l]),
          estimatedRows,
        };
      }

      const one = await this.explainOne(c, stmts[0] ?? sql);
      const summary = planSummaryLine(leadingVerb(stmts[0] ?? sql), one.estimatedRows, one.lines);
      return {
        columns: ['QUERY PLAN'],
        rows: [summary, ...one.lines.split('\n')].map((l) => [l]),
        estimatedRows: one.estimatedRows,
      };
    } finally {
      c.release();
    }
  }

  /** 单条语句的 EXPLAIN（FORMAT JSON），渲染为人类可读的计划树 + 预估行数 */
  private async explainOne(c: pg.PoolClient, stmt: string): Promise<{ lines: string; estimatedRows: number | null }> {
    // 不带 ANALYZE，避免真实执行写操作；JSON 格式便于解析计划结构
    // 使用 rowMode:'array' 拿到原始值（pg 可能把 JSON 列自动反序列化成对象）
    const r = await c.query({ text: `EXPLAIN (FORMAT JSON) ${stmt}`, rowMode: 'array' as const });
    const raw = (r.rows as unknown[][])[0]?.[0];
    let planObj: unknown;
    if (typeof raw === 'string') {
      try {
        planObj = JSON.parse(raw);
      } catch {
        planObj = undefined;
      }
    } else {
      planObj = raw;
    }

    // 解析成功：渲染成缩进计划树（节点类型/表/索引/预估行数/成本）
    if (planObj != null) {
      try {
        const root = (Array.isArray(planObj) ? planObj[0] : planObj) as Record<string, unknown> | undefined;
        const top = (root?.Plan ?? root) as Record<string, unknown> | undefined;
        if (top && typeof top === 'object') {
          const out: string[] = [];
          formatPlanNode(top, 0, out);
          const planRows = top['Plan Rows'] ?? top.PlanRows;
          const estimatedRows = planRows != null ? Number(planRows) : null;
          return { lines: out.join('\n'), estimatedRows: Number.isFinite(estimatedRows as number) ? estimatedRows : null };
        }
      } catch {
        // fallthrough：解析失败走原样输出
      }
    }

    // 解析失败：原样展示
    const lines = typeof raw === 'string' ? raw : raw != null ? JSON.stringify(raw, null, 2) : '';
    return { lines, estimatedRows: null };
  }

  async createDatabase(name: string): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    } finally {
      c.release();
    }
  }

  async dropDatabase(name: string): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query(`DROP DATABASE IF EXISTS "${name.replace(/"/g, '""')}"`);
    } finally {
      c.release();
    }
  }

  async createSchema(name: string): Promise<void> {
    await this.executeQuery(`CREATE SCHEMA IF NOT EXISTS "${name.replace(/"/g, '""')}"`);
  }

  async truncateTable(db: string, schema: string | null, table: string): Promise<void> {
    const sch = schema || this.opts.schema || 'public';
    await this.executeQuery(
      `TRUNCATE TABLE ${this.quoteIdent(sch)}.${this.quoteIdent(table)}`
    );
  }

  async dropTable(db: string, schema: string | null, table: string): Promise<void> {
    const sch = schema || this.opts.schema || 'public';
    await this.executeQuery(
      `DROP TABLE IF EXISTS ${this.quoteIdent(sch)}.${this.quoteIdent(table)}`
    );
  }

  private quoteIdent(s: string): string {
    return `"${s.replace(/"/g, '""')}"`;
  }
}
