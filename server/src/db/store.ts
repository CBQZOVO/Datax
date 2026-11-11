import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { loadConfig } from '../config.js';
import { getDb } from './database.js';
import type { ApprovalRequest, AuditLog, AuditResult, DataPermission, DataSource, User } from '../types.js';

// ============ 密码加解密（AES-256-GCM） ============

export function encryptSecret(plain: string): string {
  const key = loadConfig().secretKey;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptSecret(enc: string): string {
  // 空密文（无密码的数据源/手工插入的行）直接返回空串，避免 createDecipheriv 收到空 IV 抛异常
  if (!enc) return '';
  const key = loadConfig().secretKey;
  const [ivB64, tagB64, dataB64] = enc.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// ============ 系统设置（键值） ============

export function getSetting(key: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
    .run(key, value);
}

// ============ Users ============

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: 'admin' | 'user';
  must_change_password: number;
  token_version: number;
  created_at: string;
}

function toUser(r: UserRow): User {
  return {
    id: r.id,
    username: r.username,
    role: r.role,
    mustChangePassword: r.must_change_password as 0 | 1,
    tokenVersion: r.token_version,
    createdAt: r.created_at,
  };
}

export function findUserByUsername(username: string): User | null {
  const row = getDb()
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function findUserById(id: number): User | null {
  const row = getDb()
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(id) as UserRow | undefined;
  return row ? toUser(row) : null;
}

// 用户不存在时也跑一次 bcrypt 比较（用固定 dummy hash），抹平响应时间差异，防用户名枚举
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('__datax_dummy_pw__', 10);

export function verifyUserPassword(username: string, password: string): User | null {
  const row = getDb()
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username) as UserRow | undefined;
  const ok = bcrypt.compareSync(password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!row || !ok) return null;
  return toUser(row);
}

export function updateUserPassword(userId: number, newHash: string): void {
  getDb()
    .prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1 WHERE id = ?`)
    .run(newHash, userId);
}

export function listUsers(): User[] {
  const rows = getDb().prepare('SELECT * FROM users ORDER BY id').all() as UserRow[];
  return rows.map(toUser);
}

export function createUser(username: string, hash: string, role: 'admin' | 'user'): void {
  getDb()
    .prepare(`INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, 1)`)
    .run(username, hash, role);
}

export function listUserPermissions(userId: number): DataPermission[] {
  return getDb().prepare(
    `SELECT user_id AS userId, connection_id AS connectionId, database_name AS database
     FROM user_data_permissions WHERE user_id = ? ORDER BY connection_id, database_name`
  ).all(userId) as DataPermission[];
}

export function replaceUserPermissions(userId: number, permissions: Omit<DataPermission, 'userId'>[]): void {
  const db = getDb();
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM user_data_permissions WHERE user_id = ?').run(userId);
    const insert = db.prepare(
      `INSERT INTO user_data_permissions (user_id, connection_id, database_name) VALUES (?, ?, ?)`
    );
    for (const permission of permissions) {
      insert.run(userId, permission.connectionId, permission.database);
    }
  });
  replace();
}

export function hasDataPermission(user: Pick<User, 'id' | 'role'> & { isAgent?: 0 | 1 }, connectionId: number, database: string): boolean {
  if (user.isAgent) return true; // AGENT_TOKEN 虚拟用户：全连接只读放行
  if (user.role === 'admin') return true;
  const row = getDb().prepare(
    `SELECT 1 FROM user_data_permissions
     WHERE user_id = ? AND connection_id = ? AND database_name = ?`
  ).get(user.id, connectionId, database) as { 1: number } | undefined;
  return Boolean(row);
}

export function listAuthorizedConnectionIds(user: Pick<User, 'id' | 'role'> & { isAgent?: 0 | 1 }): number[] | null {
  if (user.isAgent) return null; // AGENT_TOKEN 虚拟用户：全连接只读放行（与 hasDataPermission 同款语义）
  if (user.role === 'admin') return null;
  const rows = getDb().prepare(
    'SELECT DISTINCT connection_id AS id FROM user_data_permissions WHERE user_id = ? ORDER BY connection_id'
  ).all(user.id) as { id: number }[];
  return rows.map((row) => row.id);
}

export function listAuthorizedDatabases(user: Pick<User, 'id' | 'role'> & { isAgent?: 0 | 1 }, connectionId: number): string[] | null {
  if (user.isAgent || user.role === 'admin') return null;
  const rows = getDb().prepare(
    `SELECT database_name AS database FROM user_data_permissions
     WHERE user_id = ? AND connection_id = ? ORDER BY database_name`
  ).all(user.id, connectionId) as { database: string }[];
  return rows.map((row) => row.database);
}

// ============ 管理员隐藏配置（仅影响管理员侧的树/列表显示，不影响授权与查询权限） ============

export function listAllHiddenDatabases(userId: number): DataPermission[] {
  return getDb().prepare(
    `SELECT user_id AS userId, connection_id AS connectionId, database_name AS database
     FROM user_hidden_databases WHERE user_id = ? ORDER BY connection_id, database_name`
  ).all(userId) as DataPermission[];
}

export function listHiddenDatabasesFor(userId: number, connectionId: number): string[] {
  const rows = getDb().prepare(
    `SELECT database_name FROM user_hidden_databases WHERE user_id = ? AND connection_id = ?`
  ).all(userId, connectionId) as { database_name: string }[];
  return rows.map((row) => row.database_name);
}

export function replaceHiddenDatabases(userId: number, hidden: Omit<DataPermission, 'userId'>[]): void {
  const db = getDb();
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM user_hidden_databases WHERE user_id = ?').run(userId);
    const insert = db.prepare(
      `INSERT INTO user_hidden_databases (user_id, connection_id, database_name) VALUES (?, ?, ?)`
    );
    for (const item of hidden) {
      insert.run(userId, item.connectionId, item.database);
    }
  });
  replace();
}

/**
 * ES 视图权限匹配：授权条目与请求的 index 双向兼容——
 * 授权 `xxx-*` 放行 `xxx-*` 视图与 `xxx-2026.11.02` 等具体索引；
 * 旧授权（具体索引名）也放行覆盖它的 `xxx-*` 视图模式
 */
export function indexAuthorized(authorized: string, requested: string): boolean {
  if (authorized === requested) return true;
  if (authorized.endsWith('*') && requested.startsWith(authorized.slice(0, -1))) return true;
  if (requested.endsWith('*') && authorized.startsWith(requested.slice(0, -1))) return true;
  return false;
}

// ============ Data Sources ============

interface DataSourceRow {
  id: number;
  name: string;
  type: string;
  host: string;
  port: number;
  username: string;
  password_enc: string;
  database: string;
  schema: string;
  created_at: string;
  updated_at: string;
}

function toDataSource(r: DataSourceRow): DataSource {
  return {
    id: r.id,
    name: r.name,
    type: r.type as DataSource['type'],
    host: r.host,
    port: r.port,
    username: r.username,
    passwordEnc: r.password_enc,
    database: r.database,
    schema: r.schema,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listDataSources(): DataSource[] {
  const rows = getDb()
    .prepare('SELECT * FROM data_sources ORDER BY id')
    .all() as DataSourceRow[];
  return rows.map(toDataSource);
}

export function getDataSource(id: number): DataSource | null {
  const row = getDb()
    .prepare('SELECT * FROM data_sources WHERE id = ?')
    .get(id) as DataSourceRow | undefined;
  return row ? toDataSource(row) : null;
}

export function insertDataSource(input: Omit<DataSource, 'id' | 'createdAt' | 'updatedAt'>): DataSource {
  const info = getDb()
    .prepare(
      `INSERT INTO data_sources
       (name, type, host, port, username, password_enc, database, schema)
       VALUES (@name, @type, @host, @port, @username, @passwordEnc, @database, @schema)`
    )
    .run(input);
  return getDataSource(Number(info.lastInsertRowid))!;
}

export function updateDataSource(id: number, input: Partial<Omit<DataSource, 'id' | 'createdAt' | 'updatedAt'>>): DataSource | null {
  const cols: string[] = [];
  const vals: unknown[] = [];
  const map: Record<string, string> = {
    name: 'name',
    type: 'type',
    host: 'host',
    port: 'port',
    username: 'username',
    passwordEnc: 'password_enc',
    database: 'database',
    schema: 'schema',
  };
  for (const [k, col] of Object.entries(map)) {
    if (input[k as keyof typeof input] !== undefined) {
      cols.push(`${col} = ?`);
      vals.push(input[k as keyof typeof input]);
    }
  }
  if (cols.length === 0) return getDataSource(id);
  cols.push(`updated_at = datetime('now')`);
  vals.push(id);
  getDb().prepare(`UPDATE data_sources SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
  return getDataSource(id);
}

