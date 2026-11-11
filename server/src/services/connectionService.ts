import { decryptSecret, deleteDataSource, encryptSecret, getDataSource, insertDataSource, listDataSources, updateDataSource } from '../db/store.js';
import { createDriver, type ConnectionOptions, type DatabaseDriver } from '../drivers/index.js';
import { esService } from './esService.js';
import { redisService } from './redisService.js';
import type { DataSource } from '../types.js';

/**
 * 连接服务：数据源 CRUD + 驱动实例缓存。
 * 每个数据源一个连接池，按需创建，长期未用可回收。
 */
export class ConnectionService {
  private drivers = new Map<string, DatabaseDriver>();

  list(): DataSource[] {
    return listDataSources().map(stripSecret);
  }

  get(id: number): DataSource | null {
    return getDataSource(id);
  }

  /** 创建或更新数据源；password 为空字符串表示不修改（更新场景） */
  save(input: {
    id?: number;
    name: string;
    type: ConnectionOptions['type'];
    host: string;
    port: number;
    username: string;
    password: string;
    database?: string;
    schema?: string;
  }): DataSource {
    if (input.id) {
      const existing = getDataSource(input.id);
      if (!existing) throw new Error('数据源不存在');
      const passwordEnc = input.password
        ? encrypt(input.password)
        : existing.passwordEnc;
      const ds = updateDataSource(input.id, {
        name: input.name,
        type: input.type,
        host: input.host,
        port: input.port,
        username: input.username,
        passwordEnc,
        database: input.database ?? '',
        schema: input.schema ?? '',
      })!;
      // 更新后关闭旧连接池，强制重建，避免连接与凭据泄漏
      this.invalidateDrivers(input.id);
      return stripSecret(ds);
    }
    const ds = insertDataSource({
      name: input.name,
      type: input.type,
      host: input.host,
      port: input.port,
      username: input.username,
      passwordEnc: encrypt(input.password),
      database: input.database ?? '',
      schema: input.schema ?? '',
    });
    return stripSecret(ds);
  }

  remove(id: number): void {
    this.invalidateDrivers(id);
    deleteDataSource(id);
  }

  /** 获取默认数据库连接池。 */
  getDriver(id: number): DatabaseDriver {
    const ds = getDataSource(id);
    if (!ds) throw new Error('数据源不存在');
    return this.getDriverForDatabase(id, ds.database);
  }

  /** 按 (数据源, 数据库) 隔离并缓存连接池，避免并发请求串库。 */
  getDriverForDatabase(id: number, database: string): DatabaseDriver {
    const ds = getDataSource(id);
    if (!ds) throw new Error('数据源不存在');
    const selectedDatabase = database || ds.database;
    const key = `${id}\0${selectedDatabase}`;
    const cached = this.drivers.get(key);
    if (cached) return cached;
    const driver = createDriver({ ...toConnectionOptions(ds), database: selectedDatabase });
    this.drivers.set(key, driver);
    return driver;
  }

  /** 测试连接（不缓存）；ES / Redis 类型走各自 service */
  async test(id: number): Promise<{ ok: boolean; message: string }> {
    const ds = getDataSource(id);
    if (!ds) throw new Error('数据源不存在');
    if (ds.type === 'elasticsearch') {
      try {
        await esService().test(ds);
        return { ok: true, message: '连接成功' };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    }
    if (ds.type === 'redis') {
      try {
        await redisService().test(ds);
        return { ok: true, message: '连接成功' };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    }
    const opts = toConnectionOptions(ds);
    return this.testDraft(opts);
  }

  /** 测试未保存的连接配置 */
  async testDraft(input: {
    type: ConnectionOptions['type'];
    host: string;
    port: number;
    username: string;
    password: string;
    database?: string;
    schema?: string;
  }): Promise<{ ok: boolean; message: string }> {
    if (input.type === 'redis') {
      const draft: DataSource = {
        id: -1,
        name: '',
        type: 'redis',
        host: input.host,
        port: input.port,
        username: input.username,
        passwordEnc: encrypt(input.password),
        database: input.database ?? '',
        schema: '',
        createdAt: '',
        updatedAt: '',
      };
      try {
        await redisService().test(draft);
        return { ok: true, message: '连接成功' };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    }
    if (input.type === 'elasticsearch') {
      const draft: DataSource = {
        id: 0,
        name: '',
        type: 'elasticsearch',
        host: input.host,
        port: input.port,
        username: input.username,
        passwordEnc: encrypt(input.password),
        database: '',
        schema: '',
        createdAt: '',
        updatedAt: '',
      };
      try {
        await esService().test(draft);
        return { ok: true, message: '连接成功' };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    }
    let driver: DatabaseDriver | undefined;
    try {
      driver = createDriver({
        type: input.type,
        host: input.host,
        port: input.port,
        username: input.username,
        password: input.password,
        database: input.database,
        schema: input.schema,
      });
      await driver.testConnection();
      return { ok: true, message: '连接成功' };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    } finally {
      await driver?.close().catch(() => undefined);
    }
  }

  async closeAll(): Promise<void> {
    const drivers = [...this.drivers.values()];
    this.drivers.clear();
    await Promise.allSettled(drivers.map((driver) => driver.close()));
  }

  /** 连接配置变更/删除时，同时清理 SQL 驱动池与 Redis 客户端缓存 */
  invalidateDrivers(id: number): void {
    const prefix = `${id}\0`;
    for (const [key, driver] of this.drivers) {
      if (!key.startsWith(prefix)) continue;
      this.drivers.delete(key);
      void driver.close().catch(() => undefined);
    }
    redisService().invalidate(id);
  }
}

const service = new ConnectionService();

function encrypt(plain: string): string {
  return encryptSecret(plain);
}

function toConnectionOptions(ds: DataSource): ConnectionOptions {
  return {
    type: ds.type,
    host: ds.host,
    port: ds.port,
    username: ds.username,
    password: decryptSecret(ds.passwordEnc),
    database: ds.database,
    schema: ds.schema,
  };
}

function stripSecret(ds: DataSource): DataSource {
  return { ...ds, passwordEnc: '' };
}

export function connectionService(): ConnectionService {
  return service;
}
