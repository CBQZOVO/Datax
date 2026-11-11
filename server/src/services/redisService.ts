import { createClient, type RedisClientType } from 'redis';
import { decryptSecret } from '../db/store.js';
import type { DataSource } from '../types.js';
import type { QueryResult } from '../drivers/types.js';

/**
 * Redis 命令执行服务：按「连接 + db」缓存客户端，命令经 sendCommand 下发并表格化。
 * Redis 无 SQL，不走 DatabaseDriver 接口，由 /api/redis/execute 独立通道提供。
 */

/** 只读命令白名单（agent 通道限定） */
const READONLY_COMMANDS = new Set([
  'PING', 'ECHO', 'TIME', 'INFO', 'DBSIZE', 'KEYS', 'SCAN', 'RANDOMKEY', 'TYPE', 'EXISTS', 'TTL', 'PTTL',
  'EXPIRETIME', 'PEXPIRETIME', 'OBJECT', 'MEMORY', 'COMMAND',
  'GET', 'MGET', 'STRLEN', 'GETRANGE', 'SUBSTR', 'BITCOUNT', 'BITPOS', 'PFCOUNT',
  'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'HSCAN', 'HSTRLEN',
  'LINDEX', 'LLEN', 'LRANGE', 'LPOS',
  'SMEMBERS', 'SCARD', 'SISMEMBER', 'SMISMEMBER', 'SSCAN', 'SRANDMEMBER',
  'ZRANGE', 'ZREVRANGE', 'ZRANGEBYSCORE', 'ZREVRANGEBYSCORE', 'ZSCORE', 'ZMSCORE', 'ZCARD', 'ZCOUNT',
  'ZRANK', 'ZREVRANK', 'ZSCAN', 'ZLEXCOUNT',
  'XRANGE', 'XREVRANGE', 'XLEN', 'XINFO', 'XPENDING',
  'GEOHASH', 'GEOPOS', 'GEODIST', 'GEOSEARCH',
]);

/** 取命令动词：先走 parseRedisCommand 剥引号，防止 'EVAL' "CONFIG" 等引号包裹绕过黑名单 */
function commandVerb(command: string): string {
  const args = parseRedisCommand(command);
  return (args[0] ?? '').toUpperCase();
}

export function isReadonlyCommand(command: string): boolean {
  return READONLY_COMMANDS.has(commandVerb(command));
}

/**
 * 全员禁用的命令（含普通用户）：
 * - 危险命令：CONFIG SET dir/dbfilename、MODULE LOAD、SLAVEOF/REPLICAOF、DEBUG、FLUSHALL 等
 *   是 Redis 越权到宿主机 RCE 的标准链路；SCRIPT/EVAL 支持 Lua，同样属于执行面
 * - 阻塞命令：BLPOP/SUBSCRIBE 等会永久挂起共享连接，同连接的后续请求全部排队阻塞
 */
const FORBIDDEN_COMMANDS = new Set([
  'CONFIG', 'SLAVEOF', 'REPLICAOF', 'DEBUG', 'MODULE', 'FLUSHALL', 'FLUSHDB',
  'SHUTDOWN', 'ACL', 'MIGRATE', 'CLUSTER', 'SCRIPT', 'EVAL', 'EVALSHA', 'EVALSHA_RO',
  'EVAL_RO', 'FUNCTION', 'FCALL', 'RESET', 'SWAPDB', 'CLIENT',
  'BLPOP', 'BRPOP', 'BLMOVE', 'BRPOPLPUSH', 'BLMPOP', 'BZPOPMIN', 'BZPOPMAX', 'BZMPOP',
  'SUBSCRIBE', 'UNSUBSCRIBE', 'PSUBSCRIBE', 'PUNSUBSCRIBE', 'SSUBSCRIBE', 'SUNSUBSCRIBE',
  'WAIT', 'WAITAOF',
]);

/** 命令是否在全员黑名单中 */
export function isForbiddenCommand(command: string): boolean {
  return FORBIDDEN_COMMANDS.has(commandVerb(command));
}

/** 极简命令解析：支持单/双引号包裹的参数（如 SET k "hello world"） */
export function parseRedisCommand(input: string): string[] {
  const args: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    args.push(m[1] ?? m[2] ?? m[3]);
  }
  return args;
}

/** database 形如 db0..db15；非法回落 db0 */
function dbIndex(database: string): number {
  const n = Number(database.replace(/^db/i, ''));
  return Number.isInteger(n) && n >= 0 && n <= 15 ? n : 0;
}

const clients = new Map<string, RedisClientType>();