export function deleteDataSource(id: number): void {
  getDb().prepare('DELETE FROM data_sources WHERE id = ?').run(id);
}

// ============ Audit Logs ============

export interface InsertAuditLogInput {
  userId: number;
  username: string;
  connectionId: number | null;
  connectionName: string | null;
  sql: string;
  riskLevel: string;
  rulesHit: string;
  aiSummary: string;
  decision: string;
  executed: number;
  elapsedMs: number;
  result: string;
}

export function insertAuditLog(input: InsertAuditLogInput): void {
  getDb()
    .prepare(
      `INSERT INTO audit_logs
       (user_id, username, connection_id, connection_name, sql, risk_level, rules_hit, ai_summary, decision, executed, elapsed_ms, result)
       VALUES (@userId, @username, @connectionId, @connectionName, @sql, @riskLevel, @rulesHit, @aiSummary, @decision, @executed, @elapsedMs, @result)`
    )
    .run(input);
}

interface ApprovalRow {
  id: string;
  requesterId: number;
  requesterName: string;
  connectionId: number;
  connectionName: string;
  database: string;
  sql: string;
  auditJson: string;
  status: ApprovalRequest['status'];
  reviewerId: number | null;
  reviewerName: string | null;
  reviewComment: string;
  executed: 0 | 1;
  elapsedMs: number;
  result: string;
  createdAt: string;
  reviewedAt: string | null;
}

