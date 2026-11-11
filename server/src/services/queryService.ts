import crypto from 'node:crypto';
import { loadConfig } from '../config.js';
import {
  cancelApprovalRequest,
  claimApprovalRequest,
  createApprovalRequest,
  hasDataPermission,
  insertAuditLog,
  resolveApprovalRequest,
} from '../db/store.js';
import { connectionService } from './connectionService.js';
import { auditSql, isCommentOnlyAlter, isWriteStatement, llmExplainSqlError, ruleEngine, splitStatements, stripLiterals } from './aiAuditService.js';
import type { AuditResult } from '../types.js';
import type { ExplainResult, QueryResult } from '../drivers/types.js';
import { splitSqlStatements, leadingVerb } from '../drivers/sqlSplit.js';

export interface AuditResponse {
  needsConfirm: boolean;
  auditId: string;
  audit: AuditResult;
}

interface PendingAudit {
  auditId: string;
  connectionId: number;
  database: string;
  sql: string;
  audit: AuditResult;
  userId: number;
  username: string;
  userRole: 'admin' | 'user';
  connectionName: string;
  createdAt: number;
  explained: boolean;
}

const TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 5_000;

/** 门禁拒绝（agent 越界、权限不足等），路由层据此返回 403 而非 400 */
export class GateError extends Error {}

/** 单副本临时确认凭证；多副本部署需替换为 Redis/共享数据库并保留原子消费语义。 */
class PendingAuditStore {
  private map = new Map<string, PendingAudit>();

  put(pending: PendingAudit): void {
    this.cleanup();
    if (this.map.size >= MAX_PENDING) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest) this.map.delete(oldest);
    }
    this.map.set(pending.auditId, pending);
  }

  get(auditId: string): PendingAudit | undefined {
    this.cleanup();
    return this.map.get(auditId);
  }

  consume(auditId: string): PendingAudit | undefined {
    const pending = this.get(auditId);
    if (pending) this.map.delete(auditId);
    return pending;
  }

  private cleanup(): void {
    const expiresBefore = Date.now() - TTL_MS;
    for (const [key, value] of this.map) {
      if (value.createdAt < expiresBefore) this.map.delete(key);
    }
  }
}

const pendingStore = new PendingAuditStore();

export class QueryService {
  async audit(
    connectionId: number,
    sql: string,
    database: string,
    user: { id: number; username: string; role: 'admin' | 'user' }
  ): Promise<AuditResponse> {
    this.assertPermission(user, connectionId, database);
    const conn = connectionService().get(connectionId);
    if (!conn) throw new Error('数据源不存在');
    this.assertSqlConnection(conn);
    const audit = await auditSql(sql, conn.type, extractTableHints(sql));
    if (audit.riskLevel === 'low') return { needsConfirm: false, auditId: '', audit };

    const auditId = crypto.randomUUID();
    pendingStore.put({
      auditId,
      connectionId,
      database,
      sql,
      audit,
      userId: user.id,
      username: user.username,
      userRole: user.role,
      connectionName: conn.name,
      createdAt: Date.now(),
      explained: false,
    });
    return { needsConfirm: true, auditId, audit };
  }

  /** 服务端从审计凭证取回原始 SQL，防止前端替换 SQL 绕过审计。 */
  async explain(auditId: string, user: { id: number }): Promise<ExplainResult> {
    const pending = this.requirePending(auditId, user.id);
    if (!isExplainableDml(pending.sql)) {
      pending.explained = true;
      return {
        columns: ['PRECHECK'],
        rows: [['该 DDL/过程调用不支持 EXPLAIN；已完成语法风险预检，请严格核对对象名和影响范围。']],
        estimatedRows: null,
      };
    }
    const driver = connectionService().getDriverForDatabase(pending.connectionId, pending.database);
    let result: ExplainResult;
    try {
      result = await driver.explain(pending.sql);
    } catch (error) {
      throw await friendlySqlError(error, pending.sql);
    }
    // 纯读语句没有"影响行数"概念（EXPLAIN rows 是扫描行数），置空避免误导
    const WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE']);
    if (!splitSqlStatements(pending.sql).some((s) => WRITE_VERBS.has(leadingVerb(s)))) {
      result.estimatedRows = null;
    }
    pending.explained = true;
    return result;
  }

