import { useEffect, useRef, useState } from 'react';
import { App, Button, Modal, Table, Tag, Tooltip, Typography } from 'antd';
import { AuditOutlined, CopyOutlined, DeleteOutlined, RobotOutlined } from '@ant-design/icons';
import { api, errMsg, type AuditLogItem } from '../api';
import { fmtTime } from '../utils/time';
import { useAuthStore } from '../stores/auth';

// 表头 + 分页的预留高度，用于计算表体滚动高度
const HEADER_PAGER_HEIGHT = 110;

const RISK_COLOR: Record<string, string> = { high: 'red', medium: 'orange', low: 'green' };
const RISK_LABEL: Record<string, string> = { high: '高危', medium: '中危', low: '低危' };
const DECISION_LABEL: Record<string, string> = {
  auto_allow: '自动放行',
  confirmed: '确认执行',
  rejected: '已拒绝',
  blocked: '已拦截',
  approval_pending: '待审批',
  approval_approved: '审批通过',
  approval_rejected: '审批拒绝',
  approval_cancelled: '审批取消',
  approval_failed: '审批执行失败',
  agent_readonly: 'Agent 只读',
  agent_write: 'Agent 写入',
};

export default function AuditLogPage() {
  const { message, modal } = App.useApp();
  const currentUser = useAuthStore((s) => s.user);
  const [items, setItems] = useState<AuditLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<AuditLogItem | null>(null);
  // 慢 SQL 的 AI 分析
  const [analyzing, setAnalyzing] = useState(false);
  const [slowAnalysis, setSlowAnalysis] = useState<string | null>(null);
  // 当前详情 id 的最新值（闭包里的 detail 是快照，不能用来判断竞态）
  const detailIdRef = useRef<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [tableY, setTableY] = useState(400);

  // 表体滚动高度跟随容器（页面固定视口高度，表格填满剩余空间，表头恒定可见）
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      const h = el.clientHeight - HEADER_PAGER_HEIGHT;
      setTableY(h > 240 ? h : 240);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const load = async (p = page, ps = pageSize) => {
    setLoading(true);
    try {
      const { data } = await api.get('/logs', { params: { page: p, pageSize: ps } });
      setItems(data.items);
      setTotal(data.total);
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(1, pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearLogs = () => {
    modal.confirm({
      title: '清空审计历史',
      content: '将删除所有审计记录，此操作不可恢复，确认继续？',
      okText: '清空',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.delete('/logs');
          message.success('审计历史已清空');
          setPage(1);
          void load(1, pageSize);
        } catch (e) {
          message.error(errMsg(e));
        }
      },
    });
  };

  // 切换查看的日志时重置上一次的 AI 分析结果
  useEffect(() => {
    detailIdRef.current = detail?.id ?? null;
    setSlowAnalysis(null);
  }, [detail?.id]);

  /** 慢 SQL 交给 AI 分析原因与优化建议 */
  const analyzeSlow = async () => {
    if (!detail) return;
    const logId = detail.id;
    setAnalyzing(true);
    try {
      const { data } = await api.post(`/logs/${logId}/analyze`);
      // 分析期间用户切换了详情时，旧结果不再显示到新详情里
      if (detailIdRef.current === logId) setSlowAnalysis(data.analysis as string);
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setAnalyzing(false);
    }
  };

  const copySql = async () => {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(detail.sql);
      message.success('SQL 已复制');
    } catch {
      message.error('复制失败');
    }
  };

  const columns = [
    {
      title: 'ID',
      dataIndex: 'id',
      width: 60,
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 175,
      render: (v: string) => fmtTime(v),
    },
    {
      title: '用户',
      dataIndex: 'username',
      width: 130,
    },
    {
      title: '数据源',
      dataIndex: 'connectionName',
      width: 120,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '风险',
      dataIndex: 'riskLevel',
      width: 80,
      render: (v: string) => <Tag color={RISK_COLOR[v]}>{RISK_LABEL[v] ?? v}</Tag>,
    },
    {
      title: '决策',
      dataIndex: 'decision',
      width: 110,
      render: (v: string) => DECISION_LABEL[v] ?? v,
    },
    {
      title: '执行',
      dataIndex: 'executed',
      width: 70,
      render: (v: number) => (v ? <Tag color="green">已执行</Tag> : <Tag>未执行</Tag>),
    },
    {
      title: '耗时',
      dataIndex: 'elapsedMs',
      width: 80,
      render: (v: number) => (
        <span style={v >= 1000 ? { color: 'var(--datax-danger)', fontWeight: 600 } : undefined}>{v}ms</span>
      ),
    },
    {
      title: 'SQL',
      dataIndex: 'sql',
      ellipsis: true,
      render: (v: string) => (
        <Tooltip title={<pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{v}</pre>}>
          <Typography.Text code style={{ fontSize: 12 }} ellipsis>
            {v.slice(0, 120)}
          </Typography.Text>
        </Tooltip>
      ),
    },
    {
      title: 'AI 结论',
      dataIndex: 'aiSummary',
      ellipsis: true,
      render: (v: string) => v || '-',
    },
    {
      title: '结果',
      dataIndex: 'result',
      ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v}>
          <span style={{ fontSize: 12 }}>{v.slice(0, 80)}</span>
        </Tooltip>
      ),
    },
  ];

  return (
    <div className="management-page auditlog-page">
      <header className="management-header">
        <div className="management-title">
          <AuditOutlined className="management-title-icon" />
          <div>
            <Typography.Title level={4}>AI 审核日志</Typography.Title>
            <Typography.Text type="secondary">所有 SQL 执行与拒绝记录，点击行查看完整详情</Typography.Text>
          </div>
        </div>
        {currentUser?.role === 'admin' && (
          <Button danger icon={<DeleteOutlined />} onClick={clearLogs}>清空审计历史</Button>
        )}
      </header>
      <main className="management-content">
        <div className="log-table-wrap" ref={wrapRef}>
          <Table
            size="small"
            bordered
            loading={loading}
            columns={columns}
            dataSource={items}
            rowKey="id"
            scroll={{ x: 1400, y: tableY, scrollToFirstRowOnChange: true }}
            onRow={(record) => ({ onClick: () => setDetail(record), style: { cursor: 'pointer' } })}
            pagination={{
              current: page,
              pageSize,
              total,
              showSizeChanger: true,
              showTotal: (t) => `共 ${t} 条`,
              onChange: (p, ps) => {
                setPage(p);
                setPageSize(ps);
                void load(p, ps);
              },
            }}
          />
        </div>
      </main>

      <Modal
        open={Boolean(detail)}
        onCancel={() => setDetail(null)}
        footer={null}
        width={720}
        title={detail ? `日志详情 #${detail.id}` : ''}
      >
        {detail && (
          <>
            <section className="audit-section">
              <div className="audit-section-label">基本信息</div>
              <div className="approval-meta">
                <div className="approval-meta-item">
                  <span className="approval-meta-label">时间</span>
                  <span>{fmtTime(detail.createdAt)}</span>
                </div>
                <div className="approval-meta-item">
                  <span className="approval-meta-label">用户</span>
                  <span>{detail.username}</span>
                </div>
                <div className="approval-meta-item">
                  <span className="approval-meta-label">数据源</span>
                  <span>{detail.connectionName ?? '-'}</span>
                </div>
                <div className="approval-meta-item">
                  <span className="approval-meta-label">风险等级</span>
                  <span>
                    <Tag color={RISK_COLOR[detail.riskLevel]}>{RISK_LABEL[detail.riskLevel] ?? detail.riskLevel}</Tag>
                  </span>
                </div>
                <div className="approval-meta-item">
                  <span className="approval-meta-label">决策</span>
                  <span>{DECISION_LABEL[detail.decision] ?? detail.decision}</span>
                </div>
                <div className="approval-meta-item">
                  <span className="approval-meta-label">执行状态</span>
                  <span>
                    {detail.executed
                      ? <Tag color="green">已执行 · {detail.elapsedMs}ms</Tag>
                      : <Tag>未执行</Tag>}
                  </span>
                </div>
              </div>
            </section>

            <section className="audit-section">
              <div className="audit-section-label">
                审计语句
                <Button type="link" size="small" icon={<CopyOutlined />} onClick={() => void copySql()}>复制</Button>
              </div>
              <pre className="audit-sql">{detail.sql}</pre>
            </section>

            <section className="audit-section">
              <div className="audit-section-label">AI 审计</div>
              <div className="audit-verdict">
                <span className="audit-verdict-text">{detail.aiSummary || '无 AI 结论'}</span>
              </div>
              {detail.rulesHit && (
                <div className="audit-findings">
                  <div className="audit-finding">
                    <Tag color={RISK_COLOR[detail.riskLevel]}>规则</Tag>
                    <span>{detail.rulesHit}</span>
                  </div>
                </div>
              )}
            </section>

            <section className="audit-section">
              <div className="audit-section-label">
                执行结果
                {detail.executed === 1 && detail.elapsedMs >= 1000 && (
                  <Button type="link" size="small" loading={analyzing} onClick={() => void analyzeSlow()}>
                    AI 分析慢因
                  </Button>
                )}
              </div>
              <div className="audit-verdict">
                <span className="audit-verdict-text">{detail.result || '-'}</span>
              </div>
              {slowAnalysis && (
                <div className="ai-analysis">
                  <div className="ai-analysis-title">
                    <RobotOutlined />
                    AI 分析 · 慢因与优化建议
                  </div>
                  <div className="ai-analysis-body">{slowAnalysis}</div>
                </div>
              )}
            </section>
          </>
        )}
      </Modal>
    </div>
  );
}