function clientFor(ds: DataSource, database: string): RedisClientType {
  const key = `${ds.id}\0${database || ds.database}`;
  const cached = clients.get(key);
  if (cached) return cached;
  const host = ds.host.trim().replace(/^https?:\/\//, '');
  const client = createClient({
    socket: { host, port: ds.port, connectTimeout: 10_000, reconnectStrategy: false },
    username: ds.username || undefined,
    password: ds.passwordEnc ? decryptSecret(ds.passwordEnc) : undefined,
    database: dbIndex(database || ds.database),
  });
  // 连接级错误由调用方捕获；注册空 handler 避免 EventEmitter 未处理导致进程崩溃
  client.on('error', () => undefined);
  clients.set(key, client);
  return client;
}

async function ensureConnected(client: RedisClientType): Promise<void> {
  if (!client.isOpen) await client.connect();
}

/** RESP reply → 表格结果：标量单列；数组按序号展开（HGETALL/CONFIG 按字段-值两列）；SCAN/KEYS 列 key */
function toQueryResult(reply: unknown, args: string[], elapsedMs: number): QueryResult {
  const cmd = (args[0] ?? '').toUpperCase();

  if (reply === null || reply === undefined) {
    return { columns: ['结果'], rows: [['(nil)']], message: `nil · 耗时 ${elapsedMs}ms`, elapsedMs };
  }
  if (typeof reply === 'string' || typeof reply === 'number') {
    return { columns: ['结果'], rows: [[String(reply)]], message: `1 个结果 · 耗时 ${elapsedMs}ms`, elapsedMs };
  }
  if (Array.isArray(reply)) {
    // SCAN 返回 [cursor, [keys]]
    if (cmd === 'SCAN' && Array.isArray(reply[1])) {
      const keys = reply[1] as unknown[];
      return {
        columns: ['#', 'key'],
        rows: keys.map((k, i) => [String(i + 1), String(k)]),
        message: `cursor=${String(reply[0])} · 返回 ${keys.length} 个 key · 耗时 ${elapsedMs}ms`,
        elapsedMs,
      };
    }
    if (cmd === 'KEYS') {
      return {
        columns: ['#', 'key'],
        rows: reply.map((k, i) => [String(i + 1), String(k)]),
        message: `返回 ${reply.length} 个 key · 耗时 ${elapsedMs}ms`,
        elapsedMs,
      };
    }
    // HGETALL / CONFIG GET：偶数长度扁平数组按字段-值展示
    if ((cmd === 'HGETALL' || (cmd === 'CONFIG' && String(args[1] ?? '').toUpperCase() === 'GET')) && reply.length % 2 === 0) {
      const rows: (string | null)[][] = [];
      for (let i = 0; i < reply.length; i += 2) {
        rows.push([String(reply[i]), reply[i + 1] == null ? null : String(reply[i + 1])]);
      }
      return { columns: ['字段', '值'], rows, message: `返回 ${rows.length} 项 · 耗时 ${elapsedMs}ms`, elapsedMs };
    }
    return {
      columns: ['#', '值'],
      rows: reply.map((v, i) => [
        String(i + 1),
        v == null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v),
      ]),
      message: `返回 ${reply.length} 项 · 耗时 ${elapsedMs}ms`,
      elapsedMs,
    };
  }
  return { columns: ['结果'], rows: [[JSON.stringify(reply)]], message: `1 个结果 · 耗时 ${elapsedMs}ms`, elapsedMs };
}

export class RedisService {
  /** 连接测试：PING（使用后立即断开，不进入缓存） */
  async test(ds: DataSource): Promise<void> {
    const client = clientFor(ds, '');
    try {
      await ensureConnected(client);
      const pong = await client.ping();
      if (String(pong).toUpperCase() !== 'PONG') throw new Error('Redis 未返回 PONG');
    } catch (e) {
      clients.delete(`${ds.id}\0${ds.database || ''}`);
      await client.disconnect().catch(() => undefined);
      throw e;
    }
  }