  async confirm(
    auditId: string,
    confirmed: boolean,
    user: { id: number; username: string; role: 'admin' | 'user' }
  ): Promise<{ executed: boolean; result?: QueryResult; message: string; approvalId?: string }> {
    const pending = this.requirePending(auditId, user.id);
    this.assertPermission(user, pending.connectionId, pending.database);
    if (!confirmed) {
      pendingStore.consume(auditId);
      this.writeLog(pending, user, 'rejected', 0, 0, '用户拒绝执行');
      return { executed: false, message: '已拒绝执行' };
    }
    if (
      loadConfig().ai.auditMode === 'strict'
      && pending.audit.riskLevel === 'high'
      && isWriteStatement(pending.sql)
      && !pending.explained
    ) {
      throw new Error('高危写操作必须先完成 EXPLAIN 预查询');
    }

    if (pending.audit.riskLevel === 'high' && pending.userRole !== 'admin') {
      const consumed = pendingStore.consume(auditId);
      if (!consumed) throw new Error('确认凭证无效或已过期，请重新提交 SQL 并再次审计');
      const approval = createApprovalRequest({
        id: crypto.randomUUID(),
        requesterId: consumed.userId,
        requesterName: consumed.username,
        connectionId: consumed.connectionId,
        connectionName: consumed.connectionName,
        database: consumed.database,
        sql: consumed.sql,
        audit: consumed.audit,
      });
      this.writeLog(consumed, user, 'approval_pending', 0, 0, `等待管理员审批：${approval.id}`);
      return { executed: false, message: '高危操作已提交管理员审批', approvalId: approval.id };
    }

    // 校验完成后再原子消费，避免同一凭证重复/并发执行。
    const consumed = pendingStore.consume(auditId);
    if (!consumed) throw new Error('确认凭证无效或已过期，请重新提交 SQL 并再次审计');
    const driver = connectionService().getDriverForDatabase(consumed.connectionId, consumed.database);
    const start = Date.now();
    try {
      const result = await driver.executeQuery(consumed.sql);
      this.writeLog(consumed, user, 'confirmed', 1, Date.now() - start, result.message);
      return { executed: true, result, message: result.message };
    } catch (error) {
      this.writeLog(consumed, user, 'confirmed', 0, Date.now() - start, safeError(error));
      throw await friendlySqlError(error, consumed.sql);
    }
  }

  async executeLowRisk(
    connectionId: number,
    sql: string,
    database: string,
    audit: AuditResult,
    user: { id: number; username: string; role: 'admin' | 'user' }
  ): Promise<QueryResult> {
    this.assertPermission(user, connectionId, database);
    const conn = connectionService().get(connectionId);
    if (!conn) throw new Error('数据源不存在');
    const driver = connectionService().getDriverForDatabase(connectionId, database);
    const start = Date.now();
    try {
      const result = await driver.executeQuery(sql);
      insertAuditLog({
        userId: user.id,
        username: user.username,
        connectionId,
        connectionName: conn.name,
        sql,
        riskLevel: audit.riskLevel,
        rulesHit: audit.rulesHit.join(', '),
        aiSummary: audit.summary,
        decision: 'auto_allow',
        executed: 1,
        elapsedMs: Date.now() - start,
        result: result.message,
      });
      return result;
    } catch (error) {
      insertAuditLog({
        userId: user.id,
        username: user.username,
        connectionId,
        connectionName: conn.name,
        sql,
        riskLevel: audit.riskLevel,
        rulesHit: audit.rulesHit.join(', '),
        aiSummary: audit.summary,
        decision: 'auto_allow',
        executed: 0,
        elapsedMs: Date.now() - start,
        result: safeError(error),
      });
      throw await friendlySqlError(error, sql);
    }
  }

  async auditOnly(
    connectionId: number,
    sql: string,
    database: string,
    user: { id: number; role: 'admin' | 'user' }
  ): Promise<AuditResult> {
    this.assertPermission(user, connectionId, database);
    const conn = connectionService().get(connectionId);
    if (!conn) throw new Error('数据源不存在');
    this.assertSqlConnection(conn);
    return auditSql(sql, conn.type, extractTableHints(sql));
  }

