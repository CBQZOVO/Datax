import { useEffect, useMemo, useRef, useState } from 'react';
import { App, Button, Dropdown, Empty, Input, List, Modal, Spin, Tree } from 'antd';
import {
  ApartmentOutlined,
  ConsoleSqlOutlined,
  DatabaseOutlined,
  EditOutlined,
  EyeOutlined,
  FileSearchOutlined,
  FolderOutlined,
  PlusOutlined,
  ProfileOutlined,
  SearchOutlined,
  TableOutlined,
} from '@ant-design/icons';
import type { MenuProps, TreeDataNode, TreeProps } from 'antd';
import { api, errMsg, type Connection } from '../api';
import { useWorkspaceStore } from '../stores/workspace';
import DbTypeIcon from './DbTypeIcon';

interface ConnTreeProps {
  canManage: boolean;
  onOpenQuery: (conn: Connection, database: string) => void;
  onOpenTable: (conn: Connection, database: string, schema: string | null, table: string, tableComment?: string | null) => void;
  onOpenStructure: (conn: Connection, database: string, schema: string | null, table: string) => void;
  onOpenIndex: (conn: Connection, index: string, display?: string) => void;
  onOpenRedis: (conn: Connection, database: string) => void;
  onEditConnection: (conn: Connection | null) => void;
  onDeleteConnection: (conn: Connection) => void;
}

interface NodeMeta {
  conn: Connection;
  database: string;
  schema: string | null;
  table?: string;
  /** 表注释，打开表时带给查询面板 */
  tableComment?: string | null;
  /** 展示用短名（如视图名），缺省用 database */
  display?: string;
}

/** antd DataNode 不允许自定义字段，扩展类型携带元数据 */
type MetaNode = TreeDataNode & { data?: NodeMeta };

/** Base64 编码段，避免 - 与分隔符冲突 */
const enc = (s: string) => btoa(unescape(encodeURIComponent(s)));
const dec = (s: string) => {
  try {
    return decodeURIComponent(escape(atob(s)));
  } catch {
    return s;
  }
};

const asMeta = (node: TreeDataNode): MetaNode => node as MetaNode;

