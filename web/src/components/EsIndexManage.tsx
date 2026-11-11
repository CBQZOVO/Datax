import { useEffect, useState } from 'react';
import { App, Button, Input, Modal, Space, Tabs, Typography } from 'antd';
import { DeleteOutlined, FileAddOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { api, errMsg } from '../api';
import { useWorkspaceStore } from '../stores/workspace';

const DEFAULT_MAPPINGS = '{\n  "properties": {}\n}';

/** 解析 JSON 为对象；空串返回 null（视为「未填」），非法或非对象也返回 null */
function parseObject(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div style={{ marginTop: 12 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{label}</Typography.Text>
      <pre style={{
        background: '#f6f8fa', padding: 12, borderRadius: 6, maxHeight: 320, overflow: 'auto',
        fontSize: 12, lineHeight: 1.6, margin: '6px 0 0', fontFamily: 'monospace',
      }}>{JSON.stringify(value ?? {}, null, 2)}</pre>
    </div>
  );
}

interface Props {
  connectionId: number;
  /** 当前 tab 的索引/视图模式，作为默认回显 */
  defaultIndex: string;
  open: boolean;
  onClose: () => void;
  /** 建/删索引、加字段成功后触发（父组件刷新字段列表与结果） */
  onChanged?: () => void;
}

export default function EsIndexManage({ connectionId, defaultIndex, open, onClose, onChanged }: Props) {
  const { message, modal } = App.useApp();
  const refreshTree = useWorkspaceStore((s) => s.refreshTree);
  const [busy, setBusy] = useState(false);

  // 查看结构
  const [detailIndex, setDetailIndex] = useState('');
  const [detail, setDetail] = useState<{ settings: Record<string, unknown>; mappings: Record<string, unknown> | null } | null>(null);
  // 新建索引
  const [createName, setCreateName] = useState('');
  const [createMappings, setCreateMappings] = useState(DEFAULT_MAPPINGS);
  const [createSettings, setCreateSettings] = useState('');
  // 加字段
  const [mapIndex, setMapIndex] = useState('');
  const [mapJson, setMapJson] = useState(DEFAULT_MAPPINGS);
  // 删除索引
  const [delIndex, setDelIndex] = useState('');
  const [delConfirm, setDelConfirm] = useState('');

  useEffect(() => {
    if (!open) return;
    setDetailIndex(defaultIndex);
    setDetail(null);
    setCreateName('');
    setCreateMappings(DEFAULT_MAPPINGS);
    setCreateSettings('');
    setMapIndex(defaultIndex);
    setMapJson(DEFAULT_MAPPINGS);
    setDelIndex('');
    setDelConfirm('');
  }, [open, defaultIndex]);

  const loadDetail = async () => {
    if (!detailIndex.trim()) { message.warning('请输入索引名'); return; }
    setBusy(true);
    try {
      const { data } = await api.get('/es/detail', { params: { connectionId, index: detailIndex.trim() } });
      setDetail(data as { settings: Record<string, unknown>; mappings: Record<string, unknown> | null });
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const submitCreate = async () => {
    const index = createName.trim();
    if (!index) { message.warning('请输入索引名'); return; }
    const mappings = parseObject(createMappings);
    if (createMappings.trim() && !mappings) { message.warning('mappings JSON 格式错误'); return; }
    const settings = parseObject(createSettings);
    if (createSettings.trim() && !settings) { message.warning('settings JSON 格式错误'); return; }
    setBusy(true);
    try {
      await api.post('/es/create-index', {
        connectionId,
        index,
        ...(mappings ? { mappings } : {}),
        ...(settings ? { settings } : {}),
      });
      message.success(`索引 ${index} 已创建`);
      refreshTree();
      onChanged?.();
      onClose();
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const submitMapping = async () => {
    const index = mapIndex.trim();
    if (!index) { message.warning('请输入索引名'); return; }
    const mappings = parseObject(mapJson);
    if (!mappings) { message.warning('mappings JSON 格式错误'); return; }
    setBusy(true);
    try {
      await api.post('/es/put-mapping', { connectionId, index, mappings });
      message.success(`索引 ${index} 映射已更新`);
      onChanged?.();
      onClose();
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const submitDelete = () => {
    const index = delIndex.trim();
    if (!index) { message.warning('请输入索引名'); return; }
    if (delConfirm.trim() !== index) { message.warning('确认输入与索引名不一致'); return; }
    modal.confirm({
      title: `确认删除索引 ${index}？`,
      content: '索引内所有数据将永久删除、不可恢复。',
      okText: '确认删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        setBusy(true);
        try {
          await api.post('/es/delete-index', { connectionId, index });
          message.success(`索引 ${index} 已删除`);
          refreshTree();
          onChanged?.();
          onClose();
        } catch (e) {
          message.error(errMsg(e));
          return Promise.reject(e);
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const items = [
    {
      key: 'detail',
      label: '查看结构',
      children: (
        <div>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              placeholder="索引名（具体或通配，通配仅展示首个匹配）"
              value={detailIndex}
              onChange={(e) => setDetailIndex(e.target.value)}
              onPressEnter={() => void loadDetail()}
            />
            <Button icon={<SearchOutlined />} loading={busy} onClick={() => void loadDetail()}>查询</Button>
          </Space.Compact>
          {detail && (
            <>
              <JsonBlock label="Settings" value={detail.settings} />
              <JsonBlock label="Mappings" value={detail.mappings} />
            </>
          )}
        </div>
      ),
    },
    {
      key: 'create',
      label: '新建索引',
      children: (
        <div>
          <Input placeholder="索引名（小写，如 app-log）" value={createName} onChange={(e) => setCreateName(e.target.value)} />
          <Typography.Text type="secondary" style={{ display: 'block', margin: '10px 0 4px', fontSize: 12 }}>
            Mappings（可选，留空则动态映射）
          </Typography.Text>
          <Input.TextArea rows={8} value={createMappings} onChange={(e) => setCreateMappings(e.target.value)} />
          <Typography.Text type="secondary" style={{ display: 'block', margin: '10px 0 4px', fontSize: 12 }}>
            Settings（可选，如分片/副本）
          </Typography.Text>
          <Input.TextArea rows={4} value={createSettings} onChange={(e) => setCreateSettings(e.target.value)} placeholder='{"number_of_shards": 1, "number_of_replicas": 0}' />
          <Button type="primary" icon={<PlusOutlined />} loading={busy} style={{ marginTop: 12 }} onClick={() => void submitCreate()}>创建索引</Button>
        </div>
      ),
    },
    {
      key: 'mapping',
      label: '加字段',
      children: (
        <div>
          <Input placeholder="索引名（具体索引）" value={mapIndex} onChange={(e) => setMapIndex(e.target.value)} />
          <Typography.Text type="secondary" style={{ display: 'block', margin: '10px 0 4px', fontSize: 12 }}>
            Mappings（仅能新增字段，不能改已有字段类型）
          </Typography.Text>
          <Input.TextArea rows={8} value={mapJson} onChange={(e) => setMapJson(e.target.value)} />
          <Button type="primary" icon={<FileAddOutlined />} loading={busy} style={{ marginTop: 12 }} onClick={() => void submitMapping()}>更新映射</Button>
        </div>
      ),
    },
    {
      key: 'delete',
      label: '删除索引',
      children: (
        <div>
          <Typography.Text type="danger" style={{ fontSize: 13 }}>删除后索引内所有数据不可恢复，请谨慎操作。</Typography.Text>
          <Input placeholder="索引名（具体索引）" style={{ marginTop: 10 }} value={delIndex} onChange={(e) => setDelIndex(e.target.value)} />
          <Input placeholder="再次输入索引名确认" style={{ marginTop: 10 }} value={delConfirm} onChange={(e) => setDelConfirm(e.target.value)} />
          <Button
            danger
            icon={<DeleteOutlined />}
            loading={busy}
            style={{ marginTop: 12 }}
            disabled={!delIndex.trim() || delConfirm.trim() !== delIndex.trim()}
            onClick={submitDelete}
          >
            删除索引
          </Button>
        </div>
      ),
    },
  ];

  return (
    <Modal open={open} onCancel={onClose} title="ES 索引管理" footer={null} width={760} destroyOnClose>
      <Tabs items={items} />
    </Modal>
  );
}
