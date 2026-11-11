import { connectionService } from './connectionService.js';
import { esService } from './esService.js';
import type { ColumnInfo, TableInfo } from '../drivers/types.js';

export class MetadataService {
  async databases(connectionId: number): Promise<string[]> {
    const conn = connectionService().get(connectionId);
    // ES 数据源没有"数据库"概念：返回按前缀聚合的"数据视图"模式（与连接树一致），
    // 权限分配与权限校验都以视图为粒度
    if (conn?.type === 'elasticsearch') {
      const indices = await esService().listIndices(conn);
      const DATE_RE = /-\d{4}\.\d{2}\.\d{2}$/;
      const patterns = new Set<string>();
      for (const it of indices) {
        patterns.add(DATE_RE.test(it.name) ? `${it.name.replace(DATE_RE, '')}-*` : it.name);
      }
      return [...patterns].sort((a, b) => a.localeCompare(b));
    }
    // Redis：固定 16 个逻辑库（db0..db15），作为树的第二层节点
    if (conn?.type === 'redis') {
      return Array.from({ length: 16 }, (_, i) => `db${i}`);
    }
    const driver = connectionService().getDriver(connectionId);
    return driver.fetchDatabases();
  }

  async schemas(connectionId: number, database: string): Promise<string[]> {
    // 必须切换到目标数据库的连接池，否则 information_schema 查的是默认库
    const driver = connectionService().getDriverForDatabase(connectionId, database);
    return driver.fetchSchemas(database);
  }

  async tables(connectionId: number, database: string, schema: string | null): Promise<{ items: TableInfo[]; total: number; truncated: boolean }> {
    const driver = connectionService().getDriverForDatabase(connectionId, database);
    // LIMIT 下推到 SQL：万表库不再全量拉取；多取 1 条用于判定是否截断
    const MAX = 200;
    const rows = await driver.fetchTables(database, schema, MAX + 1);
    return {
      items: rows.slice(0, MAX),
      total: rows.length > MAX ? MAX + 1 : rows.length,
      truncated: rows.length > MAX,
    };
  }

  async views(connectionId: number, database: string, schema: string | null): Promise<string[]> {
    const driver = connectionService().getDriverForDatabase(connectionId, database);
    return driver.fetchViews(database, schema);
  }

  async searchTables(connectionId: number, database: string, schema: string | null, keyword: string): Promise<TableInfo[]> {
    const driver = connectionService().getDriverForDatabase(connectionId, database);
    return driver.searchTables(database, schema, keyword, 50);
  }

  async columns(connectionId: number, database: string, schema: string | null, table: string): Promise<ColumnInfo[]> {
    const driver = connectionService().getDriverForDatabase(connectionId, database);
    return driver.fetchColumns(database, schema, table);
  }
}

export function metadataService(): MetadataService {
  return new MetadataService();
}