  cancelApproval(
    approvalId: string,
    user: { id: number; username: string; role: 'admin' | 'user' }
  ): ReturnType<typeof cancelApprovalRequest> {
    const approval = cancelApprovalRequest(approvalId, user.id);
    if (!approval) throw new Error('审批单不存在、已处理或不属于当前用户');
    this.writeApprovalLog(approval, user, 'approval_cancelled', 0, 0, '用户已取消审批');
    return approval;
  }

  async reviewApproval(
    approvalId: string,
    approved: boolean,
    comment: string,
    admin: { id: number; username: string; role: 'admin' | 'user' }
  ): Promise<{ approval: ReturnType<typeof resolveApprovalRequest>; result?: QueryResult }> {
    if (admin.role !== 'admin') throw new Error('仅管理员可以审批高危操作');
    const approval = claimApprovalRequest({
      id: approvalId,
      reviewerId: admin.id,
      reviewerName: admin.username,
      reviewComment: comment,
    });
    if (!approval) throw new Error('审批单不存在或已处理');
    if (!approved) {
      const rejected = resolveApprovalRequest({
        id: approval.id,
        status: 'rejected',
        reviewerId: admin.id,
        reviewerName: admin.username,
        reviewComment: comment,
        executed: 0,
        elapsedMs: 0,
        result: '管理员拒绝执行',
      });
      this.writeApprovalLog(approval, admin, 'approval_rejected', 0, 0, '管理员拒绝执行');
      return { approval: rejected };
    }
    const driver = connectionService().getDriverForDatabase(approval.connectionId, approval.database);
    const start = Date.now();
    try {
      const result = await driver.executeQuery(approval.sql);
      const elapsedMs = Date.now() - start;
      const resolved = resolveApprovalRequest({
        id: approval.id,
        status: 'approved',
        reviewerId: admin.id,
        reviewerName: admin.username,
        reviewComment: comment,
        executed: 1,
        elapsedMs,
        result: result.message,
      });
      this.writeApprovalLog(approval, admin, 'approval_approved', 1, elapsedMs, result.message);
      return { approval: resolved, result };
    } catch (error) {
      const elapsedMs = Date.now() - start;
      const result = safeError(error);
      resolveApprovalRequest({
        id: approval.id,
        status: 'failed',
        reviewerId: admin.id,
        reviewerName: admin.username,
        reviewComment: comment,
        executed: 0,
        elapsedMs,
        result,
      });
      this.writeApprovalLog(approval, admin, 'approval_failed', 0, elapsedMs, result);
      throw await friendlySqlError(error, approval.sql);
    }
  }

  isWrite(sql: string): boolean {
    return isWriteStatement(sql);
  }

  private assertSqlConnection(conn: { type: string }): void {
    if (conn.type === 'elasticsearch') {
      throw new Error('ES 连接不支持 SQL 查询，请使用 /api/es/search');
    }
  }

