import type { DatabaseType } from './drivers/types.js';

export interface User {
  id: number;
  username: string;
  role: 'admin' | 'user';
  mustChangePassword: 0 | 1;
  /** AGENT_TOKEN 虚拟用户标记；仅存在于内存态，不入库 */
  isAgent?: 0 | 1;
  /** 改密后递增，用于吊销旧 JWT（与 JWT payload 中的 tv 比对） */
  tokenVersion: number;
  createdAt: string;
}

export interface DataSource {
  id: number;
  name: string;
  type: DatabaseType;
  host: string;
  port: number;
  username: string;
  passwordEnc: string; // AES-256-GCM 加密
  database: string;
  /** PG 默认 schema */
  schema: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLog {
  id: number;
  userId: number;
  username: string;
  connectionId: number | null;
  connectionName: string | null;
  sql: string;
  riskLevel: 'low' | 'medium' | 'high';
  rulesHit: string;
  aiSummary: string;
  decision:
    | 'auto_allow'
    | 'confirmed'
    | 'rejected'
    | 'blocked'
    | 'agent_readonly'
    | 'agent_write'
    | 'approval_pending'
    | 'approval_approved'
    | 'approval_rejected'
    | 'approval_failed'
    | 'approval_cancelled';
  executed: 0 | 1;
  elapsedMs: number;
  result: string;
  createdAt: string;
}

export interface AuditResult {
  riskLevel: 'low' | 'medium' | 'high';
  summary: string;
  findings: { severity: 'low' | 'medium' | 'high'; message: string }[];
  suggestions: string[];
  rulesHit: string[];
  source: 'rule' | 'llm' | 'both';
}

export interface DataPermission {
  userId: number;
  connectionId: number;
  database: string;
}

export interface ApprovalRequest {
  id: string;
  requesterId: number;
  requesterName: string;
  connectionId: number;
  connectionName: string;
  database: string;
  sql: string;
  audit: AuditResult;
  status: 'pending' | 'processing' | 'approved' | 'rejected' | 'failed' | 'cancelled';
  reviewerId: number | null;
  reviewerName: string | null;
  reviewComment: string;
  executed: 0 | 1;
  elapsedMs: number;
  result: string;
  createdAt: string;
  reviewedAt: string | null;
}
