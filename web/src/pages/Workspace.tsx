import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  App,
  Button,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import {
  CopyOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  SettingOutlined,
  TableOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import ConnectionTree from '../components/ConnectionTree';
import ConnectionFormModal from '../components/ConnectionFormModal';
import ChangePasswordModal from '../components/ChangePasswordModal';
import AuditConfirmModal from '../components/AuditConfirmModal';
import AppHeader from '../components/AppHeader';
import SqlEditor from '../components/SqlEditor';
import ResultTable from '../components/ResultTable';
import EsIndexManage from '../components/EsIndexManage';
import { useWorkspaceStore, type Tab } from '../stores/workspace';
import { useAuthStore } from '../stores/auth';
import type { ColumnsType } from 'antd/es/table';
import { api, errMsg, type ColumnInfo, type Connection, type QueryResult } from '../api';

/* 侧栏宽度：可拖拽调整，localStorage 记忆偏好 */
const SIDEBAR_WIDTH_KEY = 'datax.sidebarWidth';
const SIDEBAR_MIN = 260;
const SIDEBAR_MAX = 640;
const SIDEBAR_DEFAULT = 400;

function readSidebarWidth(): number {
  const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX ? saved : SIDEBAR_DEFAULT;
}

/** ES 时间范围快捷档：不限 / 相对时间档 / 今天（本地零点起），自定义区间用旁边的日期选择器 */
const ES_TIME_PRESETS = [
  { label: '不限', value: 'all' },
  { label: '2分', value: '2m' },
  { label: '15分', value: '15m' },
  { label: '1时', value: '1h' },
  { label: '6时', value: '6h' },
  { label: '12时', value: '12h' },
  { label: '24时', value: '24h' },
  { label: '7天', value: '7d' },
  { label: '30天', value: '30d' },
  { label: '今天', value: 'today' },
] as const;

/** 各相对档对应的毫秒跨度 */
const ES_PRESET_SPANS: Record<string, number> = {
  '2m': 2 * 60_000,
  '15m': 15 * 60_000,
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '12h': 12 * 3_600_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
  '30d': 30 * 24 * 3_600_000,
};

function esRangeStart(preset: string): string | undefined {
  if (preset === 'all') return undefined;
  if (preset === 'today') return dayjs().startOf('day').toISOString();
  const span = ES_PRESET_SPANS[preset];
  return span ? dayjs(Date.now() - span).toISOString() : undefined;
}

/** DSL 模式的初始请求体（POST /{index}/_search 的 body） */
const DEFAULT_ES_DSL = `{
  "size": 100,
  "query": { "match_all": {} }
}`;

interface EsCond {
  field: string;
  value: string;
}

/** 把「字段+值」条件行编译成键值检索语法 token：值含空格/引号/冒号或以 - 开头时用引号包裹（引号内 \" 转义） */
function condToToken(cond: EsCond): string {
  const v = cond.value;
  const needsQuote = /\s|"|:/.test(v) || v.startsWith('-');
  return needsQuote ? `${cond.field}:"${v.replace(/"/g, '\\"')}"` : `${cond.field}:${v}`;
}

/** ES 索引浏览面板：多条件（字段+包含值，AND）+ 时间范围快捷档 + 条数档位，按 @timestamp 倒序展示最新 N 条 */
function EsQueryPanel({ tab }: { tab: Tab }) {
  const runEsSearch = useWorkspaceStore((s) => s.runEsSearch);
  const runEsDsl = useWorkspaceStore((s) => s.runEsDsl);
  const { message, modal } = App.useApp();
  const user = useAuthStore((s) => s.user);
  const [conds, setConds] = useState<EsCond[]>([{ field: 'log', value: '' }]);
  const [timeRange, setTimeRange] = useState('all');
  const [esSize, setEsSize] = useState(100);
  const [allFields, setAllFields] = useState<string[]>([]);
  const [selFields, setSelFields] = useState<string[]>([]);
  const [mode, setMode] = useState<'form' | 'dsl'>('form');
  const [dslText, setDslText] = useState(DEFAULT_ES_DSL);
  // 按字段删除
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [delField, setDelField] = useState('log');
  const [delValue, setDelValue] = useState('');
  const [delStart, setDelStart] = useState('');
  const [delEnd, setDelEnd] = useState('');
  const [delMax, setDelMax] = useState(1000);
  const [delCount, setDelCount] = useState<number | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  // 行详情（点击结果行）
  const [rowDetail, setRowDetail] = useState<Record<string, unknown> | null>(null);
  // 按 _id 编辑文档（原文 JSON）
  const [editOpen, setEditOpen] = useState(false);
  const [editText, setEditText] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  // 集群主版本号（写端点据此自适应，toolbar 展示）
  const [esMajor, setEsMajor] = useState<number | null>(null);
  // 索引管理弹窗
  const [esManageOpen, setEsManageOpen] = useState(false);
  // 字段列表重载信号（加字段后自增触发重新加载）
  const [fieldsReload, setFieldsReload] = useState(0);
  // 自定义时间区间：选中后优先于快捷档，清空后回落快捷档
  const [customRange, setCustomRange] = useState<[Dayjs, Dayjs] | null>(null);

  const fieldOptions = (allFields.length ? allFields : ['log']).map((f) => ({ value: f, label: f }));
  const activeConds = () =>
    conds.filter((c) => c.value.trim()).map((c) => ({ field: c.field, value: c.value.trim() }));

  /** 组装搜索参数：显式传入的 fields/size/range 优先（setState 异步，不能依赖闭包里的新值），否则用自定义区间，最后回落时间快捷档 */
  const buildOpts = (extra: { fields?: string[]; size?: number; range?: [Dayjs, Dayjs] | null; presetStart?: string } = {}) => {
    const range = extra.range !== undefined ? extra.range : customRange;
    const conds = activeConds();
    return {
      fields: extra.fields ?? selFields,
      query: conds.length ? conds.map(condToToken).join(' ') : undefined,
      size: extra.size ?? esSize,
      ...(range
        ? { start: range[0].toISOString(), end: range[1].toISOString() }
        : { start: extra.presetStart ?? esRangeStart(timeRange) }),
    };
  };

  // 打开 tab 即按默认档（15 分 · 100 条）加载
  useEffect(() => {
    void runEsSearch(tab.key, buildOpts());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.key]);

  // 索引切换后重新加载字段列表，并清空已选字段（空 = 显示全部字段）；加字段后由 fieldsReload 触发重载
  useEffect(() => {
    let active = true;
    api.get('/es/fields', { params: { connectionId: tab.connectionId, index: tab.database } })
      .then(({ data }) => {
        if (!active) return;
        const fs = (data.fields ?? []) as string[];
        setAllFields(fs);
        setSelFields([]);
        // 日志索引仍默认查 log；业务索引自动选第一个字段
        const preferred = fs.includes('log') ? 'log' : (fs[0] ?? 'log');
        setConds((prev) => prev.map((c, i) => (i === 0 ? { ...c, field: preferred } : c)));
      })
      .catch(() => active && setAllFields([]));
    return () => { active = false; };
  }, [tab.connectionId, tab.database, fieldsReload]);

  // 拉取集群主版本号（toolbar 展示）
  useEffect(() => {
    let active = true;
    api.get('/es/version', { params: { connectionId: tab.connectionId } })
      .then(({ data }) => { if (active) setEsMajor((data.version as number) ?? null); })
      .catch(() => active && setEsMajor(null));
    return () => { active = false; };
  }, [tab.connectionId]);

  /** 删除后按当前条件重新查询 */
  const reload = () => void runEsSearch(tab.key, buildOpts());

  const previewDelete = async () => {
    if (!delValue.trim()) {
      message.warning('请输入要匹配的值');
      return;
    }
    setDelBusy(true);
    try {
      const { data } = await api.post('/es/delete-by-query/preview', {
        connectionId: tab.connectionId,
        index: tab.database,
        field: delField,
        value: delValue,
        start: delStart || undefined,
        end: delEnd || undefined,
      });
      setDelCount(data.count as number);
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setDelBusy(false);
    }
  };

  const executeDelete = () => {
    if (delCount == null || delCount === 0) return;
    modal.confirm({
      title: `确认删除匹配的 ${delCount} 条文档？`,
      content: `索引/视图：${tab.database} · 条件：${delField} 包含 ${delValue}。删除后不可恢复。`,
      okText: '确认删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        setDelBusy(true);
        try {
          const { data } = await api.post('/es/delete-by-query', {
            connectionId: tab.connectionId,
            index: tab.database,
            field: delField,
            value: delValue,
            start: delStart || undefined,
            end: delEnd || undefined,
            maxDocs: delMax,
          });
          message.success(`已删除 ${data.deleted} 条`);
          setDeleteOpen(false);
          setDelCount(null);
          setDelValue('');
          reload();
        } catch (e) {
          message.error(errMsg(e));
        } finally {
          setDelBusy(false);
        }
      },
    });
  };

  const deleteRow = (record: Record<string, unknown>) => {
    const id = record.__id;
    const index = record.__index;
    if (typeof id !== 'string' || typeof index !== 'string') {
      message.warning('该行缺少文档定位信息');
      return;
    }
    modal.confirm({
      title: '删除这条文档？',
      content: `_id: ${id} · 索引: ${index}。删除后不可恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const { data } = await api.post('/es/delete-by-id', {
            connectionId: tab.connectionId,
            index,
            id,
          });
          message.success(data.deleted > 0 ? '已删除' : '文档不存在');
          setRowDetail(null);
          reload();
        } catch (e) {
          message.error(errMsg(e));
        }
      },
    });
  };

  /** 打开编辑：取文档原文（详情里展示的是展平视图，不能直接拿来回写） */
  const openEdit = async () => {
    const detail = rowDetail;
    const id = typeof detail?.__id === 'string' ? detail.__id : null;
    const index = typeof detail?.__index === 'string' ? detail.__index : null;
    if (!id || !index) {
      message.warning('该行缺少文档定位信息');
      return;
    }
    setEditBusy(true);
    try {
      const { data } = await api.get('/es/doc', { params: { connectionId: tab.connectionId, index, id } });
      if (!data.doc) {
        message.warning('文档不存在（可能已被删除）');
        return;
      }
      setEditText(JSON.stringify(data.doc.source, null, 2));
      setEditOpen(true);
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setEditBusy(false);
    }
  };

  /** 保存编辑：doc 合并写（未提及字段保持原值），二次确认后提交 */
  const saveEdit = () => {
    const detail = rowDetail;
    const id = typeof detail?.__id === 'string' ? detail.__id : null;
    const index = typeof detail?.__index === 'string' ? detail.__index : null;
    if (!id || !index) return;
    let doc: unknown;
    try {
      doc = JSON.parse(editText);
    } catch {
      message.warning('JSON 格式错误');
      return;
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      message.warning('JSON 须为对象（字段 → 值）');
      return;
    }
    modal.confirm({
      title: '确认更新这条文档？',
      content: `_id: ${id} · 索引: ${index}。按字段合并写入，未在 JSON 中出现的字段保持原值。`,
      okText: '确认更新',
      onOk: async () => {
        setEditBusy(true);
        try {
          const { data } = await api.post('/es/update-by-id', { connectionId: tab.connectionId, index, id, doc });
          message.success(data.updated ? '已更新' : '文档未变更');
          setEditOpen(false);
          setRowDetail(null);
          reload();
        } catch (e) {
          message.error(errMsg(e));
          return Promise.reject(e);
        } finally {
          setEditBusy(false);
        }
      },
    });
  };

  const patchCond = (i: number, patch: Partial<EsCond>) =>
    setConds((prev) => prev.map((c, ci) => (ci === i ? { ...c, ...patch } : c)));

  return (
    <div className="query-panel">
      <div className="query-panel__toolbar">
        <div className="query-panel__context">
          <Tag color="blue" bordered={false}>elasticsearch</Tag>
          <Typography.Text strong>{tab.connectionName}</Typography.Text>
          <Typography.Text type="secondary">/ {tab.database}</Typography.Text>
          {esMajor != null && <Tag bordered={false}>v{esMajor}.x</Tag>}
        </div>
        <Space size={8}>
          {user?.role === 'admin' && (
            <Button icon={<SettingOutlined />} onClick={() => setEsManageOpen(true)}>索引管理</Button>
          )}
          {user?.role === 'admin' && (
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={() => { setDelCount(null); setDeleteOpen(true); }}
            >
              按字段删除
            </Button>
          )}
          <Segmented
            size="small"
            options={[{ label: '条件', value: 'form' }, { label: 'DSL', value: 'dsl' }]}
            value={mode}
            onChange={(v) => setMode(v as 'form' | 'dsl')}
          />
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            loading={tab.loading}
            onClick={() => mode === 'dsl'
              ? void runEsDsl(tab.key, dslText)
              : void runEsSearch(tab.key, buildOpts())}
            className="query-panel__run-btn"
          >
            搜索
          </Button>
        </Space>
      </div>
      <div className="query-panel__esbar" style={mode === 'dsl' ? { display: 'none' } : undefined}>
        {conds.map((cond, i) => (
          <Space.Compact key={i} className="query-panel__escond">
            <Select
              value={cond.field}
              options={fieldOptions}
              popupMatchSelectWidth={false}
              className="query-panel__esqfield"
              onChange={(v) => patchCond(i, { field: v })}
            />
            <Input
              allowClear
              placeholder="值（支持 * 通配 / >=500 范围）"
              value={cond.value}
              onChange={(e) => patchCond(i, { value: e.target.value })}
              onPressEnter={() => void runEsSearch(tab.key, buildOpts())}
            />
            <Button
              icon={<DeleteOutlined />}
              disabled={conds.length <= 1}
              onClick={() => setConds((prev) => prev.filter((_, ci) => ci !== i))}
            />
          </Space.Compact>
        ))}
        <Button
          icon={<PlusOutlined />}
          disabled={conds.length >= 5}
          onClick={() =>
            setConds((prev) => [...prev, { field: prev[prev.length - 1]?.field ?? 'log', value: '' }])
          }
        >
          条件
        </Button>
        <DatePicker.RangePicker
          showTime
          allowClear
          value={customRange}
          placeholder={['开始时间', '结束时间']}
          onChange={(v) => {
            const range = v && v[0] && v[1] ? ([v[0], v[1]] as [Dayjs, Dayjs]) : null;
            setCustomRange(range);
            void runEsSearch(tab.key, buildOpts({ range }));
          }}
        />
        <Segmented
          options={[...ES_TIME_PRESETS]}
          value={customRange ? '' : timeRange}
          onChange={(v) => {
            setTimeRange(v);
            setCustomRange(null);
            void runEsSearch(tab.key, buildOpts({ range: null, presetStart: esRangeStart(v) }));
          }}
        />
        <Select
          mode="multiple"
          allowClear
          placeholder="显示全部字段"
          value={selFields}
          options={allFields.map((f) => ({ value: f, label: f }))}
          maxTagCount="responsive"
          className="query-panel__esfield"
          onChange={(v) => {
            setSelFields(v);
            void runEsSearch(tab.key, buildOpts({ fields: v }));
          }}
        />
      </div>
      {mode === 'dsl' && (
        <div className="query-panel__dsibar">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            POST /{tab.database}/_search · 请求体（原生 ES DSL：query / sort / size / _source / aggs 均支持；size 上限 2000）
          </Typography.Text>
          <Input.TextArea
            value={dslText}
            onChange={(e) => setDslText(e.target.value)}
            rows={9}
            className="query-panel__dsiinput"
            spellCheck={false}
          />
        </div>
      )}
      {tab.error && <div className="query-panel__error">{tab.error}</div>}
      <div className="query-panel__result">
        {/* 分页器的「条/页」即拉取条数：选多少条就按该 size 重新搜索（对齐 Kibana Discover 的直觉） */}
        <ResultTable
          result={tab.result}
          defaultPageSize={esSize}
          allowWrap
          onRowClick={setRowDetail}
          onPageSizeChange={(ps) => {
            setEsSize(ps);
            void runEsSearch(tab.key, buildOpts({ size: ps }));
          }}
        />
      </div>

      <Modal
        title="按字段删除 ES 文档"
        open={deleteOpen}
        onCancel={() => setDeleteOpen(false)}
        footer={null}
        width={560}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            在视图 {tab.database} 中删除「字段包含指定值」的文档；可加 @timestamp 时间范围收窄，单次上限 {delMax} 条。
          </Typography.Text>
          <div>
            <Typography.Text>字段</Typography.Text>
            <Input value={delField} onChange={(e) => { setDelField(e.target.value); setDelCount(null); }} placeholder="如 log、message、traceId" />
          </div>
          <div>
            <Typography.Text>值（包含匹配）</Typography.Text>
            <Input value={delValue} onChange={(e) => { setDelValue(e.target.value); setDelCount(null); }} placeholder="必填，禁止无条件删除" />
          </div>
          <Space style={{ width: '100%' }}>
            <Input placeholder="开始时间 ISO（可选）" value={delStart} onChange={(e) => { setDelStart(e.target.value); setDelCount(null); }} />
            <Input placeholder="结束时间 ISO（可选）" value={delEnd} onChange={(e) => { setDelEnd(e.target.value); setDelCount(null); }} />
          </Space>
          <Space>
            <Typography.Text>单次上限</Typography.Text>
            <InputNumber min={1} max={10000} value={delMax} onChange={(v) => { setDelMax(v ?? 1000); setDelCount(null); }} />
          </Space>
          <Space>
            <Button loading={delBusy} onClick={() => void previewDelete()}>预览匹配数</Button>
            <Button danger type="primary" disabled={delCount == null || delCount === 0 || delCount > delMax} onClick={executeDelete}>
              确认删除
            </Button>
          </Space>
          {delCount !== null && (
            <Alert
              type={delCount > delMax ? 'error' : 'warning'}
              showIcon
              message={`匹配 ${delCount} 条${delCount > delMax ? `（超过上限 ${delMax}，请缩小条件或调大上限）` : ''}`}
            />
          )}
        </Space>
      </Modal>

      <Modal
        title="文档详情"
        open={!!rowDetail}
        onCancel={() => setRowDetail(null)}
        width={760}
        footer={
          <Space>
            {user?.role === 'admin' && rowDetail && (
              <Button icon={<EditOutlined />} loading={editBusy} onClick={() => void openEdit()}>编辑文档</Button>
            )}
            {user?.role === 'admin' && rowDetail && (
              <Button danger icon={<DeleteOutlined />} onClick={() => deleteRow(rowDetail)}>删除此行</Button>
            )}
            <Button onClick={() => setRowDetail(null)}>关闭</Button>
          </Space>
        }
      >
        {rowDetail && (
          <>
            <pre className="redis-key-detail__value">
              {formatJsonValue(JSON.stringify(
                Object.fromEntries(Object.entries(rowDetail).filter(([k]) => !k.startsWith('__'))),
                null,
                2
              ))}
            </pre>
            <Typography.Text type="secondary">
              _id: {String(rowDetail.__id ?? '')} · _index: {String(rowDetail.__index ?? '')}
            </Typography.Text>
          </>
        )}
      </Modal>

      <Modal
        title="编辑文档（按字段合并写）"
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        width={760}
        footer={
          <Space>
            <Button onClick={() => setEditOpen(false)}>取消</Button>
            <Button type="primary" loading={editBusy} onClick={saveEdit}>保存更新</Button>
          </Space>
        }
      >
        <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
          只提交下面 JSON 里出现的字段（部分更新），其余字段保持原值。保存前会再次确认。
        </Typography.Text>
        <Input.TextArea
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          rows={16}
          className="redis-key-detail__editor"
        />
      </Modal>

      <EsIndexManage
        connectionId={tab.connectionId}
        defaultIndex={tab.database}
        open={esManageOpen}
        onClose={() => setEsManageOpen(false)}
        onChanged={() => {
          setFieldsReload((n) => n + 1);
          reload();
        }}
      />
    </div>
  );
}

/** 按 key 模式生成 SCAN 命令（模式加引号，避免含空格/特殊字符被拆成多个参数） */
function scanCommand(pattern: string): string {
  return `SCAN 0 MATCH "${pattern || '*'}" COUNT 100`;
}

/** 值是 JSON（含被序列化成字符串字面量的"双重编码"JSON）时缩进格式化；否则原样返回 */
function formatJsonValue(v: string | null): string {
  if (v == null) return '(nil)';
  let text = v;
  // 值本身是 JSON 字符串字面量（形如 "{\"companyId\":\"...\"}"）时先解一层
  try {
    const first = JSON.parse(text);
    if (typeof first === 'string') text = first;
  } catch {
    // 不是 JSON 字符串字面量，继续按普通文本处理
  }
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      // 非合法 JSON 对象/数组，原样展示
    }
  }
  return text;
}

/** 新增 Key 时各类型的值填写提示 */
const REDIS_VALUE_HINT: Record<string, string> = {
  string: '直接输入值（支持 JSON 文本）',
  hash: '每行一条：字段 值\n例如：\nname 张三\nage 18',
  list: '每行一个元素，依次追加到列表',
  set: '每行一个成员',
  zset: '每行一条：分数 成员\n例如：\n100 user:1\n200 user:2',
};

/** 值预览：标量用代码块（JSON 自动格式化）；多列（hash/list/set/zset）用表格，单元格同样格式化 */
function renderInspectionValue(result: QueryResult) {
  const scalar = result.columns.length === 1 && result.columns[0] === '结果';
  if (scalar) {
    return <pre className="redis-key-detail__value">{formatJsonValue(result.rows[0]?.[0] ?? null)}</pre>;
  }
  return (
    <Table
      size="small"
      bordered
      rowKey="__i"
      pagination={false}
      scroll={{ y: 360 }}
      columns={result.columns.map((c) => ({
        title: c,
        dataIndex: c,
        key: c,
        render: (v: unknown) => (
          <pre className="redis-key-detail__cell">{formatJsonValue(v == null ? null : String(v))}</pre>
        ),
      }))}
      dataSource={result.rows.map((row, i) => ({
        __i: i,
        ...Object.fromEntries(result.columns.map((c, ci) => [c, row[ci] ?? null])),
      }))}
    />
  );
}

/** Redis 命令面板：key 模式筛选 + 点击 key 查看任意类型的值 */
function RedisQueryPanel({ tab }: { tab: Tab }) {
  const runRedisCommand = useWorkspaceStore((s) => s.runRedisCommand);
  const { message, modal } = App.useApp();
  const [command, setCommand] = useState(tab.sql || '');
  const [pattern, setPattern] = useState('*');
  const [inspection, setInspection] = useState<{ key: string; type: string; result: QueryResult } | null>(null);
  const initedRef = useRef(false);
  // 新增 Key 弹窗
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newType, setNewType] = useState('string');
  const [form] = Form.useForm();

  const run = (cmd = command) => {
    if (!cmd.trim()) {
      message.warning('请输入 Redis 命令');
      return;
    }
    void runRedisCommand(tab.key, cmd);
  };

  // 首次打开面板：自动 SCAN 预览当前 db 的 key，避免「点开了却什么都没有」
  useEffect(() => {
    if (initedRef.current) return;
    initedRef.current = true;
    if (!tab.result && !command.trim()) {
      const initial = scanCommand('*');
      setCommand(initial);
      void runRedisCommand(tab.key, initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.key]);

  /** 按当前筛选模式重新扫描（新增/删除后刷新列表） */
  const reload = () => {
    const next = scanCommand(pattern);
    setCommand(next);
    void runRedisCommand(tab.key, next);
  };

  const applyPattern = () => reload();

  const createKey = async () => {
    try {
      const values = await form.validateFields();
      setCreating(true);
      await api.post('/redis/key', {
        connectionId: tab.connectionId,
        database: tab.database,
        key: values.key,
        type: values.type,
        value: values.value ?? '',
        ttl: values.ttl || undefined,
      });
      message.success('Key 已创建');
      setCreateOpen(false);
      form.resetFields();
      setNewType('string');
      reload();
    } catch (e) {
      if ((e as { errorFields?: unknown }).errorFields) return;
      message.error(errMsg(e));
    } finally {
      setCreating(false);
    }
  };

  const deleteKey = (key: string) => {
    modal.confirm({
      title: `删除 Key「${key}」？`,
      content: '删除后无法恢复',
      okText: '删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.post('/redis/key/delete', {
            connectionId: tab.connectionId,
            database: tab.database,
            key,
          });
          message.success('已删除');
          setInspection(null);
          reload();
        } catch (e) {
          message.error(errMsg(e));
        }
      },
    });
  };

  const copyInspectionValue = async () => {
    if (!inspection) return;
    const r = inspection.result;
    const text = r.columns.length === 1 && r.columns[0] === '结果'
      ? formatJsonValue(r.rows[0]?.[0] ?? null)
      : r.rows
          .map((row) => JSON.stringify(Object.fromEntries(r.columns.map((c, ci) => [c, row[ci] ?? null]))))
          .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      message.success('已复制');
    } catch {
      message.error('复制失败：浏览器剪贴板不可用');
    }
  };

  /** 点击结果行里的 key：后端自动探测类型并取回值 */
  const inspect = async (record: Record<string, unknown>) => {
    const key = record['key'];
    if (typeof key !== 'string' || !key) return;
    try {
      const { data } = await api.post('/redis/inspect', {
        connectionId: tab.connectionId,
        database: tab.database,
        key,
      });
      setInspection({ key, type: data.type as string, result: data.result as QueryResult });
    } catch (e) {
      message.error(errMsg(e));
    }
  };

  return (
    <div className="query-panel">
      <div className="query-panel__toolbar">
        <div className="query-panel__context">
          <Tag color="red" bordered={false}>redis</Tag>
          <Typography.Text strong>{tab.connectionName}</Typography.Text>
          <Typography.Text type="secondary">/ {tab.database}</Typography.Text>
        </div>
        <Space size={8}>
          <Button icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新增 Key</Button>
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            loading={tab.loading}
            onClick={() => run()}
            className="query-panel__run-btn"
          >
            执行 <span className="query-panel__kbd">⌘⏎</span>
          </Button>
        </Space>
      </div>
      <div className="query-panel__redisbar">
        <div className="query-panel__redisfilter">
          <Typography.Text type="secondary" style={{ flexShrink: 0, fontSize: 12 }}>Key 筛选</Typography.Text>
          <Input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            onPressEnter={applyPattern}
            placeholder="如 user:*、order:*，留空为全部"
            allowClear
            className="query-panel__redisinput"
          />
          <Button onClick={applyPattern} loading={tab.loading}>筛选</Button>
        </div>
        <Input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onPressEnter={() => run()}
          placeholder="输入 Redis 命令，如 GET user:1、HGETALL user:1、SCAN 0 MATCH log:* COUNT 100、INFO"
          allowClear
          className="query-panel__redisinput"
        />
      </div>
      {tab.error && <div className="query-panel__error">{tab.error}</div>}
      <div className="query-panel__result">
        <ResultTable result={tab.result} onRowClick={inspect} />
      </div>

      <Modal
        open={!!inspection}
        title={<Space><span>Key 详情</span>{inspection && <Tag color="red">{inspection.type}</Tag>}</Space>}
        width={820}
        onCancel={() => setInspection(null)}
        footer={
          <Space>
            {inspection && (
              <Button danger icon={<DeleteOutlined />} onClick={() => deleteKey(inspection.key)}>删除</Button>
            )}
            <Button icon={<CopyOutlined />} onClick={() => void copyInspectionValue()}>复制值</Button>
            <Button onClick={() => setInspection(null)}>关闭</Button>
          </Space>
        }
      >
        {inspection && (
          <>
            <div className="redis-key-detail__label">KEY</div>
            <pre className="redis-key-detail__key">{inspection.key}</pre>
            <div className="redis-key-detail__label">VALUE</div>
            {renderInspectionValue(inspection.result)}
          </>
        )}
      </Modal>

      <Modal
        title="新增 Key"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void createKey()}
        confirmLoading={creating}
        okText="创建"
        width={560}
      >
        <Form form={form} layout="vertical" initialValues={{ type: 'string' }}>
          <Form.Item name="key" label="Key" rules={[{ required: true, message: '请输入 Key' }]}>
            <Input placeholder="如 user:1001" />
          </Form.Item>
          <Form.Item name="type" label="类型" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'string', label: 'String' },
                { value: 'hash', label: 'Hash' },
                { value: 'list', label: 'List' },
                { value: 'set', label: 'Set' },
                { value: 'zset', label: 'Sorted Set' },
              ]}
              onChange={(v) => setNewType(v)}
            />
          </Form.Item>
          <Form.Item name="value" label="值">
            <Input.TextArea rows={6} placeholder={REDIS_VALUE_HINT[newType]} spellCheck={false} />
          </Form.Item>
          <Form.Item name="ttl" label="过期时间（秒，可选，留空 = 永不过期）">
            <InputNumber min={0} style={{ width: '100%' }} placeholder="例如 3600" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

function QueryPanel({ tab }: { tab: Tab }) {
  // 选择器订阅：store 里任一 tab 变化不再触发本面板重渲染（函数引用稳定）
  const updateTab = useWorkspaceStore((s) => s.updateTab);
  const runQuery = useWorkspaceStore((s) => s.runQuery);
  const { message } = App.useApp();
  const conn = useWorkspaceStore((s) => s.connections.find((c) => c.id === tab.connectionId));
  // 筛选基线：手动执行时的 SQL；列筛选始终基于它生成，避免在筛选 SQL 上反复包裹
  const baseSqlRef = useRef<string | null>(null);
  // 筛选 SQL 生成中：防重 + 输入框 loading 指示
  const [filtering, setFiltering] = useState(false);

  const runFromEditor = (sql: string) => {
    baseSqlRef.current = sql.trim() ? sql : null;
    void runQuery(tab.key, sql);
  };

  /** 列筛选/排序：把基线 SQL + 非空条件 + 排序交后端生成新 SQL，再走正常执行链路；条件与排序全空 = 回到基线 */
  const handleQuery = async ({ filters, sort }: {
    filters: Record<string, string>;
    sort: { column: string; order: 'asc' | 'desc' } | null;
  }) => {
    if (filtering) return; // 生成中防重，连按回车只触发一次
    const base = baseSqlRef.current ?? tab.sql;
    if (!base.trim()) {
      message.warning('请先执行一条查询');
      return;
    }
    const entries = Object.entries(filters);
    if (entries.length === 0 && !sort) {
      void runQuery(tab.key, base);
      return;
    }
    setFiltering(true);
    try {
      const { data } = await api.post('/query/filter-sql', {
        connectionId: tab.connectionId,
        database: tab.database,
        sql: base,
        filters: entries.map(([column, value]) => ({ column, value })),
        sort: sort ?? undefined,
      });
      void runQuery(tab.key, data.sql as string);
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setFiltering(false);
    }
  };

  // 打开表后加载字段注释，供结果列头直接展示（无表的查询 tab 不加载）
  useEffect(() => {
    if (!tab.table || tab.columnComments) return;
    let active = true;
    const params: Record<string, string> = { database: tab.database, table: tab.table };
    if (tab.schema) params.schema = tab.schema;
    api.get(`/metadata/${tab.connectionId}/columns`, { params })
      .then(({ data }) => {
        if (!active) return;
        const map: Record<string, string> = {};
        for (const col of (data.columns ?? []) as { name: string; comment?: string | null }[]) {
          if (col.comment) map[col.name.toLowerCase()] = col.comment;
        }
        updateTab(tab.key, { columnComments: map });
      })
      .catch(() => {});
    return () => { active = false; };
  }, [tab.connectionId, tab.database, tab.schema, tab.table, tab.columnComments, tab.key, updateTab]);

  return (
    <div className="query-panel">
      <div className="query-panel__toolbar">
        <div className="query-panel__context">
          <Tag color="blue" bordered={false}>{conn?.type}</Tag>
          <Typography.Text strong>{tab.connectionName}</Typography.Text>
          {tab.database && <Typography.Text type="secondary">/ {tab.database}</Typography.Text>}
          {tab.table && <Tag bordered={false} icon={<TableOutlined />}>{tab.table}</Tag>}
          {tab.tableComment && (
            <Typography.Text type="secondary" className="query-panel__table-comment">{tab.tableComment}</Typography.Text>
          )}
        </div>
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          loading={tab.loading}
          onClick={() => runFromEditor(tab.sql)}
          className="query-panel__run-btn"
        >
          执行 <span className="query-panel__kbd">⌘⏎</span>
        </Button>
      </div>
      <div className="sql-editor-wrap">
        <SqlEditor
          value={tab.sql}
          onChange={(v) => updateTab(tab.key, { sql: v })}
          dbType={conn?.type ?? 'mysql'}
          onRun={() => runFromEditor(tab.sql)}
        />
      </div>
      {tab.error && <div className="query-panel__error">{tab.error}</div>}
      <div className="query-panel__result">
        <ResultTable
          result={tab.result}
          columnComments={tab.columnComments}
          onQuery={handleQuery}
          queryLoading={filtering}
        />
      </div>
    </div>
  );
}

type StructureRow = ColumnInfo & { type: string; length: number; decimals: number };

/** 把 varchar(36) / decimal(28,8) 拆成类型、长度、小数位 */
function parseDataType(raw: string): Pick<StructureRow, 'type' | 'length' | 'decimals'> {
  const m = /^([^(]+)(?:\((\d+)(?:\s*,\s*(\d+))?\))?(.*)$/.exec(raw.trim());
  if (!m) return { type: raw, length: 0, decimals: 0 };
  return {
    type: `${m[1]}${m[4] ?? ''}`.trim(),
    length: m[2] ? Number(m[2]) : 0,
    decimals: m[3] ? Number(m[3]) : 0,
  };
}

/** 表结构 tab：与查询编辑器同级的只读面板，注释列换行完整展示 */
function StructurePanel({ tab }: { tab: Tab }) {
  const [rows, setRows] = useState<ColumnInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tab.table) return;
    let active = true;
    setLoading(true);
    setError(null);
    const params: Record<string, string> = { database: tab.database, table: tab.table };
    if (tab.schema) params.schema = tab.schema;
    api.get(`/metadata/${tab.connectionId}/columns`, { params })
      .then(({ data }) => { if (active) setRows((data.columns ?? []) as ColumnInfo[]); })
      .catch((e) => { if (active) setError(errMsg(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [tab.connectionId, tab.database, tab.schema, tab.table]);

  const dataSource: StructureRow[] = rows.map((r) => ({ ...r, ...parseDataType(r.dataType) }));
  const columns: ColumnsType<StructureRow> = [
    { title: '名称', dataIndex: 'name', key: 'name', width: 220 },
    { title: '类型', dataIndex: 'type', key: 'type', width: 180 },
    { title: '长度', dataIndex: 'length', key: 'length', width: 90 },
    { title: '小数点', dataIndex: 'decimals', key: 'decimals', width: 90 },
    { title: '不是 Null', key: 'notNull', width: 110, render: (_, r) => (r.nullable ? '否' : '是') },
    { title: '键', key: 'key', width: 100, render: (_, r) => (r.isPrimaryKey ? '主键' : '') },
    {
      title: '注释',
      dataIndex: 'comment',
      key: 'comment',
      render: (v: string | null) => <span className="structure-cell-comment">{v ?? ''}</span>,
    },
  ];

  return (
    <div className="query-panel">
      <div className="query-panel__toolbar">
        <div className="query-panel__context">
          <Tag color="blue" bordered={false}>表结构</Tag>
          <Typography.Text strong>{tab.connectionName}</Typography.Text>
          {tab.database && <Typography.Text type="secondary">/ {tab.database}</Typography.Text>}
          {tab.table && <Tag bordered={false} icon={<TableOutlined />}>{tab.table}</Tag>}
        </div>
      </div>
      <div className="structure-panel__body">
        {error ? (
          <div style={{ color: '#cf1322' }}>{error}</div>
        ) : (
          <Table<StructureRow>
            size="small"
            bordered
            pagination={false}
            loading={loading}
            rowKey="name"
            locale={{ emptyText: '未读取到字段信息' }}
            dataSource={dataSource}
            columns={columns}
          />
        )}
      </div>
    </div>
  );
}

export default function WorkspacePage({ forcePassword }: { forcePassword?: boolean }) {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const { connections, tabs, activeTabKey, addTab, closeTab, setActiveTab, loadConnections } =
    useWorkspaceStore();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);

  const openQueryTab = (conn: Connection, database: string) => {
    const existing = tabs.find(
      (t) => t.kind === 'query' && t.connectionId === conn.id && t.database === database && !t.table
    );
    if (existing) {
      setActiveTab(existing.key);
      return;
    }
    addTab({
      title: `${conn.name} · 查询`,
      kind: 'query',
      connectionId: conn.id,
      connectionName: conn.name,
      database,
      schema: null,
      table: null,
      sql: '',
    });
  };

  const openRedisTab = (conn: Connection, database: string) => {
    const existing = tabs.find(
      (t) => t.kind === 'redis' && t.connectionId === conn.id && t.database === database
    );
    if (existing) {
      setActiveTab(existing.key);
      return;
    }
    addTab({
      title: `${conn.name} · ${database}`,
      kind: 'redis',
      connectionId: conn.id,
      connectionName: conn.name,
      database,
      schema: null,
      table: null,
      sql: '',
    });
  };

  const openTableTab = (
    conn: Connection,
    database: string,
    schema: string | null,
    table: string,
    tableComment?: string | null
  ) => {
    const existing = tabs.find(
      (t) => t.connectionId === conn.id && t.database === database && t.schema === schema && t.table === table
    );
    if (existing) {
      setActiveTab(existing.key);
      return;
    }
    const quote = (name: string) => conn.type === 'mysql'
      ? `\`${name.replace(/`/g, '``')}\``
      : `"${name.replace(/"/g, '""')}"`;
    const qualifier = schema ? `${quote(schema)}.${quote(table)}` : quote(table);
    const sql = `SELECT * FROM ${qualifier} LIMIT 100;`;
    addTab({
      title: `${conn.name} · ${table}`,
      kind: 'data',
      connectionId: conn.id,
      connectionName: conn.name,
      database,
      schema,
      table,
      tableComment,
      sql,
    });
  };

  /** 打开表结构 tab（同一张表复用已有结构 tab） */
  const openStructureTab = (conn: Connection, database: string, schema: string | null, table: string) => {
    const existing = tabs.find(
      (t) => t.kind === 'structure' && t.connectionId === conn.id
        && t.database === database && t.schema === schema && t.table === table
    );
    if (existing) {
      setActiveTab(existing.key);
      return;
    }
    addTab({
      title: `${conn.name} · ${table} · 结构`,
      kind: 'structure',
      connectionId: conn.id,
      connectionName: conn.name,
      database,
      schema,
      table,
      sql: '',
    });
  };

  /** 打开 ES 索引/视图浏览 tab（同一索引模式复用已有 tab） */
  const openEsIndexTab = (conn: Connection, index: string, display?: string) => {
    const existing = tabs.find(
      (t) => t.kind === 'es' && t.connectionId === conn.id && t.database === index
    );
    if (existing) {
      setActiveTab(existing.key);
      return;
    }
    addTab({
      title: `${conn.name} · ${display ?? index}`,
      kind: 'es',
      connectionId: conn.id,
      connectionName: conn.name,
      database: index,
      schema: null,
      table: null,
      sql: '',
    });
  };

  const handleDeleteConnection = (conn: Connection) => {
    if (!conn?.id) return;
    modal.confirm({
      title: `删除数据源「${conn.name}」？`,
      content: '删除后无法恢复（数据库本身不受影响）',
      okText: '删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.delete(`/connections/${conn.id}`);
          message.success('已删除');
          await loadConnections();
        } catch (e) {
          message.error(errMsg(e));
        }
      },
    });
  };

  /* 侧栏拖拽调宽：写入全局 CSS 变量并记忆到 localStorage（双击把手恢复默认） */
  const [sidebarWidth, setSidebarWidth] = useState<number>(readSidebarWidth);
  useEffect(() => {
    document.documentElement.style.setProperty('--datax-sidebar-w', `${sidebarWidth}px`);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  // 拖拽中途卸载时移除全局监听（切路由导致），避免内存泄漏
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + ev.clientX - startX)));
    };
    const cleanup = () => {
      document.body.style.removeProperty('user-select');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      resizeCleanupRef.current = null;
    };
    const onUp = () => cleanup();
    // 拖拽中禁止选中文字
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    resizeCleanupRef.current = cleanup;
  };

  if (forcePassword) {
    return (
      <>
        <ChangePasswordModal open force onClose={() => navigate('/')} />
      </>
    );
  }

  const tabItems = tabs.map((t) => {
    const conn = connections.find((c) => c.id === t.connectionId);
    return {
      key: t.key,
      label: (
        <span
          className="workspace-tab-label"
          title={t.tableComment ? `${t.title} · ${t.tableComment}` : t.title}
        >
          {t.title}
        </span>
      ),
      closable: true,
      children: t.kind === 'structure'
        ? <StructurePanel tab={t} />
        : conn?.type === 'redis'
          ? <RedisQueryPanel tab={t} />
          : conn?.type === 'elasticsearch'
            ? <EsQueryPanel tab={t} />
            : <QueryPanel tab={t} />,
    };
  });

  return (
    <div className="workspace">
      <aside className="workspace-sidebar">
        <ConnectionTree
          canManage={user?.role === 'admin'}
          onOpenQuery={openQueryTab}
          onOpenTable={openTableTab}
          onOpenStructure={openStructureTab}
          onOpenIndex={openEsIndexTab}
          onOpenRedis={openRedisTab}
          onEditConnection={(conn) => {
            setEditing(conn?.id ? conn : null);
            setFormOpen(true);
          }}
          onDeleteConnection={handleDeleteConnection}
        />
      </aside>

      <div
        className="workspace-sidebar-resizer"
        onMouseDown={startResize}
        onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
        title="拖拽调整宽度，双击恢复默认"
      />

      <div className="workspace-main">
        <AppHeader mode="database" />

        <main className="workspace-content">
          {tabs.length === 0 ? (
            <div className="workspace-empty">
              <DatabaseOutlined style={{ fontSize: 40, color: '#c3cddb' }} />
              <Typography.Text strong style={{ fontSize: 15 }}>
                还没有打开的查询
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                在左侧数据源上双击连接新建查询，或双击表查看数据
              </Typography.Text>
              {connections.length === 0 && user?.role === 'admin' && (
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() => { setEditing(null); setFormOpen(true); }}
                >
                  新建数据源
                </Button>
              )}
            </div>
          ) : (
            <Tabs
              type="editable-card"
              hideAdd
              activeKey={activeTabKey ?? undefined}
              onChange={setActiveTab}
              onEdit={(key, action) => action === 'remove' && closeTab(String(key))}
              items={tabItems}
              className="workspace-tabs"
            />
          )}
        </main>
      </div>

      <ConnectionFormModal open={formOpen} onClose={() => setFormOpen(false)} editing={editing} />
      <AuditConfirmModal />
    </div>
  );
}
