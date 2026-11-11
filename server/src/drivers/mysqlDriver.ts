import mysql from 'mysql2/promise';
import type {
  ColumnInfo, ConnectionOptions, DatabaseDriver, ExplainResult, QueryResult, TableInfo,
} from './types.js';
import { splitSqlStatements, leadingVerb } from './sqlSplit.js';

/** 预估影响行数只统计这些写语句；读语句的 EXPLAIN rows 是扫描行数，不是影响行数 */
const WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);

export class MySqlDriver implements DatabaseDriver {
  private pool: mysql.Pool;

  constructor(private opts: ConnectionOptions) {
    this.pool = mysql.createPool({
      host: opts.host,
      port: opts.port,
      user: opts.username,
      password: opts.password,
      database: opts.database || undefined,
      connectionLimit: 10,
      charset: 'utf8mb4',
      timezone: 'local',
      // DATE/DATETIME/TIMESTAMP 按原始字符串返回，避免被解析成 JS Date
      // 后 String() 成 "Thu Nov 12 2020 ..." 的难看格式
      dateStrings: true,
      supportBigNumbers: true,
      maxIdle: 5,
      idleTimeout: 30000,
    });
  }

  private conn(db?: string): Promise<mysql.PoolConnection> {
    if (!db) return this.pool.getConnection();
    return this.pool.getConnection().then(async (c) => {
      try {
        await c.query(`USE \`${db.replace(/`/g, '``')}\``);
      } catch (e) {
        c.release();
        throw e;
      }
      return c;
    });
  }

  async testConnection(): Promise<void> {
    const c = await this.pool.getConnection();
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
    const c = await this.conn();
    try {
      const [rows] = await c.query<any[]>('SHOW DATABASES');
      return rows.map((r) => Object.values(r)[0] as string);
    } finally {
      c.release();
    }
  }

  async fetchSchemas(): Promise<string[]> {
    return [];
  }

  async fetchTables(db: string, schema: string | null, limit?: number): Promise<TableInfo[]> {
    const c = await this.conn(db);
    try {
      const schemaClause = schema
        ? `AND TABLE_SCHEMA = ${this.quote(schema)}`
        : `AND TABLE_SCHEMA = ${this.quote(db)}`;
      const [rows] = await c.query<any[]>(
        `SELECT TABLE_NAME AS name, TABLE_ROWS AS rowCount, TABLE_COMMENT AS comment
         FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_TYPE = 'BASE TABLE' ${schemaClause}
         ORDER BY TABLE_NAME
         ${limit ? `LIMIT ${Math.floor(limit)}` : ''}`
      );
      return rows.map((r) => ({
        name: r.name as string,
        rowCount: r.rowCount == null ? null : Number(r.rowCount),
        comment: r.comment ? String(r.comment) : null,
      }));
    } finally {
      c.release();
    }
  }

  async fetchViews(db: string, schema: string | null): Promise<string[]> {
    const c = await this.conn(db);
    try {
      const schemaClause = schema
        ? `AND TABLE_SCHEMA = ${this.quote(schema)}`
        : `AND TABLE_SCHEMA = ${this.quote(db)}`;
      const [rows] = await c.query<any[]>(
        `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_TYPE = 'VIEW' ${schemaClause} ORDER BY TABLE_NAME`
      );
      return rows.map((r) => r.name as string);
    } finally {
      c.release();
    }
  }

  async searchTables(db: string, schema: string | null, keyword: string, limit = 50): Promise<TableInfo[]> {
    const kw = keyword.trim();
    if (!kw) return [];
    const c = await this.conn(db);
    try {
      const target = schema || db;
      const [rows] = await c.query<any[]>(
        `SELECT TABLE_NAME AS name, TABLE_ROWS AS rowCount, TABLE_COMMENT AS comment
         FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_TYPE = 'BASE TABLE'
           AND TABLE_SCHEMA = ${this.quote(target)}
           AND TABLE_NAME LIKE ${this.quote('%' + kw + '%')}
         ORDER BY TABLE_NAME
         LIMIT ?`,
        [limit]
      );
      return rows.map((r) => ({
        name: r.name as string,
        rowCount: r.rowCount == null ? null : Number(r.rowCount),
        comment: r.comment ? String(r.comment) : null,
      }));
    } finally {
      c.release();
    }
  }

  async fetchColumns(db: string, schema: string | null, table: string): Promise<ColumnInfo[]> {
    const c = await this.conn(db);
    try {
      const [rows] = await c.query<any[]>(
        `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS dataType, IS_NULLABLE AS nullable,
                COLUMN_DEFAULT AS defaultValue, COLUMN_KEY AS columnKey,
                COLUMN_COMMENT AS comment
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ${this.quote(schema || db)} AND TABLE_NAME = ${this.quote(table)}
         ORDER BY ORDINAL_POSITION`
      );
      return rows.map((r) => ({
        name: r.name as string,
        dataType: r.dataType as string,
        nullable: r.nullable === 'YES',
        defaultValue: r.defaultValue == null ? null : String(r.defaultValue),
        isPrimaryKey: r.columnKey === 'PRI',
        comment: r.comment ? String(r.comment) : null,
      }));
    } finally {
      c.release();
    }
  }

  async executeQuery(sql: string, opts?: { database?: string; timeoutMs?: number }): Promise<QueryResult> {
    const stmts = splitSqlStatements(sql);
    // 多语句：同一连接顺序执行，返回最后一条查询语句的结果集；
    // 某条失败即中止，并说明前面哪些语句已生效（不做隐式事务回滚）
    if (stmts.length > 1) {
      const start = Date.now();
      const c = await this.conn(opts?.database);
      try {
        let columns: string[] = [];
        let rows: (string | null)[][] = [];
        let affectedRows = 0;
        let resultSets = 0;
        for (let i = 0; i < stmts.length; i++) {
          let res: unknown;
          try {
            [res] = await c.query({
              sql: stmts[i],
              timeout: opts?.timeoutMs ?? 60000,
              rowsAsArray: false,
            } as mysql.QueryOptions);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const applied = i > 0 ? `（前 ${i} 条语句已执行，未回滚）` : '';
            throw new Error(`第 ${i + 1}/${stmts.length} 条语句执行失败: ${msg}${applied}`);
          }
          if (Array.isArray(res)) {
            resultSets++;
            const cols = res.length > 0 ? Object.keys(res[0]) : [];
            columns = cols;
            rows = res.map((row) => cols.map((k) => {
              const v = (row as Record<string, unknown>)[k];
              return v == null ? null : String(v);
            }));
          } else {
            affectedRows += (res as mysql.ResultSetHeader).affectedRows ?? 0;
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
      } finally {
        c.release();
      }
    }

    const start = Date.now();
    const c = await this.conn(opts?.database);
    try {
      const [res] = await c.query({
        sql,
        timeout: opts?.timeoutMs ?? 60000,
        rowsAsArray: false,
      } as mysql.QueryOptions);
      const elapsedMs = Date.now() - start;

      if (Array.isArray(res)) {
        const cols = res.length > 0 ? Object.keys(res[0]) : [];
        const rows = res.map((row) => cols.map((k) => {
          const v = (row as Record<string, unknown>)[k];
          return v == null ? null : String(v);
        }));
        return {
          columns: cols,
          rows,
          message: `返回 ${rows.length} 行 · 耗时 ${elapsedMs}ms`,
          elapsedMs,
        };
      }
      // DML / DDL
      const info = res as mysql.ResultSetHeader;
      return {
        columns: [],
        rows: [],
        message: `执行成功 · 影响 ${info.affectedRows ?? 0} 行 · 耗时 ${elapsedMs}ms`,
        elapsedMs,
        affectedRows: info.affectedRows ?? 0,
      };
    } finally {
      c.release();
    }
  }

  async explain(sql: string, opts?: { database?: string }): Promise<ExplainResult> {
    const stmts = splitSqlStatements(sql);
    // 多语句：逐条 EXPLAIN 后合并展示，行首加语句序号列
    if (stmts.length > 1) {
      const c = await this.conn(opts?.database);
      try {
        const plans: { cols: string[]; rows: (string | null)[][]; isWrite: boolean }[] = [];
        for (const stmt of stmts) {
          const [rows] = await c.query<any[]>({ sql: `EXPLAIN ${stmt}`, timeout: 60000 });
          const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
          plans.push({
            cols,
            rows: rows.map((r) => cols.map((k) => (r[k] == null ? null : String(r[k])))),
            isWrite: WRITE_VERBS.has(leadingVerb(stmt)),
          });
        }
        const base = plans.find((p) => p.cols.length > 0)?.cols ?? [];
        // 预估影响行数只累计写语句的 rows；读语句（SELECT 等）的 rows 是扫描行数
        let estimatedRows: number | null = null;
        for (const p of plans) {
          if (!p.isWrite) continue;
          const rowsIdx = p.cols.findIndex((k) => k.toLowerCase() === 'rows');
          for (const row of p.rows) {
            const v = rowsIdx >= 0 ? Number(row[rowsIdx]) : NaN;
            if (Number.isFinite(v)) estimatedRows = (estimatedRows ?? 0) + v;
          }
        }
        return {
          columns: base.length > 0 ? ['#', ...base] : ['#', 'EXPLAIN'],
          rows: plans.flatMap((p, idx) =>
            p.rows.map((row) => [
              `#${idx + 1}`,
              ...base.map((col) => {
                const ci = p.cols.indexOf(col);
                return ci >= 0 ? row[ci] : null;
              }),
            ])
          ),
          estimatedRows,
        };
      } finally {
        c.release();
      }
    }

    const c = await this.conn(opts?.database);
    try {
      const [rows] = await c.query<any[]>({ sql: `EXPLAIN ${sql}`, timeout: 60000 });
      const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
      const data = rows.map((r) => cols.map((k) => (r[k] == null ? null : String(r[k]))));
      // MySQL EXPLAIN 不直接给行数，rows 列为预估扫描行
      const rowsIdx = cols.findIndex((k) => k.toLowerCase() === 'rows');
      let estimatedRows: number | null = null;
      if (rowsIdx >= 0 && data.length > 0) {
        const v = Number(data[0][rowsIdx]);
        estimatedRows = Number.isFinite(v) ? v : null;
      }
      return { columns: cols, rows: data, estimatedRows };
    } finally {
      c.release();
    }
  }

  async createDatabase(name: string): Promise<void> {
    const c = await this.conn();
    try {
      await c.query(`CREATE DATABASE \`${name.replace(/`/g, '``')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    } finally {
      c.release();
    }
  }

  async dropDatabase(name: string): Promise<void> {
    const c = await this.conn();
    try {
      await c.query(`DROP DATABASE IF EXISTS \`${name.replace(/`/g, '``')}\``);
    } finally {
      c.release();
    }
  }

  async createSchema(): Promise<void> {
    throw new Error('MySQL uses databases, not schemas');
  }

  async truncateTable(db: string, schema: string | null, table: string): Promise<void> {
    const c = await this.conn(db);
    try {
      const t = this.quoteIdent(table);
      await c.query(`TRUNCATE TABLE ${t}`);
    } finally {
      c.release();
    }
  }

  async dropTable(db: string, schema: string | null, table: string): Promise<void> {
    const c = await this.conn(db);
    try {
      const t = this.quoteIdent(table);
      await c.query(`DROP TABLE IF EXISTS ${t}`);
    } finally {
      c.release();
    }
  }

  private quote(s: string): string {
    return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }

  private quoteIdent(s: string): string {
    return `\`${s.replace(/`/g, '``')}\``;
  }
}