  /**
   * Agent 只读执行：三道闸校验（verb 白名单 → 写黑名单 → 规则引擎），
   * 全部通过才执行；不调用 LLM；结果集截断到 maxRows。
   */
  async executeReadonly(
    connectionId: number,
    sql: string,
    database: string,
    user: { id: number; username: string; role: 'admin' | 'user'; isAgent?: 0 | 1 },
    maxRows: number
  ): Promise<QueryResult & { truncated: boolean }> {
    this.assertPermission(user, connectionId, database);
    const conn = connectionService().get(connectionId);
    if (!conn) throw new Error('数据源不存在');
    this.assertSqlConnection(conn);

    // 写权限：需 AGENT_WRITE_ENABLED 显式开启，且（若配置了 AGENT_WRITE_CONNECTIONS）连接必须在白名单内
    const agentWriteCfg = loadConfig().agentWrite;
    const writeAllowed = agentWriteCfg.enabled
      && (agentWriteCfg.connectionIds.length === 0 || agentWriteCfg.connectionIds.includes(connectionId));

    // 单语句约束始终生效：多语句注入风险不可控
    const { statements } = splitStatements(sql);
    if (statements.length !== 1) {
      throw new GateError('agent token 仅允许单条语句');
    }
    if (!writeAllowed) {
      // 闸 1：verb 白名单
      const clean = statements[0].replace(/^[ \t]*/, '');
      if (!/^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\b/i.test(clean)) {
        throw new GateError('agent token 仅允许只读查询（SELECT/SHOW/DESCRIBE/EXPLAIN/WITH）');
      }
      // EXPLAIN ANALYZE / EXPLAIN (ANALYZE ...) 会真实执行语句（MySQL 8.0+ / PG），
      // 任何情况下都不允许 agent 使用
      if (/\bEXPLAIN\s+(?:ANALYZE|ANALYSE)\b/i.test(clean) || /EXPLAIN\s*\([^)]*\bANALYZE/i.test(clean)) {
        throw new GateError('agent token 不允许 EXPLAIN ANALYZE（会真实执行语句）');
      }
      // 闸 2：写黑名单复检（覆盖 CTE 写等）
      if (isWriteStatement(sql)) {
        throw new GateError('agent token 不允许执行写操作');
      }
      // SELECT ... FOR UPDATE/SHARE 会对行加锁（阻塞共享连接）；setval 写序列；
      // pg_read_file/dblink 属服务器副作用函数——对只读 agent 一律拒绝。
      // 已知局限：SELECT 调用自定义写函数无法静态识别，需靠数据库侧账号权限兜底。
      const stripped = stripLiterals(statements[0]);
      if (/\bFOR\s+(UPDATE|SHARE)\b/i.test(stripped) || /\bSETVAL\s*\(|\bPG_READ_FILE\s*\(|\bPG_READ_BINARY_FILE\s*\(|\bPG_LS_DIR\s*\(|\bDBLINK\s*\(/i.test(stripped)) {
        throw new GateError('agent token 不允许执行带副作用或加锁的查询');
      }
    }
    // 闸 3：规则引擎复检（无 LLM），high 始终拦截——即使放开写权限，
    // DROP / TRUNCATE / 无 WHERE 的 UPDATE·DELETE / 文件读写 / 延时注入等仍会被拒绝。
    // medium 不拦：SELECT 类 medium（MISSING_LIMIT）属建议性提示，大结果集由 maxRows 物理截断兜底。
    // 唯一例外：仅改表/字段注释的 ALTER 是元数据维护（不改数据、不改结构），
    // 写权限开启时放行；其余 ALTER 仍 high。普通用户的审计/确认路径不受影响。
    const rule = ruleEngine(sql);
    const commentOnly = writeAllowed && isCommentOnlyAlter(sql);
    const onlyAlterStructure = rule.rulesHit.length > 0 && rule.rulesHit.every((r) => r === 'ALTER_STRUCTURE');
    if (rule.riskLevel === 'high' && !(commentOnly && onlyAlterStructure)) {
      throw new GateError(`agent token 拒绝执行：规则引擎判定 high 风险（${rule.rulesHit.join(', ') || 'unknown'}）`);
    }
    const isWrite = isWriteStatement(sql) || commentOnly;
    const decision: 'agent_write' | 'agent_readonly' = isWrite && writeAllowed ? 'agent_write' : 'agent_readonly';

    const driver = connectionService().getDriverForDatabase(connectionId, database);
    const start = Date.now();
    try {
      const result = await driver.executeQuery(sql);
      const truncated = result.rows.length > maxRows;
      if (truncated) result.rows = result.rows.slice(0, maxRows);
      insertAuditLog({
        userId: user.id,
        username: user.username,
        connectionId,
        connectionName: conn.name,
        sql,
        riskLevel: rule.riskLevel,
        rulesHit: rule.rulesHit.join(', '),
        aiSummary: rule.findings.map((f) => f.message).join('；') || 'agent readonly',
        decision,
        executed: 1,
        elapsedMs: Date.now() - start,
        result: `${result.message}${truncated ? `（截断至 ${maxRows} 行）` : ''}`,
      });
      return { ...result, truncated };
    } catch (error) {
      insertAuditLog({
        userId: user.id,
        username: user.username,
        connectionId,
        connectionName: conn.name,
        sql,
        riskLevel: rule.riskLevel,
        rulesHit: rule.rulesHit.join(', '),
        aiSummary: rule.findings.map((f) => f.message).join('；') || 'agent readonly',
        decision,
        executed: 0,
        elapsedMs: Date.now() - start,
        result: safeError(error),
      });
      throw error;
    }
  }

  private assertPermission(
    user: { id: number; role: 'admin' | 'user' },
    connectionId: number,
    database: string
  ): void {
    if (!hasDataPermission(user, connectionId, database)) {
      throw new GateError('无权访问该数据源或数据库');
    }
  }

  private requirePending(auditId: string, userId: number): PendingAudit {
    const pending = pendingStore.get(auditId);
    if (!pending) throw new Error('确认凭证无效或已过期，请重新提交 SQL 并再次审计');
    if (pending.userId !== userId) throw new Error('确认凭证不属于当前用户');
    return pending;
  }

  private writeApprovalLog(
    approval: { requesterId: number; requesterName: string; connectionId: number; connectionName: string; sql: string; audit: AuditResult },
    admin: { username: string },
    decision: string,
    executed: 0 | 1,
    elapsedMs: number,
    result: string
  ): void {
    insertAuditLog({
      userId: approval.requesterId,
      username: approval.requesterName,
      connectionId: approval.connectionId,
      connectionName: approval.connectionName,
      sql: approval.sql,
      riskLevel: approval.audit.riskLevel,
      rulesHit: approval.audit.rulesHit.join(', '),
      aiSummary: approval.audit.summary,
      decision,
      executed,
      elapsedMs,
      result: `${result}（审批人：${admin.username}）`,
    });
  }

  private writeLog(
    pending: PendingAudit,
    user: { id: number; username: string },
    decision: string,
    executed: 0 | 1,
    elapsedMs: number,
    result: string
  ): void {
    insertAuditLog({
      userId: user.id,
      username: user.username,
      connectionId: pending.connectionId,
      connectionName: pending.connectionName,
      sql: pending.sql,
      riskLevel: pending.audit.riskLevel,
      rulesHit: pending.audit.rulesHit.join(', '),
      aiSummary: pending.audit.summary,
      decision,
      executed,
      elapsedMs,
      result,
    });
  }
}

/** 每条语句都支持 EXPLAIN 才走真实预查询；否则按 DDL 流程给提示性预检 */
function isExplainableDml(sql: string): boolean {
  const stmts = splitSqlStatements(sql);
  return stmts.length > 0 && stmts.every((s) =>
    /^(SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH)\b/.test(
      s.replace(/^\s*(?:--[^\n]*\n|#[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/, '').toUpperCase()
    )
  );
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2000) : '执行失败';
}

/**
 * 把驱动抛出的原始语法错误转成友好提示：定位 + 本地规则建议 + AI 诊断。
 * AI 未配置或超时则静默降级为本地规则提示；非语法错误原样返回，不吞异常。
 */
async function friendlySqlError(error: unknown, sql: string): Promise<unknown> {
  const raw = error instanceof Error ? error.message : String(error);
  if (!/\bsyntax\b|ER_PARSE_ERROR/i.test(raw)) return error;

  const parts: string[] = [];
  const near = /near '([\s\S]+?)' at line (\d+)/.exec(raw);
  if (near) {
    parts.push(`SQL 语法错误：第 ${near[2]} 行 “${near[1].slice(0, 120)}” 附近解析失败`);
  } else {
    parts.push(`SQL 语法错误：${raw.slice(0, 200)}`);
  }

  for (const stmt of splitSqlStatements(sql)) {
    if (/^UPDATE\b/i.test(leadingVerb(stmt)) && /\bset\b[\s\S]*\bset\b/i.test(stmt)) {
      parts.push('提示：UPDATE 出现多个 SET 子句——多字段赋值应写「set a=1, b=2」；限定更新行请用 WHERE，而不是第二个 SET');
    }
    if (/[\u2018\u2019\u201C\u201D；，：（）]/.test(stripLiterals(stmt))) {
      parts.push('提示：语句中含中文全角标点（逗号/分号/括号/引号），SQL 符号需使用英文半角');
    }
  }

  try {
    const ai = await llmExplainSqlError(sql, raw);
    if (ai) parts.push(`AI 诊断：${ai}`);
  } catch {
    // AI 不可用时忽略，保留上面的定位与规则提示
  }
  return new Error(parts.join('；'));
}

export function extractTableHints(sql: string): string[] {
  const re = /\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\s+([`"\[]?[A-Za-z_][A-Za-z0-9_.$]*[`"\]]?)/gi;
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    const parts = match[1].replace(/[`"[\]]/g, '').split('.');
    const name = parts[parts.length - 1];
    if (name && !out.includes(name)) out.push(name);
    if (out.length >= 10) break;
  }
  return out;
}

const service = new QueryService();
export function queryService(): QueryService {
  return service;
}
