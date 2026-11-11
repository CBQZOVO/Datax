import { useEffect, useState } from 'react';
import { App, Button, Form, Input, InputNumber, Modal, Select } from 'antd';
import { api, errMsg, type Connection, type DbType } from '../api';
import { useWorkspaceStore } from '../stores/workspace';

const TYPE_OPTIONS = [
  { value: 'mysql', label: 'MySQL' },
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'elasticsearch', label: 'Elasticsearch' },
  { value: 'redis', label: 'Redis' },
];

const DEFAULT_PORTS: Record<DbType, number> = {
  mysql: 3306,
  postgres: 5432,
  elasticsearch: 9200,
  redis: 6379,
};

export default function ConnectionFormModal({
  open,
  onClose,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  editing: Connection | null;
}) {
  const [form] = Form.useForm();
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const { message } = App.useApp();
  const loadConnections = useWorkspaceStore((s) => s.loadConnections);

  useEffect(() => {
    if (open) {
      if (editing) {
        form.setFieldsValue({
          ...editing,
          password: '',
        });
      } else {
        form.resetFields();
        form.setFieldsValue({ type: 'mysql', host: '127.0.0.1', port: 3306, username: 'root' });
      }
    }
  }, [open, editing, form]);

  const type = Form.useWatch('type', form) as DbType | undefined;

  const handleTest = async () => {
    try {
      const values = await form.validateFields();
      setTesting(true);
      const { data } = await api.post(
        editing ? `/connections/${editing.id}/test` : '/connections/test',
        { ...values, id: editing?.id }
      );
      message[data.ok ? 'success' : 'error'](data.message);
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      if (editing) {
        await api.put(`/connections/${editing.id}`, values);
      } else {
        await api.post('/connections', values);
      }
      message.success('保存成功');
      await loadConnections();
      onClose();
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={editing ? '编辑数据源' : '新建数据源'}
      open={open}
      onCancel={onClose}
      width={520}
      footer={[
        <Button key="test" onClick={handleTest} loading={testing}>
          测试连接
        </Button>,
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Button key="save" type="primary" onClick={handleSave} loading={saving}>
          保存
        </Button>,
      ]}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
          <Input placeholder="例如：生产 MySQL" />
        </Form.Item>
        <Form.Item name="type" label="数据库类型" rules={[{ required: true }]}>
          <Select
            options={TYPE_OPTIONS}
            onChange={(v: DbType) => {
              form.setFieldValue('port', DEFAULT_PORTS[v]);
            }}
          />
        </Form.Item>
        <div style={{ display: 'flex', gap: 12 }}>
          <Form.Item name="host" label="主机" rules={[{ required: true, message: '请输入主机' }]} style={{ flex: 1 }}>
            <Input placeholder="127.0.0.1" />
          </Form.Item>
          <Form.Item name="port" label="端口" rules={[{ required: true }]} style={{ width: 120 }}>
            <InputNumber style={{ width: '100%' }} min={1} max={65535} />
          </Form.Item>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <Form.Item
            name="username"
            label={type === 'redis' ? '用户名（可选，ACL）' : '用户名'}
            rules={type === 'redis' ? [] : [{ required: true, message: '请输入用户名' }]}
            style={{ flex: 1 }}
          >
            <Input placeholder={type === 'redis' ? '仅配置了 ACL 用户时填写' : ''} />
          </Form.Item>
          <Form.Item name="password" label="密码" style={{ flex: 1 }}>
            <Input.Password placeholder={editing ? '留空表示不修改' : ''} />
          </Form.Item>
        </div>
        <Form.Item
          name="database"
          label={type === 'postgres' ? '默认数据库' : type === 'redis' ? '默认 DB 编号（0-15，可选）' : '默认数据库（可选）'}
        >
          <Input placeholder={type === 'redis' ? '默认 0' : '可选，例如：mydb'} />
        </Form.Item>
        {type === 'postgres' && (
          <Form.Item name="schema" label="默认 Schema">
            <Input placeholder="public" />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}
