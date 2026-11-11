import type { ConnectionOptions, DatabaseDriver, DatabaseType } from './types.js';
import { MySqlDriver } from './mysqlDriver.js';
import { PostgresDriver } from './postgresDriver.js';

export type { DatabaseType, ConnectionOptions, DatabaseDriver, QueryResult, ColumnInfo, TableInfo, ExplainResult } from './types.js';

export function createDriver(opts: ConnectionOptions): DatabaseDriver {
  switch (opts.type) {
    case 'mysql':
      return new MySqlDriver(opts);
    case 'postgres':
      return new PostgresDriver(opts);
    case 'elasticsearch':
      throw new Error('ES 数据源不支持 SQL 驱动，请使用 /api/es/search');
    case 'redis':
      throw new Error('Redis 数据源不支持 SQL 驱动，请使用 /api/redis/execute 执行命令');
    default:
      throw new Error(`Unsupported database type: ${(opts as { type: string }).type}`);
  }
}

export const supportedTypes: { value: DatabaseType; label: string; defaultPort: number }[] = [
  { value: 'mysql', label: 'MySQL', defaultPort: 3306 },
  { value: 'postgres', label: 'PostgreSQL', defaultPort: 5432 },
  { value: 'elasticsearch', label: 'Elasticsearch', defaultPort: 9200 },
  { value: 'redis', label: 'Redis', defaultPort: 6379 },
];
