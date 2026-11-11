import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Modal,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExperimentOutlined,
  RobotOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { errMsg } from '../api';
import { useWorkspaceStore } from '../stores/workspace';
import { useAuthStore } from '../stores/auth';

const RISK_COLOR: Record<string, string> = { high: 'red', medium: 'orange', low: 'green' };
const RISK_LABEL: Record<string, string> = { high: '高危', medium: '中危', low: '低危' };

export default function AuditConfirmModal() {
  const { message } = App.useApp();
  const user = useAuthStore((state) => state.user);
  const { pendingAudit, explain, explainLoading, confirming, loadExplain, confirmAudit, pollApproval, cancelApproval, closeAuditModal } =
    useWorkspaceStore();
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [explainError, setExplainError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<'confirm' | 'reject' | 'cancel' | null>(null);

  // 换一条审计语句时清掉上一次的预查询错误
  const auditId = pendingAudit?.auditId;
  useEffect(() => {
    setExplainError(null);
  }, [auditId]);

  useEffect(() => {
    if (!pendingAudit?.approvalId) return;
    let stopped = false;
    let timer: number | undefined;
    // setTimeout 递归轮询：上一次请求完成后再排下一次，避免网络慢时请求叠加
    const poll = async () => {
      try {
        const approval = await pollApproval();
        if (stopped || !approval) return;
        if (approval.status === 'approved') message.success(`管理员已批准并执行：${approval.result || '执行完成'}`);
        if (approval.status === 'rejected') message.warning('管理员未批准，本次操作未执行');
        if (approval.status === 'failed') message.error(`管理员批准后执行失败：${approval.result || '未知错误'}`);
      } catch (e) {
        if (!stopped) setConfirmError(`查询审批状态失败：${errMsg(e)}`);
      } finally {
        if (!stopped) timer = window.setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [pendingAudit?.approvalId, message, pollApproval]);

  if (!pendingAudit) return null;
  const { audit } = pendingAudit;
  const isHigh = audit.riskLevel === 'high';
  const waitingApproval = Boolean(pendingAudit.approvalId);

  const handleExplain = async () => {
    setConfirmError(null);
    setExplainError(null);
    try {
      await loadExplain();
    } catch (e) {
      // 错误显示在弹窗内的预查询区域，比顶部 toast 更完整持久
      setExplainError(errMsg(e));
    }
  };

  const handleConfirm = async (confirmed: boolean) => {
    setConfirmError(null);
    setActiveAction(confirmed ? 'confirm' : 'reject');
    try {
      const result = await confirmAudit(confirmed);
      message.success(result.approvalId
        ? '已提交管理员审批，正在等待审批结果'
        : (confirmed ? '已确认执行' : '已拒绝执行'));
    } catch (e) {
      const msg = errMsg(e);
      // 凭证已失效（后端重启 / 超时 / 已消费）：确认与拒绝都无法进行，弹窗必须自动关闭，否则死锁
      if (msg.includes('凭证无效或已过期')) {
        message.warning('该确认凭证已失效，请重新执行 SQL 后再次审计');
        closeAuditModal();
        setActiveAction(null);
        return;
      }
      setConfirmError(msg);
    } finally {
      setActiveAction(null);
    }
  };

  const handleCancelApproval = async () => {
    setConfirmError(null);
    setActiveAction('cancel');
    try {
      await cancelApproval();
      message.success('已取消管理员审批申请');
    } catch (e) {
      setConfirmError(errMsg(e));
    } finally {
      setActiveAction(null);
    }
  };

  const explainColumns = (explain?.columns ?? []).map((c) => ({
    title: c,
    dataIndex: c,
    key: c,
    ellipsis: true,
    width: 160,
    render: (v: unknown) => (v === null ? <span style={{ color: '#bbb' }}>NULL</span> : String(v)),
  }));
  const explainData = (explain?.rows ?? []).map((r, i) => {
    const obj: Record<string, unknown> = { __key: i };
    (explain?.columns ?? []).forEach((c, ci) => (obj[c] = r[ci]));
    return obj;
  });

  return (
    <Modal
      open
      width={760}
      title={
        <Space>
          <RobotOutlined style={{ color: 'var(--brand-primary)' }} />
          AI SQL 安全审计
          <Tag color={RISK_COLOR[audit.riskLevel]} icon={<WarningOutlined />}>
            {RISK_LABEL[audit.riskLevel]}
          </Tag>
        </Space>
      }
      footer={
        <Space>
          {waitingApproval ? (
            <>
              <Button
                danger
                disabled={pendingAudit.approvalStatus === 'processing'}
                loading={confirming && activeAction === 'cancel'}
                onClick={() => void handleCancelApproval()}
                icon={<CloseCircleOutlined />}
              >
                {pendingAudit.approvalStatus === 'processing' ? '管理员已开始执行' : '取消审批申请'}
              </Button>
              <Button type="primary" loading disabled>
                {pendingAudit.approvalStatus === 'processing' ? '正在执行' : '等待管理员审批'}
              </Button>
            </>
          ) : (
            <>
              <Button
                disabled={confirming}
                onClick={() => void handleConfirm(false)}
                loading={confirming && activeAction === 'reject'}
                icon={<CloseCircleOutlined />}
              >
                拒绝执行
              </Button>
              <Button
                type="primary"
                danger={isHigh}
                disabled={confirming || (isHigh && !explain)}
                loading={confirming && activeAction === 'confirm'}
                onClick={() => void handleConfirm(true)}
                icon={<CheckCircleOutlined />}
              >
                {isHigh && !explain
                  ? '请先预查询执行计划'
                  : (isHigh && user?.role !== 'admin' ? '提交管理员审批' : '确认执行')}
              </Button>
            </>
          )}
        </Space>
      }
      closable={false}
      maskClosable={false}
      keyboard={false}
    >
      {waitingApproval && (
        <Alert
          style={{ marginBottom: 16 }}
          type={pendingAudit.approvalStatus === 'processing' ? 'info' : 'warning'}
          showIcon
          message={pendingAudit.approvalStatus === 'processing' ? '管理员已批准，正在执行 SQL' : '正在等待管理员审批'}
          description="系统会持续查询审批结果，批准后由服务端立即执行；你也可以在管理员处理前取消申请。"
        />
      )}

      {/* 分区一：审计语句 */}
      <section className="audit-section">
        <div className="audit-section-label">审计语句</div>
        <pre className="audit-sql">{pendingAudit.sql}</pre>
      </section>

      {/* 分区二：安全审计 */}
      <section className="audit-section">
        <div className="audit-section-label">安全审计</div>
        <div className="audit-verdict">
          <span className="audit-verdict-text">{audit.summary || '未给出结论'}</span>
          {audit.source === 'both' && <Tag>规则 + LLM</Tag>}
          {audit.source === 'rule' && <Tag>规则引擎</Tag>}
        </div>
        {audit.findings.length > 0 && (
          <div className="audit-findings">
            {audit.findings.map((f, i) => (
              <div className="audit-finding" key={i}>
                <Tag color={RISK_COLOR[f.severity]}>{RISK_LABEL[f.severity]}</Tag>
                <span>{f.message}</span>
              </div>
            ))}
          </div>
        )}
        {audit.suggestions.length > 0 && (
          <ul className="audit-suggestions">
            {audit.suggestions.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        )}
      </section>

      {/* 分区三：执行预检 */}
      <section className="audit-section">
        <div className="audit-section-label">执行预检（EXPLAIN，不真正执行）</div>

        <div className="audit-precheck">
          <div className="audit-precheck-bar">
            <Button icon={<ExperimentOutlined />} onClick={handleExplain} loading={explainLoading}>
              预查询执行计划
            </Button>
            {isHigh && !explain && !explainError && (
              <Typography.Text type="danger" style={{ fontSize: 12 }}>
                高危操作必须先预查询，确认执行计划后方可执行
              </Typography.Text>
            )}
            {explain?.estimatedRows != null && (
              <Typography.Text type="warning">预估影响 {explain.estimatedRows} 行</Typography.Text>
            )}
          </div>

          {explainError && (
            <Alert
              style={{ marginTop: 12 }}
              type="error"
              showIcon
              message="预查询失败"
              description={<div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{explainError}</div>}
            />
          )}

          {explainLoading ? (
            <div style={{ textAlign: 'center', padding: 20 }}>
              <Spin tip="正在生成执行计划..." />
            </div>
          ) : explain ? (
            <Table
              style={{ marginTop: 12 }}
              size="small"
              bordered
              columns={explainColumns}
              dataSource={explainData}
              rowKey="__key"
              pagination={false}
              scroll={{ x: 'max-content', y: 240 }}
            />
          ) : !explainError && (
            <Typography.Text type="secondary" style={{ display: 'block', marginTop: 10, fontSize: 12.5 }}>
              {isHigh
                ? '此语句为高危写操作，请先预查询执行计划。'
                : '点击上方按钮查看该语句的执行计划。'}
            </Typography.Text>
          )}
        </div>
      </section>

      {confirmError && <Alert style={{ marginTop: 12 }} type="error" message={confirmError} />}
    </Modal>
  );
}
