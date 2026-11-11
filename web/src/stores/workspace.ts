import { create } from 'zustand';
import dayjs from 'dayjs';
import { api, type ApprovalRequest, type AuditResult, type Connection, type ExplainResult, type QueryResult } from '../api';

export interface Tab {
  key: string;
  requestId: number;
  title: string;
  kind: 'query' | 'data' | 'es' | 'redis' | 'structure';
  connectionId: number;
  connectionName: string;
  database: string;
  schema: string | null;
  table: string | null;
  /** 当前表注释（从数据源树带入，用于面包屑展示） */
  tableComment?: string | null;
  /** 当前表列名小写 → 字段注释（打开表时按表加载，用于结果列头） */
  columnComments?: Record<string, string>;
  sql: string;
  result: QueryResult | null;
  loading: boolean;
  error: string | null;
}

export interface PendingAudit {
  tabKey: string;
  /** 发起审计时的 tab.requestId：确认结果回写前比对，防止覆盖后续新查询 */
  requestId?: number;
  connectionId: number;
  database: string;
  sql: string;
  auditId: string;
  audit: AuditResult;
  approvalId?: string;
  approvalStatus?: ApprovalRequest['status'];
}

interface WorkspaceState {
  connections: Connection[];
  loadingConnections: boolean;
  tabs: Tab[];
  activeTabKey: string | null;

  // 审计确认弹窗
  pendingAudit: PendingAudit | null;
  explain: ExplainResult | null;
  explainLoading: boolean;
  confirming: boolean;

  // 数据源树刷新信号（ES 建索引/删索引后自增，触发树重载）
  treeRefreshNonce: number;
  refreshTree: () => void;

  loadConnections: () => Promise<void>;
  addTab: (tab: Omit<Tab, 'key' | 'requestId' | 'result' | 'loading' | 'error'>) => string;
  updateTab: (key: string, patch: Partial<Tab>) => void;
  closeTab: (key: string) => void;
  setActiveTab: (key: string) => void;

  runQuery: (tabKey: string, sql: string) => Promise<void>;
  runEsSearch: (tabKey: string, opts?: { fields?: string[]; conditions?: { field: string; value: string }[]; start?: string; end?: string; size?: number }) => Promise<void>;
  runEsDsl: (tabKey: string, dslText: string) => Promise<void>;
  runRedisCommand: (tabKey: string, command: string) => Promise<void>;
  openAuditModal: (p: PendingAudit) => void;
  closeAuditModal: () => void;
  loadExplain: () => Promise<void>;
  confirmAudit: (confirmed: boolean) => Promise<{ approvalId?: string; executed: boolean }>;
  pollApproval: () => Promise<ApprovalRequest | null>;
  cancelApproval: () => Promise<void>;
}

