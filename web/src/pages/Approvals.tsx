import { useCallback, useEffect, useState } from 'react';
import {
  App,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Segmented,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  CopyOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { api, errMsg, type ApprovalRequest } from '../api';
import { useAuthStore } from '../stores/auth';
import { fmtTime } from '../utils/time';

const STATUS_LABEL: Record<ApprovalRequest['status'], string> = {
  pending: '待审批',
  processing: '执行中',
  approved: '已批准',
  rejected: '已拒绝',
  failed: '执行失败',
  cancelled: '已取消',
};
const STATUS_COLOR: Record<ApprovalRequest['status'], string> = {
  pending: 'orange', processing: 'processing', approved: 'green', rejected: 'default', failed: 'red', cancelled: 'default',
};
const RISK_COLOR = { low: 'green', medium: 'orange', high: 'red' } as const;

export default function Approvals() {
  const { message } = App.useApp();
  const user = useAuthStore((s) => s.user);
  const [items, setItems] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending'>('pending');
  const [reviewing, setReviewing] = useState<ApprovalRequest | null>(null);
  const [action, setAction] = useState<'approve' | 'reject' | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const { data } = await api.get('/query/approvals', { params: filter === 'pending' ? { status: 'pending' } : undefined });
      setItems(data.approvals);
    } catch (error) {
      if (showLoading) message.error(errMsg(error));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [filter, message]);

  useEffect(() => {
    void load(true);
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [load]);

  const review = async (approved: boolean) => {
    if (!reviewing) return;
    setSubmitting(true);
    setAction(approved ? 'approve' : 'reject');
    try {
      const { data } = await api.post(`/query/approvals/${reviewing.id}/review`, { approved, comment });
      message.success(approved ? `已批准并执行：${data.result?.message ?? '执行完成'}` : '已拒绝该操作');
      setReviewing(null);
      setComment('');
      await load();
    } catch (error) {
      message.error(errMsg(error));
    } finally {
      setSubmitting(false);
      setAction(null);
    }
  };

  const copySql = async () => {
    if (!reviewing) return;
    try {
      await navigator.clipboard.writeText(reviewing.sql);
      message.success('SQL 已复制');
    } catch {
      message.error('复制失败');
    }
  };

  const columns = [
    { title: '申请人', dataIndex: 'requesterName', width: 120 },
    { title: '数据范围', key: 'scope', width: 220, render: (_: unknown, item: ApprovalRequest) => <><Typography.Text strong>{item.connectionName}</Typography.Text><br /><Typography.Text type="secondary">{item.database}</Typography.Text></> },
    { title: '风险', dataIndex: ['audit', 'riskLevel'], width: 90, render: (risk: ApprovalRequest['audit']['riskLevel']) => <Tag color={RISK_COLOR[risk]}>{risk === 'high' ? '高危' : risk}</Tag> },
    { title: 'SQL', dataIndex: 'sql', ellipsis: true, render: (sql: string) => <Typography.Text code title={sql}>{sql}</Typography.Text> },
    { title: '状态', dataIndex: 'status', width: 100, render: (status: ApprovalRequest['status']) => <Tag color={STATUS_COLOR[status]}>{STATUS_LABEL[status]}</Tag> },
    { title: '申请时间', dataIndex: 'createdAt', width: 180, render: (v: string) => fmtTime(v) },
    ...(user?.role === 'admin' ? [{
      title: '操作', key: 'action', width: 100, fixed: 'right' as const,
      render: (_: unknown, item: ApprovalRequest) => item.status === 'pending' ? <Button type="link" onClick={() => { setReviewing(item); setComment(''); }}>审批</Button> : null,
    }] : []),
  ];

  return (
    <div className="management-page">
      <header className="management-header">
        <div className="management-title">
          <SafetyCertificateOutlined className="management-title-icon" />
          <div>
            <Typography.Title level={4}>{user?.role === 'admin' ? '高危操作审批' : '我的高危申请'}</Typography.Title>
            <Typography.Text type="secondary">高危 SQL 必须由管理员审核，并由服务端执行和留痕</Typography.Text>
          </div>
        </div>
        <Segmented value={filter} onChange={(value) => setFilter(value as 'all' | 'pending')} options={[{ label: '待审批', value: 'pending' }, { label: '全部', value: 'all' }]} />
      </header>
      <main className="management-content">
        <Card className="management-card">
          <Table rowKey="id" loading={loading} columns={columns} dataSource={items} pagination={{ pageSize: 20 }} scroll={{ x: 1100 }} locale={{ emptyText: <Empty description="暂无审批记录" /> }} />
        </Card>
      </main>

      <Modal
        title={reviewing ? (
          <Space>
            <span>审批高危操作</span>
            <Tag color={RISK_COLOR[reviewing.audit.riskLevel]}>
              {reviewing.audit.riskLevel === 'high' ? '高危' : reviewing.audit.riskLevel === 'medium' ? '中危' : '低危'}
            </Tag>
          </Space>
        ) : '审批高危操作'}
        width={720}
        open={Boolean(reviewing)}
        onCancel={() => setReviewing(null)}
        footer={reviewing ? [
          <Button key="cancel" onClick={() => setReviewing(null)}>取消</Button>,
          <Button
            key="reject"
            danger
            disabled={submitting}
            loading={submitting && action === 'reject'}
            icon={<CloseOutlined />}
            onClick={() => void review(false)}
          >
            拒绝执行
          </Button>,
          <Button
            key="approve"
            type="primary"
            danger
            disabled={submitting}
            loading={submitting && action === 'approve'}
            icon={<CheckOutlined />}
            onClick={() => void review(true)}
          >
            批准并立即执行
          </Button>,
        ] : null}
      >
        {reviewing && (
          <>
            <section className="audit-section">
              <div className="audit-section-label">申请信息</div>
              <div className="approval-meta">
                <div className="approval-meta-item">
                  <span className="approval-meta-label">申请人</span>
                  <span>{reviewing.requesterName}</span>
                </div>
                <div className="approval-meta-item">
                  <span className="approval-meta-label">数据范围</span>
                  <span>{reviewing.connectionName} / {reviewing.database}</span>
                </div>
                <div className="approval-meta-item">
                  <span className="approval-meta-label">申请时间</span>
                  <span>{fmtTime(reviewing.createdAt)}</span>
                </div>
              </div>
            </section>

            <section className="audit-section">
              <div className="audit-section-label">
                审计语句
                <Button type="link" size="small" icon={<CopyOutlined />} onClick={() => void copySql()}>复制</Button>
              </div>
              <pre className="audit-sql">{reviewing.sql}</pre>
            </section>

            <section className="audit-section">
              <div className="audit-section-label">安全审计</div>
              <div className="audit-verdict">
                <span className="audit-verdict-text">{reviewing.audit.summary || '未给出结论'}</span>
              </div>
              {reviewing.audit.findings.length > 0 && (
                <div className="audit-findings">
                  {reviewing.audit.findings.map((f, i) => (
                    <div className="audit-finding" key={i}>
                      <Tag color={RISK_COLOR[f.severity]}>{f.severity === 'high' ? '高危' : f.severity === 'medium' ? '中危' : '提示'}</Tag>
                      <span>{f.message}</span>
                    </div>
                  ))}
                </div>
              )}
              {reviewing.audit.suggestions.length > 0 && (
                <ul className="audit-suggestions">
                  {reviewing.audit.suggestions.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              )}
            </section>

            <section className="audit-section">
              <div className="audit-section-label">审批意见（可选）</div>
              <Input.TextArea
                rows={3}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="补充说明批准或拒绝的理由"
                maxLength={1000}
                showCount
              />
            </section>
          </>
        )}
      </Modal>
    </div>
  );
}