function toApproval(row: ApprovalRow): ApprovalRequest {
  return { ...row, audit: JSON.parse(row.auditJson) as AuditResult };
}

export function createApprovalRequest(input: {
  id: string;
  requesterId: number;
  requesterName: string;
  connectionId: number;
  connectionName: string;
  database: string;
  sql: string;
  audit: AuditResult;
}): ApprovalRequest {
  getDb().prepare(
    `INSERT INTO approval_requests
     (id, requester_id, requester_name, connection_id, connection_name, database_name, sql, audit_json)
     VALUES (@id, @requesterId, @requesterName, @connectionId, @connectionName, @database, @sql, @auditJson)`
  ).run({ ...input, auditJson: JSON.stringify(input.audit) });
  return getApprovalRequest(input.id)!;
}

export function getApprovalRequest(id: string): ApprovalRequest | null {
  const row = getDb().prepare(
    `SELECT id, requester_id AS requesterId, requester_name AS requesterName,
            connection_id AS connectionId, connection_name AS connectionName,
            database_name AS database, sql, audit_json AS auditJson, status,
            reviewer_id AS reviewerId, reviewer_name AS reviewerName,
            review_comment AS reviewComment, executed, elapsed_ms AS elapsedMs,
            result, created_at AS createdAt, reviewed_at AS reviewedAt
     FROM approval_requests WHERE id = ?`
  ).get(id) as ApprovalRow | undefined;
  return row ? toApproval(row) : null;
}

