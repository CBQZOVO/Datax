export type DatabaseType = 'mysql' | 'postgres' | 'elasticsearch' | 'redis';

export interface ConnectionOptions {
  type: DatabaseType;
  host: string;
  port: number;
  username: string;
  password: string;
  database?: string;
  schema?: string;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  /** 数据库列注释，无注释为 null */
  comment?: string | null;
}

export interface QueryResult {
  columns: string[];
  rows: (string | null)[][];
  message: string;
  elapsedMs: number;
  /** 非空表示该语句是写操作，值为受影响行数（可能为 -1 未知） */
  affectedRows?: number;
}

export interface TableInfo {
  name: string;
  rowCount: number | null;
  /** 数据库表注释，无注释为 null */
  comment?: string | null;
}

export interface ExplainResult {
  /** 执行计划列 */
  columns: string[];
  rows: (string | null)[][];
  /** 若可解析，给出预估影响行数 */
  estimatedRows: number | null;
}

export interface DatabaseDriver {
  /** 测试连接（SELECT 1） */
  testConnection(): Promise<void>;
  /** 关闭底层连接 */
  close(): Promise<void>;

  fetchDatabases(): Promise<string[]>;
  /** PG 返回 schema；MySQL 返回空数组 */
  fetchSchemas(db: string): Promise<string[]>;
  /** limit：只取前 N 条（用于树列表分页），不传返回全量 */
  fetchTables(db: string, schema: string | null, limit?: number): Promise<TableInfo[]>;
  searchTables(db: string, schema: string | null, keyword: string, limit?: number): Promise<TableInfo[]>;
  fetchViews(db: string, schema: string | null): Promise<string[]>;
  fetchColumns(db: string, schema: string | null, table: string): Promise<ColumnInfo[]>;

  /** 执行单条 SQL；返回结果集或影响行数 */
  executeQuery(sql: string, opts?: { database?: string; timeoutMs?: number }): Promise<QueryResult>;
  /** EXPLAIN 预查询（不真正执行写操作） */
  explain(sql: string, opts?: { database?: string }): Promise<ExplainResult>;

  createDatabase(name: string): Promise<void>;
  dropDatabase(name: string): Promise<void>;
  createSchema(name: string): Promise<void>;
  truncateTable(db: string, schema: string | null, table: string): Promise<void>;
  dropTable(db: string, schema: string | null, table: string): Promise<void>;
}
