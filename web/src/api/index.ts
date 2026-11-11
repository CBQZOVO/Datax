import axios from 'axios';

export const api = axios.create({ baseURL: '/api', timeout: 120000 });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('datax_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('datax_token');
      if (!location.pathname.startsWith('/login')) {
        location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export function errMsg(e: unknown): string {
  return (e as { response?: { data?: { error?: string } } })?.response?.data?.error
    ?? (e as Error).message
    ?? '未知错误';
}

// ============ 类型 ============

export interface User {
  id: number;
  username: string;
  role: 'admin' | 'user';
  mustChangePassword: number;
  createdAt: string;
}

export type DbType = 'mysql' | 'postgres' | 'elasticsearch' | 'redis';

export interface Connection {
  id: number;
  name: string;
  type: DbType;
  host: string;
  port: number;
  username: string;
  database: string;
  schema: string;
}

export interface QueryResult {
  columns: string[];
  rows: (string | null)[][];
  message: string;
  elapsedMs: number;
  affectedRows?: number;
}

export interface ExplainResult {
  columns: string[];
  rows: (string | null)[][];
  estimatedRows: number | null;
}

export interface AuditFinding {
  severity: 'low' | 'medium' | 'high';
  message: string;
}

export interface AuditResult {
  riskLevel: 'low' | 'medium' | 'high';
  summary: string;
  findings: AuditFinding[];
  suggestions: string[];
  rulesHit: string[];
  source: 'rule' | 'llm' | 'both';
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  comment?: string | null;
}

export interface AuditLogItem {
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
  executed: number;
  elapsedMs: number;
  result: string;
  createdAt: string;
}

export interface SysConfig {
  aiEnabled: boolean;
  aiModel: string | null;
  auditMode: 'strict' | 'warn' | 'off';
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