export default function ConnectionTree({
  canManage,
  onOpenQuery,
  onOpenTable,
  onOpenStructure,
  onOpenIndex,
  onOpenRedis,
  onEditConnection,
  onDeleteConnection,
}: ConnTreeProps) {
  const { message } = App.useApp();
  const { connections, loadConnections, loadingConnections, treeRefreshNonce } = useWorkspaceStore();
  const [filter, setFilter] = useState('');
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [treeData, setTreeData] = useState<MetaNode[]>([]);
  // 记录已成功加载过子节点的 key，避免重复请求
  const loadedKeysRef = useRef<Set<string>>(new Set());
  // 大表 schema 的搜索弹窗
  const [searchTarget, setSearchTarget] = useState<{ conn: Connection; database: string; schema: string | null } | null>(null);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  // 数据源树刷新：ES 建/删索引后清空已加载子节点缓存并重新加载，跳过首次挂载
  const firstTreeRun = useRef(true);
  useEffect(() => {
    if (firstTreeRun.current) {
      firstTreeRun.current = false;
      return;
    }
    loadedKeysRef.current.clear();
    setExpandedKeys([]);
    void loadConnections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeRefreshNonce]);

  // 连接列表变化时重建根节点，但保留已加载的子节点，避免展开状态丢失
  useEffect(() => {
    const roots = connections
      .filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()))
      .map((conn) => ({
        key: `conn-${conn.id}`,
        title: (
          <span className="conn-tree-node__title" title={`${conn.name} · ${conn.type} · ${conn.host}`}>
            <span className="conn-tree-node__name">{conn.name}</span>
            <span className="conn-tree-node__meta">{conn.type} · {conn.host}</span>
          </span>
        ),
        icon: <DbTypeIcon type={conn.type} size={15} />,
        isLeaf: false,
        data: { conn, database: '', schema: null } satisfies NodeMeta,
      }) as MetaNode);

    const connById = new Map(connections.map((c) => [c.id, c]));
    setTreeData((prev) => mergeLoaded(roots, prev, connById));
  }, [connections]);

  // 搜索只作用于展示层：treeData 始终保存完整树，清空搜索即恢复全部已加载节点。
  // 匹配范围：连接名 / 库名 / schema 名 / 表名，命中节点保留完整子树，未命中节点递归过滤后代。
  const visibleTree = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    if (!kw) return treeData;
    const nodeName = (node: MetaNode): string => {
      const d = node.data;
      if (d?.table) return d.table;
      if (d?.schema) return d.schema;
      if (d?.database) return d.database;
      return d?.conn.name ?? '';
    };
    const walk = (nodes: MetaNode[]): MetaNode[] =>
      nodes.reduce<MetaNode[]>((acc, node) => {
        if (nodeName(node).toLowerCase().includes(kw)) {
          acc.push(node);
        } else if (node.children?.length) {
          const children = walk(node.children as MetaNode[]);
          if (children.length) acc.push({ ...node, children });
        }
        return acc;
      }, []);
    return walk(treeData);
  }, [treeData, filter]);

  /** 加载某个 (conn, database, schema) 下的表/视图，超过 200 加搜索节点 */
  const loadTablesAndViews = async (meta: NodeMeta): Promise<MetaNode[]> => {
    const { conn, database, schema } = meta;
    const params: Record<string, string> = { database };
    if (schema) params.schema = schema;
    const [t, v] = await Promise.all([
      api.get(`/metadata/${conn.id}/tables`, { params }),
      api.get(`/metadata/${conn.id}/views`, { params }),
    ]);
    const tablesPayload = t.data as { tables: { name: string; rowCount: number | null; comment?: string | null }[]; total?: number; truncated?: boolean };
    const total: number = tablesPayload.total ?? tablesPayload.tables.length;
    const truncated: boolean = Boolean(tablesPayload.truncated);
    const tables: MetaNode[] = tablesPayload.tables.map((tb) => ({
      key: `table-${conn.id}-${enc(database)}-${enc(schema ?? '')}-${enc(tb.name)}`,
      title: (
        <span className="conn-tree-node__title">
          <span className="conn-tree-node__name" title={tb.name}>{tb.name}</span>
          {tb.comment && <span className="conn-tree-node__meta conn-tree-node__comment">{tb.comment}</span>}
        </span>
      ),
      icon: <TableOutlined className="tree-table-icon" />,
      isLeaf: true,
      data: { conn, database, schema, table: tb.name, tableComment: tb.comment ?? null } satisfies NodeMeta,
    }) as MetaNode);
    const views: MetaNode[] = (v.data.views as string[]).map((name) => ({
      key: `view-${conn.id}-${enc(database)}-${enc(schema ?? '')}-${enc(name)}`,
      title: (
        <span className="conn-tree-node__title">
          <span className="conn-tree-node__name" title={name}>{name}</span>
        </span>
      ),
      icon: <EyeOutlined style={{ color: '#722ed1' }} />,
      isLeaf: true,
      data: { conn, database, schema, table: name } satisfies NodeMeta,
    }) as MetaNode);
    const children: MetaNode[] = [...tables, ...views];
    if (truncated) {
      children.push({
        key: `search-${conn.id}-${enc(database)}-${enc(schema ?? '')}`,
        title: (
          <span className="conn-tree-node__title">
            <span className="conn-tree-node__name" style={{ color: '#275c9f' }}>
              在 {total} 张表中搜索…
            </span>
          </span>
        ),
        icon: <SearchOutlined style={{ color: '#275c9f' }} />,
        isLeaf: true,
        data: { conn, database, schema } satisfies NodeMeta,
      } as MetaNode);
    }
    return children;
  };

  const loadNode = async (key: string): Promise<MetaNode[]> => {
    if (key.startsWith('conn-')) {
      const id = Number(key.slice(5));
      const conn = connections.find((c) => c.id === id);
      if (!conn) return [];
      // ES 数据源：按 Kibana 数据视图的思路聚合——去掉日期后缀归并为索引模式
      // （如 app-k8s_audit-2026.10.29 → audit-*），
      // 视图即查询单元：点击直接按前缀模式查询，不再罗列具体日期索引
      if (conn.type === 'elasticsearch') {
        const { data } = await api.get('/es/indices', { params: { connectionId: id } });
        const indices = (data.indices as { name: string; docs: number }[]);
        const DATE_RE = /-\d{4}\.\d{2}\.\d{2}$/;
        const groups = new Map<string, {
          pattern: string; name: string; docs: number; count: number;
          indices: { name: string; docs: number }[];
        }>();
        for (const idx of indices) {
          const dated = DATE_RE.test(idx.name);
          const base = dated ? idx.name.replace(DATE_RE, '') : idx.name;
          const pattern = dated ? `${base}-*` : base;
          const g = groups.get(pattern) ?? {
            pattern,
            name: base.split('_').pop() || base,
            docs: 0,
            count: 0,
            indices: [],
          };
          g.docs += idx.docs;
          g.count += 1;
          g.indices.push(idx);
          groups.set(pattern, g);
        }
        const views = [...groups.values()].sort((a, b) => b.docs - a.docs);
        // 视图为叶子节点：显示完整匹配模式（与权限配置界面一致），meta 保留文档量与索引数
        return views.map((view) => ({
          key: `esview-${id}-${enc(view.pattern)}`,
          title: (
            <span className="conn-tree-node__title">
              <span className="conn-tree-node__name">{view.pattern}</span>
              <span className="conn-tree-node__meta">{fmtCount(view.docs)} · {view.count} 索引</span>
            </span>
          ),
          icon: <FileSearchOutlined style={{ color: '#13c2c2' }} />,
          isLeaf: true,
          data: { conn, database: view.pattern, schema: null, display: view.pattern } satisfies NodeMeta,
        }) as MetaNode);
      }
      // Redis：第二层即 db0..db15（叶子节点，点击直接打开命令面板；标注各库 key 数量）
      if (conn.type === 'redis') {
        const { data: dbData } = await api.get('/redis/databases', { params: { connectionId: id } });
        return (dbData.databases as { db: string; keys: number }[]).map((item) => ({
          key: `rdb-${id}-${enc(item.db)}`,
          title: (
            <span className="conn-tree-node__title">
              <span className="conn-tree-node__name">{item.db}</span>
              <span className="conn-tree-node__meta">{item.keys > 0 ? `${fmtCount(item.keys)} keys` : '空'}</span>
            </span>
          ),
          icon: <DatabaseOutlined style={{ color: item.keys > 0 ? '#d82c20' : '#c9d1d9' }} />,
          isLeaf: true,
          data: { conn, database: item.db, schema: null } satisfies NodeMeta,
        }) as MetaNode);
      }
      const { data } = await api.get(`/metadata/${id}/databases`);
      return (data.databases as string[]).map((db) => ({
        key: `db-${id}-${enc(db)}`,
        title: (
          <span className="conn-tree-node__title">
            <span className="conn-tree-node__name" title={db}>{db}</span>
          </span>
        ),
        icon: <FolderOutlined style={{ color: '#13c2c2' }} />,
        isLeaf: false,
        data: { conn, database: db, schema: null } satisfies NodeMeta,
      }) as MetaNode);
    }
    if (key.startsWith('db-')) {
      const meta = parseKey(key, 'db');
      if (!meta) return [];
      if (meta.conn.type === 'postgres') {
        const { data } = await api.get(`/metadata/${meta.conn.id}/schemas`, {
          params: { database: meta.database },
        });
        return (data.schemas as string[]).map((sch) => ({
          key: `sch-${meta.conn.id}-${enc(meta.database)}-${enc(sch)}`,
          title: (
            <span className="conn-tree-node__title">
              <span className="conn-tree-node__name" title={sch}>{sch}</span>
            </span>
          ),
          icon: <ApartmentOutlined style={{ color: '#275c9f' }} />,
          isLeaf: false,
          data: { conn: meta.conn, database: meta.database, schema: sch } satisfies NodeMeta,
        }) as MetaNode);
      }
      // MySQL: schema 节点直接展开为表/视图
      return loadTablesAndViews({ conn: meta.conn, database: meta.database, schema: null });
    }
    if (key.startsWith('sch-')) {
      const meta = parseKey(key, 'sch');
      if (!meta) return [];
      // 直接展开为表/视图，去掉多余的 grp- 合成节点
      return loadTablesAndViews({ conn: meta.conn, database: meta.database, schema: meta.schema });
    }
    return [];
  };

  /** 从 key 解析：
   *  db-:  {id}-{enc(db)}
   *  sch-: {id}-{enc(db)}-{enc(schema)}（schema 在最后一段）
   */
  const parseKey = (key: string, prefix: string): NodeMeta | null => {
    const rest = key.slice(prefix.length + 1);
    const parts = rest.split('-');
    const id = Number(parts[0]);
    const conn = connections.find((c) => c.id === id);
    if (!conn) return null;
    const schemaRaw = prefix === 'sch'
      ? dec(parts[2] ?? '') || null
      : null;
    return { conn, database: dec(parts[1] ?? ''), schema: schemaRaw };
  };

  /** 不可变更新：只有替换 treeData 才会触发 React 重新渲染 */
  const onLoadData: TreeProps['loadData'] = async (node) => {
    const key = String(node.key);
    if (loadedKeysRef.current.has(key)) return;
    try {
      const children = await loadNode(key);
      loadedKeysRef.current.add(key);
      setTreeData((prev) => setChildren(prev, key, children));
    } catch (error) {
      message.error('加载失败：' + errMsg(error));
      // 抛出后 rc-tree 会结束 loading 状态，再次展开会重试
      throw error;
    }
  };

  const onSelect: TreeProps['onSelect'] = (keys, info) => {
    const key = String(keys[0] ?? '');
    if (key.startsWith('rdb-')) {
      const meta = asMeta(info.node).data;
      if (meta?.database) onOpenRedis(meta.conn, meta.database);
      return;
    }
    if (key.startsWith('esview-')) {
      const meta = asMeta(info.node).data;
      if (meta?.database) onOpenIndex(meta.conn, meta.database, meta.display);
      return;
    }
    if (!key.startsWith('table-') && !key.startsWith('view-')) return;
    const meta = asMeta(info.node).data;
    if (!meta?.table) return;
    const parts = key.split('-');
    const name = dec(parts[parts.length - 1]);
    onOpenTable(meta.conn, meta.database, meta.schema, name, meta.tableComment);
  };

  const onDoubleClick = (_e: React.MouseEvent, node: TreeDataNode) => {
    const key = String(node.key);
    if (key.startsWith('conn-')) {
      const meta = asMeta(node).data;
      if (meta) onOpenQuery(meta.conn, meta.database);
    } else if (key.startsWith('rdb-')) {
      const meta = asMeta(node).data;
      if (meta?.database) onOpenRedis(meta.conn, meta.database);
    } else if (key.startsWith('esview-')) {
      const meta = asMeta(node).data;
      if (meta?.database) onOpenIndex(meta.conn, meta.database, meta.display);
    } else if (key.startsWith('search-')) {
      const meta = asMeta(node).data;
      if (meta) setSearchTarget({ conn: meta.conn, database: meta.database, schema: meta.schema ?? null });
    }
  };

  const contextMenu = (node: TreeDataNode): MenuProps => {
    const key = String(node.key);
    const isConn = key.startsWith('conn-');
    const isTable = key.startsWith('table-') || key.startsWith('view-');
    return {
      items: isConn
        ? [
            { key: 'query', icon: <ConsoleSqlOutlined />, label: '新建查询' },
            ...(canManage
              ? [
                  { key: 'edit', icon: <EditOutlined />, label: '编辑连接' },
                  { key: 'delete', label: '删除连接', danger: true },
                ]
              : []),
          ]
        : isTable
          ? [
              { key: 'open', icon: <TableOutlined />, label: '打开表' },
              { key: 'structure', icon: <ProfileOutlined />, label: '查看表结构' },
            ]
          : [],
      onClick: (info) => {
        info.domEvent.stopPropagation();
        const meta = asMeta(node).data;
        if (!meta) return;
        if (info.key === 'query') onOpenQuery(meta.conn, meta.database);
        if (info.key === 'edit') onEditConnection(meta.conn);
        if (info.key === 'delete') onDeleteConnection(meta.conn);
        if (isTable && meta.table) {
          if (info.key === 'open') onOpenTable(meta.conn, meta.database, meta.schema, meta.table, meta.tableComment);
          if (info.key === 'structure') onOpenStructure(meta.conn, meta.database, meta.schema, meta.table);
        }
      },
    };
  };

  return (
    <div className="conn-tree">
      <div className="conn-tree__head">
        <span className="conn-tree__title">
          <DatabaseOutlined style={{ color: 'var(--brand-primary)' }} />
          数据源
        </span>
        {canManage && (
          <Button
            type="text"
            size="small"
            icon={<PlusOutlined />}
            onClick={() => onEditConnection(null)}
            title="新建数据源"
          />
        )}
      </div>

      <div className="conn-tree__search">
        <Input
          size="small"
          prefix={<SearchOutlined style={{ color: 'var(--datax-text-secondary)' }} />}
          placeholder="搜索数据源"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          allowClear
        />
      </div>

      <div className="conn-tree__body">
        {loadingConnections && !connections.length ? (
          <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
        ) : visibleTree.length === 0 ? (
          <Empty
            description={filter ? '没有匹配的数据源' : '暂无数据源'}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{ marginTop: 32 }}
          />
        ) : (
          <Tree
            showIcon
            blockNode
            treeData={visibleTree}
            loadData={onLoadData}
            onSelect={onSelect}
            expandedKeys={expandedKeys}
            onExpand={(keys) => setExpandedKeys(keys)}
            onDoubleClick={onDoubleClick}
            titleRender={(node) => (
              <Dropdown menu={contextMenu(node)} trigger={['contextMenu']}>
                <span className="conn-tree-node__wrap">{node.title as React.ReactNode}</span>
              </Dropdown>
            )}
          />
        )}
      </div>

      <TableSearchModal
        target={searchTarget}
        onClose={() => setSearchTarget(null)}
        onOpenTable={(conn, database, schema, table, tableComment) => {
          setSearchTarget(null);
          onOpenTable(conn, database, schema, table, tableComment);
        }}
      />
    </div>
  );
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function TableSearchModal({
  target,
  onClose,
  onOpenTable,
}: {
  target: { conn: Connection; database: string; schema: string | null } | null;
  onClose: () => void;
  onOpenTable: (conn: Connection, database: string, schema: string | null, table: string, tableComment?: string | null) => void;
}) {
  const [kw, setKw] = useState('');
  const [results, setResults] = useState<{ name: string; rowCount: number | null; comment?: string | null }[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    if (!target) {
      setKw('');
      setResults([]);
      setSearched(false);
      return;
    }
    setKw('');
    setResults([]);
    setSearched(false);
  }, [target?.conn.id, target?.database, target?.schema]);

  useEffect(() => {
    if (!target || !kw.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }
    const t = target;
    const timer = setTimeout(() => {
      setLoading(true);
      const params: Record<string, string> = { database: t.database, q: kw.trim() };
      if (t.schema) params.schema = t.schema;
      api
        .get(`/metadata/${t.conn.id}/tables/search`, { params })
        .then(({ data }) => {
          setResults(data.tables || []);
          setSearched(true);
        })
        .catch(() => {
          setResults([]);
          setSearched(true);
        })
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [kw, target?.conn.id, target?.database, target?.schema]);

  return (
    <Modal
      open={!!target}
      onCancel={onClose}
      title={target ? `在 ${target.conn.name} · ${target.database}${target.schema ? ` · ${target.schema}` : ''} 中搜索表` : ''}
      footer={null}
      width={520}
      destroyOnClose
    >
      <Input
        autoFocus
        size="large"
        prefix={<SearchOutlined />}
        placeholder="输入表名关键字"
        value={kw}
        onChange={(e) => setKw(e.target.value)}
        allowClear
      />
      <div style={{ marginTop: 12, maxHeight: 360, overflow: 'auto' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
        ) : !searched ? (
          <div style={{ color: 'var(--datax-text-secondary)', textAlign: 'center', padding: 24, fontSize: 13 }}>
            输入关键字以表名模糊匹配
          </div>
        ) : results.length === 0 ? (
          <div style={{ color: 'var(--datax-text-secondary)', textAlign: 'center', padding: 24, fontSize: 13 }}>
            没有匹配的表
          </div>
        ) : (
          <List
            size="small"
            dataSource={results}
            renderItem={(item) => (
              <List.Item
                style={{ cursor: 'pointer', padding: '6px 8px' }}
                onClick={() => target && onOpenTable(target.conn, target.database, target.schema, item.name, item.comment)}
              >
                <TableOutlined style={{ color: 'var(--datax-success)', marginRight: 8 }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  {item.name}
                  {item.comment && (
                    <span style={{ color: 'var(--datax-text-secondary)', fontSize: 12, marginLeft: 8 }}>{item.comment}</span>
                  )}
                </span>
                {item.rowCount != null && (
                  <span style={{ color: 'var(--datax-text-secondary)', fontSize: 12 }}>{fmtCount(item.rowCount)}</span>
                )}
              </List.Item>
            )}
          />
        )}
      </div>
    </Modal>
  );
}

/** 不可变地给指定 key 的节点挂载子节点 */
function setChildren(nodes: MetaNode[], key: string, children: MetaNode[]): MetaNode[] {
  return nodes.map((node) => {
    if (node.key === key) return { ...node, children };
    if (node.children?.length) {
      return { ...node, children: setChildren(node.children as MetaNode[], key, children) };
    }
    return node;
  });
}

/** 重建根节点时保留已加载的子节点，并用最新连接信息刷新其元数据 */
function mergeLoaded(
  roots: MetaNode[],
  prev: MetaNode[],
  connById: Map<number, Connection>
): MetaNode[] {
  const prevByKey = new Map<string, MetaNode>();
  const walk = (nodes: MetaNode[]) => {
    for (const node of nodes) {
      prevByKey.set(String(node.key), node);
      if (node.children?.length) walk(node.children as MetaNode[]);
    }
  };
  walk(prev);

  const attach = (nodes: MetaNode[]): MetaNode[] =>
    nodes.map((node) => {
      const old = prevByKey.get(String(node.key));
      if (!old?.children?.length) return node;
      return {
        ...node,
        children: attach(old.children as MetaNode[]).map((child) => ({
          ...child,
          data: child.data
            ? { ...child.data, conn: connById.get(child.data.conn.id) ?? child.data.conn }
            : child.data,
        })),
      };
    });

  return attach(roots);
}