  /** 各 db 的 key 数量（INFO keyspace 一次拉取，用于树上标注哪个库有数据） */
  async keyCounts(ds: DataSource): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 16; i++) counts[`db${i}`] = 0;
    const client = clientFor(ds, 'db0');
    await ensureConnected(client);
    const info = String(await client.sendCommand(['INFO', 'keyspace']));
    for (const line of info.split('\n')) {
      const m = /^db(\d+):keys=(\d+)/.exec(line.trim());
      if (m) counts[`db${m[1]}`] = Number(m[2]);
    }
    return counts;
  }

  /**
   * 查看单个 key 的值：先 TYPE，再按数据类型选对应命令
   * （用户不必知道 key 是 string/hash/list/set/zset，也不用记 GET/HGETALL/LRANGE/SMEMBERS/ZRANGE）
   */
  async inspectKey(ds: DataSource, database: string, key: string): Promise<{ type: string; result: QueryResult }> {
    const client = clientFor(ds, database);
    await ensureConnected(client);
    const start = Date.now();
    const type = String(await client.sendCommand(['TYPE', key])).toLowerCase();
    const commandByType: Record<string, string[]> = {
      string: ['GET', key],
      hash: ['HGETALL', key],
      list: ['LRANGE', key, '0', '-1'],
      set: ['SMEMBERS', key],
      zset: ['ZRANGE', key, '0', '-1', 'WITHSCORES'],
      stream: ['XRANGE', key, '-', '+', 'COUNT', '100'],
    };
    const args = commandByType[type];
    const elapsedMs = Date.now() - start;
    if (!args) {
      return {
        type,
        result: {
          columns: ['结果'],
          rows: [['(nil) 或暂不支持的类型']],
          message: `TYPE ${type} · 耗时 ${elapsedMs}ms`,
          elapsedMs,
        },
      };
    }
    const reply = (await client.sendCommand(args as string[])) as unknown;
    return { type, result: toQueryResult(reply, args, Date.now() - start) };
  }

  /** 新增 key：按类型构造写命令，已存在则拒绝（避免误覆盖）；可附带 TTL（秒） */
  async createKey(ds: DataSource, database: string, input: {
    key: string; type: string; value: string; ttl?: number;
  }): Promise<string> {
    const client = clientFor(ds, database);
    await ensureConnected(client);
    const exists = Number(await client.sendCommand(['EXISTS', input.key]));
    if (exists > 0) throw new Error('key 已存在，请先删除后再新增');
    const lines = input.value.split('\n').map((l) => l.trim()).filter(Boolean);
    let cmd: string[];
    switch (input.type) {
      case 'string':
        cmd = ['SET', input.key, input.value];
        break;
      case 'hash': {
        if (lines.length === 0) throw new Error('hash 请按「字段 值」每行一条填写');
        const args: string[] = [];
        for (const line of lines) {
          const i = line.indexOf(' ');
          if (i < 0) throw new Error(`hash 行格式应为「字段 值」：${line}`);
          args.push(line.slice(0, i), line.slice(i + 1).trim());
        }
        cmd = ['HSET', input.key, ...args];
        break;
      }
      case 'list':
        if (lines.length === 0) throw new Error('list 请每行填一个元素');
        cmd = ['RPUSH', input.key, ...lines];
        break;
      case 'set':
        if (lines.length === 0) throw new Error('set 请每行填一个成员');
        cmd = ['SADD', input.key, ...lines];
        break;
      case 'zset': {
        if (lines.length === 0) throw new Error('zset 请按「分数 成员」每行一条填写');
        const args: string[] = [];
        for (const line of lines) {
          const i = line.indexOf(' ');
          const score = line.slice(0, i).trim();
          if (i < 0 || !Number.isFinite(Number(score))) {
            throw new Error(`zset 行格式应为「分数 成员」且分数为数字：${line}`);
          }
          args.push(score, line.slice(i + 1).trim());
        }
        cmd = ['ZADD', input.key, ...args];
        break;
      }
      default:
        throw new Error(`不支持的 key 类型：${input.type}`);
    }
    await client.sendCommand(cmd as string[]);
    if (input.ttl && input.ttl > 0) {
      await client.sendCommand(['EXPIRE', input.key, String(Math.floor(input.ttl))]);
    }
    return cmd[0];
  }

  /** 删除 key，返回实际删除数量 */
  async deleteKey(ds: DataSource, database: string, key: string): Promise<number> {
    const client = clientFor(ds, database);
    await ensureConnected(client);
    return Number(await client.sendCommand(['DEL', key]));
  }

  /** 执行命令并返回表格化结果 */
  async execute(ds: DataSource, database: string, command: string): Promise<{ result: QueryResult; readonly: boolean }> {
    const args = parseRedisCommand(command);
    if (args.length === 0) throw new Error('命令为空');
    const readonly = READONLY_COMMANDS.has((args[0] ?? '').toUpperCase());
    const client = clientFor(ds, database);
    await ensureConnected(client);
    const start = Date.now();
    const reply = (await client.sendCommand(args as string[])) as unknown;
    const elapsedMs = Date.now() - start;
    return { result: toQueryResult(reply, args, elapsedMs), readonly };
  }

  /** 连接配置变更/删除时清理缓存 */
  invalidate(connectionId: number): void {
    const prefix = `${connectionId}\0`;
    for (const [key, client] of clients) {
      if (!key.startsWith(prefix)) continue;
      clients.delete(key);
      void client.disconnect().catch(() => undefined);
    }
  }

  async closeAll(): Promise<void> {
    const list = [...clients.values()];
    clients.clear();
    await Promise.allSettled(list.map((client) => client.disconnect()));
  }
}

const service = new RedisService();
export function redisService(): RedisService {
  return service;
}
