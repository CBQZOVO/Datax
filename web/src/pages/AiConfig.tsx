import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Typography,
} from 'antd';
import { RobotOutlined, SaveOutlined, ApiOutlined } from '@ant-design/icons';
import { api, errMsg } from '../api';

interface AiConfigView {
  baseURL: string;
  model: string;
  auditMode: 'strict' | 'warn' | 'off';
  timeoutMs: number;
  hasApiKey: boolean;
  apiKeyMasked: string;
}

const AUDIT_MODE_OPTIONS = [
  { value: 'strict', label: 'strict · 高危操作必须二次确认' },
  { value: 'warn', label: 'warn · 仅告警不拦截' },
  { value: 'off', label: 'off · 关闭 AI（仅内置规则）' },
];

export default function AiConfigPage() {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKeyMasked, setApiKeyMasked] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    api.get('/system/ai-config')
      .then(({ data }: { data: AiConfigView }) => {
        form.setFieldsValue({
          baseURL: data.baseURL,
          model: data.model,
          auditMode: data.auditMode,
          timeoutMs: data.timeoutMs,
        });
        setHasApiKey(data.hasApiKey);
        setApiKeyMasked(data.apiKeyMasked);
      })
      .catch((error) => message.error(errMsg(error)))
      .finally(() => setLoading(false));
  }, [form, message]);

  const save = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      setTestResult(null);
      // Key 留空 = 保持现有 Key 不变
      const payload: Record<string, unknown> = {
        baseURL: values.baseURL ?? '',
        model: values.model,
        auditMode: values.auditMode,
        timeoutMs: values.timeoutMs ?? 20000,
      };
      if (values.apiKey) payload.apiKey = values.apiKey;
      const { data } = await api.put('/system/ai-config', payload);
      form.setFieldsValue({ apiKey: undefined });
      setHasApiKey(data.hasApiKey);
      setApiKeyMasked(data.apiKeyMasked);
      message.success('AI 配置已保存，立即生效');
    } catch (error) {
      if ((error as { errorFields?: unknown }).errorFields) return;
      message.error(errMsg(error));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { data } = await api.post('/system/ai-config/test');
      setTestResult({ ok: Boolean(data.ok), message: `${data.message}（${data.latencyMs}ms）` });
    } catch (error) {
      setTestResult({ ok: false, message: errMsg(error) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="management-page">
      <header className="management-header">
        <div className="management-title">
          <RobotOutlined className="management-title-icon" />
          <div>
            <Typography.Title level={4}>AI 配置</Typography.Title>
            <Typography.Text type="secondary">
              配置 SQL 安全审计与错误诊断使用的模型服务（OpenAI 兼容协议），保存后立即生效，无需重启
            </Typography.Text>
          </div>
        </div>
        <Space>
          <Button icon={<ApiOutlined />} loading={testing} onClick={() => void test()}>测试连接</Button>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void save()}>保存配置</Button>
        </Space>
      </header>

      <main className="management-content">
        <Card className="management-card" style={{ maxWidth: 720 }} loading={loading}>
          {testResult && (
            <Alert
              style={{ marginBottom: 16 }}
              type={testResult.ok ? 'success' : 'error'}
              showIcon
              message={testResult.ok ? '测试通过' : '测试失败'}
              description={testResult.message}
            />
          )}

          <Form form={form} layout="vertical" initialValues={{ auditMode: 'strict', timeoutMs: 20000 }}>
            <Form.Item
              name="baseURL"
              label="服务地址（baseURL）"
              rules={[{ required: true, message: '请输入服务地址；留空表示关闭 AI' }]}
              extra="OpenAI 兼容协议地址，如 https://api.deepseek.com/v1"
            >
              <Input placeholder="https://api.deepseek.com/v1" allowClear autoComplete="off" />
            </Form.Item>

            <Form.Item
              name="apiKey"
              label="API Key"
              extra={hasApiKey
                ? `已配置（${apiKeyMasked}），留空保持不变；如需更换请直接输入新 Key`
                : '尚未配置，输入后保存即启用 AI'}
            >
              <Input.Password
                placeholder={hasApiKey ? `已配置（${apiKeyMasked}）` : '请输入 API Key'}
                autoComplete="new-password"
              />
            </Form.Item>

            <Form.Item
              name="model"
              label="模型名称"
              rules={[{ required: true, message: '请输入模型名称' }]}
              extra="如 deepseek-chat、GLM-5.2-W4A8 等，需为该服务支持的模型"
            >
              <Input placeholder="deepseek-chat" allowClear autoComplete="off" />
            </Form.Item>

            <Form.Item name="auditMode" label="审计模式" extra="控制 AI 审计结论对执行流程的拦截强度">
              <Select options={AUDIT_MODE_OPTIONS} />
            </Form.Item>

            <Form.Item
              name="timeoutMs"
              label="请求超时（毫秒）"
              extra="AI 审计与错误诊断的单次请求超时时间，最小 1000"
            >
              <InputNumber min={1000} max={120000} step={1000} style={{ width: 200 }} />
            </Form.Item>
          </Form>

          <Alert
            type="info"
            showIcon
            message="配置存储于服务端数据库，优先于 .env 中的同名变量；保存后对所有用户立即生效"
          />
        </Card>
      </main>
    </div>
  );
}