let tabSeq = 0;

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  connections: [],
  loadingConnections: false,
  tabs: [],
  activeTabKey: null,
  pendingAudit: null,
  explain: null,
  explainLoading: false,
  confirming: false,
  treeRefreshNonce: 0,

  refreshTree() {
    set((s) => ({ treeRefreshNonce: s.treeRefreshNonce + 1 }));
  },

  async loadConnections() {
    set({ loadingConnections: true });
    try {
      const { data } = await api.get('/connections');
      set({ connections: data.connections });
    } finally {
      set({ loadingConnections: false });
    }
  },

  addTab(tab) {
    const key = `tab-${Date.now()}-${tabSeq++}`;
    const full: Tab = { ...tab, key, requestId: 0, result: null, loading: false, error: null };
    set((s) => ({ tabs: [...s.tabs, full], activeTabKey: key }));
    return key;
  },

  updateTab(key, patch) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.key === key ? { ...t, ...patch } : t)) }));
  },

  closeTab(key) {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.key === key);
      const tabs = s.tabs.filter((t) => t.key !== key);
      let active = s.activeTabKey;
      if (active === key) {
        active = tabs[Math.min(idx, tabs.length - 1)]?.key ?? null;
      }
      return { tabs, activeTabKey: active };
    });
  },

  setActiveTab(key) {
    set({ activeTabKey: key });
  },

  async runQuery(tabKey, sql) {
    const tab = get().tabs.find((item) => item.key === tabKey);
    if (!tab || tab.loading || !sql.trim()) return;
    const requestId = tab.requestId + 1;
    set((state) => ({
      tabs: state.tabs.map((item) => item.key === tabKey
        ? { ...item, sql, requestId, loading: true, error: null }
        : item),
    }));
    try {
      const { data } = await api.post('/query/execute', {
        connectionId: tab.connectionId,
        database: tab.database,
        sql,
      });
      const current = get().tabs.find((item) => item.key === tabKey);
      if (!current || current.requestId !== requestId) return;
      if (data.needsConfirm) {
        set((state) => ({
          tabs: state.tabs.map((item) => item.key === tabKey ? { ...item, loading: false } : item),
        }));
        get().openAuditModal({
          tabKey,
          requestId,
          connectionId: tab.connectionId,
          database: tab.database,
          sql,
          auditId: data.auditId,
          audit: data.audit,
        });
        return;
      }
      set((state) => ({
        tabs: state.tabs.map((item) => item.key === tabKey && item.requestId === requestId
          ? { ...item, result: data.result, loading: false }
          : item),
      }));
    } catch (error) {
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? '执行失败';
      set((state) => ({
        tabs: state.tabs.map((item) => item.key === tabKey && item.requestId === requestId
          ? { ...item, loading: false, error: message }
          : item),
      }));
    }
  },

  /** ES 索引浏览：调 /api/es/search，按 @timestamp 倒序取最新 size（默认 100）条；fields 为空返回全部字段；conditions 多条件 AND */
  async runEsSearch(tabKey, opts) {
    const tab = get().tabs.find((item) => item.key === tabKey);
    if (!tab || tab.loading) return;
    const requestId = tab.requestId + 1;
    const startedAt = Date.now();
    set((state) => ({
      tabs: state.tabs.map((item) => item.key === tabKey
        ? { ...item, requestId, loading: true, error: null }
        : item),
    }));
    try {
      const { data } = await api.post('/es/search', {
        connectionId: tab.connectionId,
        index: tab.database,
        conditions: opts?.conditions?.length ? opts.conditions : undefined,
        start: opts?.start,
        end: opts?.end,
        fields: opts?.fields?.length ? opts.fields : undefined,
        size: opts?.size ?? 100,
        // 默认按时间倒序取最新数据（日志与业务索引通用；字段缺失由后端 unmapped_type 兜底）
        sort: '@timestamp:desc',
      });
      const current = get().tabs.find((item) => item.key === tabKey);
      if (!current || current.requestId !== requestId) return;
      const hits = (data.hits ?? []) as Record<string, unknown>[];
      const cols = hits.length > 0 ? Object.keys(hits[0]) : (opts?.fields?.length ? opts.fields : ['@timestamp']);
      const result: QueryResult = {
        columns: cols,
        rows: hits.map((hit) => cols.map((f) => {
          const v = hit[f];
          if (v == null) return null;
          // @timestamp 为 UTC ISO 串，转浏览器本地时区的可读时间；排序/时间过滤仍按原始值在后端完成
          if (f === '@timestamp') {
            const d = dayjs(String(v));
            return d.isValid() ? d.format('YYYY-MM-DD HH:mm:ss') : String(v);
          }
          return String(v);
        })),
        message: `共匹配 ${data.total ?? hits.length} 条（@timestamp 倒序），显示前 ${hits.length} 条 · 耗时 ${Date.now() - startedAt}ms`,
        elapsedMs: Date.now() - startedAt,
      };
      set((state) => ({
        tabs: state.tabs.map((item) => item.key === tabKey && item.requestId === requestId
          ? { ...item, result, loading: false }
          : item),
      }));
    } catch (error) {
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? '搜索失败';
      set((state) => ({
        tabs: state.tabs.map((item) => item.key === tabKey && item.requestId === requestId
          ? { ...item, loading: false, error: message }
          : item),
      }));
    }
  },

  /** 原生 DSL 查询：把 JSON 文本交后端透传到 /{index}/_search */
  async runEsDsl(tabKey, dslText) {
    let dsl: unknown;
    try {
      dsl = JSON.parse(dslText);
    } catch {
      get().updateTab(tabKey, { error: 'DSL JSON 格式错误' });
      return;
    }
    if (!dsl || typeof dsl !== 'object' || Array.isArray(dsl)) {
      get().updateTab(tabKey, { error: 'DSL 须为 JSON 对象' });
      return;
    }
    const tab = get().tabs.find((item) => item.key === tabKey);
    if (!tab || tab.loading) return;
    const requestId = tab.requestId + 1;
    const startedAt = Date.now();
    set((state) => ({
      tabs: state.tabs.map((item) => item.key === tabKey
        ? { ...item, requestId, loading: true, error: null }
        : item),
    }));
    try {
      const { data } = await api.post('/es/dsl', {
        connectionId: tab.connectionId,
        index: tab.database,
        dsl,
      });
      const current = get().tabs.find((item) => item.key === tabKey);
      if (!current || current.requestId !== requestId) return;
      const hits = (data.hits ?? []) as Record<string, unknown>[];
      const cols = hits.length > 0 ? Object.keys(hits[0]) : ['@timestamp', 'log'];
      const result: QueryResult = {
        columns: cols,
        rows: hits.map((hit) => cols.map((f) => (hit[f] == null ? null : String(hit[f])))),
        message: `共匹配 ${data.total ?? hits.length} 条 · 返回 ${hits.length} 条 · 耗时 ${Date.now() - startedAt}ms`,
        elapsedMs: Date.now() - startedAt,
      };
      set((state) => ({
        tabs: state.tabs.map((item) => item.key === tabKey && item.requestId === requestId
          ? { ...item, result, loading: false }
          : item),
      }));
    } catch (error) {
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? '查询失败';
      set((state) => ({
        tabs: state.tabs.map((item) => item.key === tabKey && item.requestId === requestId
          ? { ...item, loading: false, error: message }
          : item),
      }));
    }
  },

  /** 执行 Redis 命令：POST /api/redis/execute，结果表格化后写入 tab */
  async runRedisCommand(tabKey, command) {
    const tab = get().tabs.find((item) => item.key === tabKey);
    if (!tab || tab.loading || !command.trim()) return;
    const requestId = tab.requestId + 1;
    set((state) => ({
      tabs: state.tabs.map((item) => item.key === tabKey
        ? { ...item, sql: command, requestId, loading: true, error: null }
        : item),
    }));
    try {
      const { data } = await api.post('/redis/execute', {
        connectionId: tab.connectionId,
        database: tab.database,
        command,
      });
      const current = get().tabs.find((item) => item.key === tabKey);
      if (!current || current.requestId !== requestId) return;
      set((state) => ({
        tabs: state.tabs.map((item) => item.key === tabKey && item.requestId === requestId
          ? { ...item, result: data.result as QueryResult, loading: false }
          : item),
      }));
    } catch (error) {
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? '执行失败';
      set((state) => ({
        tabs: state.tabs.map((item) => item.key === tabKey && item.requestId === requestId
          ? { ...item, loading: false, error: message }
          : item),
      }));
    }
  },

  openAuditModal(p) {
    set({ pendingAudit: p, explain: null });
  },

  closeAuditModal() {
    set({ pendingAudit: null, explain: null });
  },

  async loadExplain() {
    const p = get().pendingAudit;
    if (!p) return;
    set({ explainLoading: true });
    try {
      const { data } = await api.post('/query/explain', { auditId: p.auditId });
      if (get().pendingAudit?.auditId === p.auditId) set({ explain: data.explain });
    } finally {
      set({ explainLoading: false });
    }
  },

  async confirmAudit(confirmed) {
    const p = get().pendingAudit;
    if (!p) return { executed: false };
    set({ confirming: true });
    try {
      const { data } = await api.post('/query/confirm', { auditId: p.auditId, confirmed });
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.key === p.tabKey
            // requestId 不一致说明等待期间用户又执行了新查询，旧结果不回写覆盖
            ? { ...t, result: (p.requestId === undefined || t.requestId === p.requestId) ? (data.result ?? t.result) : t.result, error: data.executed ? null : t.error }
            : t
        ),
        pendingAudit: data.approvalId
          ? { ...p, approvalId: data.approvalId, approvalStatus: 'pending' }
          : null,
        explain: data.approvalId ? s.explain : null,
      }));
      return { approvalId: data.approvalId, executed: data.executed };
    } finally {
      set({ confirming: false });
    }
  },

  async pollApproval() {
    const p = get().pendingAudit;
    if (!p?.approvalId) return null;
    const { data } = await api.get(`/query/approvals/${p.approvalId}`);
    const approval = data.approval as ApprovalRequest;
    if (get().pendingAudit?.approvalId !== p.approvalId) return null;
    if (approval.status === 'pending' || approval.status === 'processing') {
      set({ pendingAudit: { ...p, approvalStatus: approval.status } });
      return approval;
    }
    set((s) => ({
      tabs: s.tabs.map((t) => t.key === p.tabKey
        ? {
            ...t,
            result: approval.status === 'approved' && approval.executed
              ? approvalResult(approval)
              : t.result,
            error: approval.status === 'failed' ? approval.result || '管理员批准后执行失败' : null,
          }
        : t),
      pendingAudit: null,
      explain: null,
    }));
    return approval;
  },

  async cancelApproval() {
    const p = get().pendingAudit;
    if (!p?.approvalId) return;
    set({ confirming: true });
    try {
      await api.post(`/query/approvals/${p.approvalId}/cancel`);
      if (get().pendingAudit?.approvalId === p.approvalId) {
        set({ pendingAudit: null, explain: null });
      }
    } finally {
      set({ confirming: false });
    }
  },
}));

function approvalResult(approval: ApprovalRequest): QueryResult {
  return {
    columns: [],
    rows: [],
    message: approval.result || '管理员已批准并执行',
    elapsedMs: approval.elapsedMs,
  };
}