export function listApprovalRequests(opts: { status?: ApprovalRequest['status']; requesterId?: number }): ApprovalRequest[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.status) {
    clauses.push('status = @status');
    params.status = opts.status;
  }
  if (opts.requesterId) {
    clauses.push('requester_id = @requesterId');
    params.requesterId = opts.requesterId;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = getDb().prepare(
    `SELECT id, requester_id AS requesterId, requester_name AS requesterName,
            connection_id AS connectionId, connection_name AS connectionName,
            database_name AS database, sql, audit_json AS auditJson, status,
            reviewer_id AS reviewerId, reviewer_name AS reviewerName,
            review_comment AS reviewComment, executed, elapsed_ms AS elapsedMs,
            result, created_at AS createdAt, reviewed_at AS reviewedAt
     FROM approval_requests ${where} ORDER BY created_at DESC`
  ).all(params) as ApprovalRow[];
  return rows.map(toApproval);
}

export function cancelApprovalRequest(id: string, requesterId: number): ApprovalRequest | null {
  const info = getDb().prepare(
    `UPDATE approval_requests
     SET status = 'cancelled', result = '用户已取消审批', reviewed_at = datetime('now')
     WHERE id = ? AND requester_id = ? AND status = 'pending'`
  ).run(id, requesterId);
  return info.changes === 1 ? getApprovalRequest(id) : null;
}

export function claimApprovalRequest(input: {
  id: string;
  reviewerId: number;
  reviewerName: string;
  reviewComment: string;
}): ApprovalRequest | null {
  const info = getDb().prepare(
    `UPDATE approval_requests
     SET status = 'processing', reviewer_id = @reviewerId, reviewer_name = @reviewerName,
         review_comment = @reviewComment, reviewed_at = datetime('now')
     WHERE id = @id AND status = 'pending'`
  ).run(input);
  return info.changes === 1 ? getApprovalRequest(input.id) : null;
}

export function resolveApprovalRequest(input: {
  id: string;
  status: 'approved' | 'rejected' | 'failed';
  reviewerId: number;
  reviewerName: string;
  reviewComment: string;
  executed: 0 | 1;
  elapsedMs: number;
  result: string;
}): ApprovalRequest | null {
  getDb().prepare(
    `UPDATE approval_requests
     SET status = @status, reviewer_id = @reviewerId, reviewer_name = @reviewerName,
         review_comment = @reviewComment, executed = @executed, elapsed_ms = @elapsedMs,
         result = @result, reviewed_at = datetime('now')
     WHERE id = @id AND status IN ('pending', 'processing')`
  ).run(input);
  return getApprovalRequest(input.id);
}

export function getAuditLogById(id: number): AuditLog | null {
  const row = getDb()
    .prepare(
      `SELECT id, user_id AS userId, username, connection_id AS connectionId, connection_name AS connectionName,
              sql, risk_level AS riskLevel, rules_hit AS rulesHit, ai_summary AS aiSummary,
              decision, executed, elapsed_ms AS elapsedMs, result, created_at AS createdAt
       FROM audit_logs WHERE id = ?`
    )
    .get(id) as AuditLog | undefined;
  return row ?? null;
}

export function listAuditLogs(opts: { limit: number; offset: number; userId?: number }): {
  items: AuditLog[];
  total: number;
} {
  const where = opts.userId ? 'WHERE user_id = @userId' : '';
  const rows = getDb()
    .prepare(
      `SELECT id, user_id AS userId, username, connection_id AS connectionId, connection_name AS connectionName,
              sql, risk_level AS riskLevel, rules_hit AS rulesHit, ai_summary AS aiSummary,
              decision, executed, elapsed_ms AS elapsedMs, result, created_at AS createdAt
       FROM audit_logs ${where} ORDER BY id DESC LIMIT @limit OFFSET @offset`
    )
    .all({ ...opts }) as unknown as AuditLog[];
  const total = (
    getDb().prepare(`SELECT COUNT(*) AS c FROM audit_logs ${where}`).get({ userId: opts.userId }) as { c: number }
  ).c;
  return { items: rows, total };
}

/** 清空全部审计日志（仅管理员，「一键清理审计历史」） */
export function clearAuditLogs(): void {
  getDb().prepare('DELETE FROM audit_logs').run();
}
