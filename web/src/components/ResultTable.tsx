import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Button, Dropdown, Empty, Input, Pagination, Space, Table } from 'antd';
import { AlignLeftOutlined, CopyOutlined, DownloadOutlined, LoadingOutlined } from '@ant-design/icons';
import type { MouseEvent as ReactMouseEvent, DragEvent as ReactDragEvent, ReactNode, ThHTMLAttributes } from 'react';
import type { ColumnType } from 'antd/es/table';
import type { QueryResult } from '../api';

// 列头为「字段名 + 字段注释」两行，预留表头高度用于计算表体可用滚动高度
const HEADER_HEIGHT = 62;
// 表头下追加的列筛选输入行高度（仅 SQL 查询面板启用 onQuery 时出现）
const FILTER_ROW_HEIGHT = 34;

type HeaderCellProps = ThHTMLAttributes<HTMLTableCellElement> & {
  resizeKey?: string;
  onResizeStart?: (e: ReactMouseEvent, key: string) => void;
};

/** 自定义表头单元格：右侧渲染列宽拖拽手柄，其余 props（含列拖拽排序事件）原样透传给 th */
function HeaderCell({ resizeKey, onResizeStart, children, ...rest }: HeaderCellProps) {
  return (
    <th {...rest}>
      {children as ReactNode}
      {resizeKey && onResizeStart && (
        <span className="col-resize-handle" onMouseDown={(e) => onResizeStart(e, resizeKey)} />
      )}
    </th>
  );
}

interface FilterHeaderCtx {
  columns: ColumnType<Record<string, unknown>>[];
  enabled: boolean;
  /** 筛选 SQL 生成中（输入框显示 loading 并防重） */
  queryLoading: boolean;
  values: Record<string, string>;
  onChange: (col: string, v: string) => void;
  /** 提交筛选（overrideValues 用于清空某列时立即以「该列已清空」的条件重查） */
  submit: (overrideValues?: Record<string, string>) => void;
}

const FilterHeaderContext = createContext<FilterHeaderCtx | null>(null);

/**
 * thead 包装：在表头行下追加一行与列对齐的筛选输入框（仅 SQL 查询面板启用）。
 * 组件引用保持稳定（数据经 Context 传入），避免输入时 thead 重挂载丢失焦点。
 */
function FilterHeaderWrapper(props: { children?: ReactNode }) {
  const ctx = useContext(FilterHeaderContext);
  return (
    <thead {...props}>
      {props.children}
      {ctx?.enabled && (
        <tr className="result-filter-row">
          {ctx.columns.map((col) => {
            const c = String(col.key);
            return (
              <th key={c} className="ant-table-cell result-filter-cell">
                <Input
                  size="small"
                  allowClear
                  placeholder="如 %abc%"
                  value={ctx.values[c] ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    const had = (ctx.values[c] ?? '') !== '';
                    ctx.onChange(c, v);
                    // 点击 × / 手动清空该列条件时，立即按剩余条件重新查询
                    if (v === '' && had) ctx.submit({ ...ctx.values, [c]: '' });
                  }}
                  onKeyDown={(e) => {
                    // 中文输入法回车确认候选词不触发筛选
                    if (e.nativeEvent.isComposing || e.key !== 'Enter') return;
                    ctx.submit();
                  }}
                  suffix={ctx.queryLoading
                    ? <LoadingOutlined spin style={{ color: 'var(--brand-primary)' }} />
                    : undefined}
                />
              </th>
            );
          })}
        </tr>
      )}
    </thead>
  );
}

export default function ResultTable({
  result,
  defaultPageSize,
  onPageSizeChange,
  allowWrap,
  onQuery,
  queryLoading,
  onRowClick,
  columnComments,
}: {
  result: QueryResult | null;
  /** 初始每页行数（ES 视图与拉取条数同源，默认 10） */
  defaultPageSize?: number;
  /** 每页行数变化回调（ES 视图用它按新条数重新拉取） */
  onPageSizeChange?: (size: number) => void;
  /** 显示「换行」开关（ES 日志面板传 true，不依赖列数判定） */
  allowWrap?: boolean;
  /** 筛选/排序回调（SQL 查询面板传入）：回车或点列头排序时，把非空筛选条件与排序整体抛出，由面板生成新 SQL */
  onQuery?: (opts: { filters: Record<string, string>; sort: { column: string; order: 'asc' | 'desc' } | null }) => void;
  /** 筛选 SQL 生成中：筛选输入框显示 loading */
  queryLoading?: boolean;
  /** 点击数据行（Redis 面板用来查看 key 的值） */
  onRowClick?: (record: Record<string, unknown>) => void;
  /** 字段名小写 → 字段注释（SQL 查询面板按当前表加载） */
  columnComments?: Record<string, string>;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize ?? 10);
  // ES 日志视图的「换行」显示开关：开启后单元格取消单行省略，长日志完整展示
  const [wrap, setWrap] = useState(false);
  // 列筛选输入值（列名 → 值，值原样传后端，% 通配符由用户自己控制）
  const [colFilters, setColFilters] = useState<Record<string, string>>({});
  // 列排序（点表头三态切换：asc → desc → 取消）
  const [sort, setSort] = useState<{ column: string; order: 'asc' | 'desc' } | null>(null);
  const [bodyHeight, setBodyHeight] = useState(240);
  // 列宽覆盖（按列名记忆，跨查询保留）与列顺序
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [order, setOrder] = useState<string[]>([]);
  const dragKeyRef = useRef<string | null>(null);
  const resizingRef = useRef(false);
  // 拖拽中的全局监听清理函数：组件在拖拽中途卸载（切路由/关 tab）时兜底移除
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { message } = AntApp.useApp();

  // 表体滚动高度跟随容器实际大小（容器由外层 flex 弹性分配）
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      const h = el.clientHeight - HEADER_HEIGHT - (onQuery ? FILTER_ROW_HEIGHT : 0);
      setBodyHeight(h > 140 ? h : 140);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [result, onQuery]);

  const dataSource = useMemo(() => {
    if (!result) return [];
    const start = (page - 1) * pageSize;
    return result.rows.slice(start, start + pageSize).map((row, i) => {
      const obj: Record<string, unknown> = { __key: `${start + i}` };
      result.columns.forEach((c, ci) => {
        obj[c] = row[ci] ?? null;
      });
      return obj;
    });
  }, [result, page, pageSize]);

  /** 每列固定宽度，长内容截断省略（悬停 title 看全文），表格横向滚动 */
  const COLUMN_WIDTH = 180;

  /** 列宽拖拽：mousedown 记录起点，mousemove 实时改宽，mouseup 收尾 */
  const startResize = (e: ReactMouseEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.target as HTMLElement).closest('th');
    const startW = widths[key] ?? th?.offsetWidth ?? COLUMN_WIDTH;
    const startX = e.clientX;
    resizingRef.current = true;
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(60, startW + ev.clientX - startX);
      setWidths((prev) => ({ ...prev, [key]: w }));
    };
    const cleanup = () => {
      resizingRef.current = false;
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      dragCleanupRef.current = null;
    };
    const onUp = () => cleanup();
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    dragCleanupRef.current = cleanup;
  };

  // 组件在拖拽中途卸载时移除全局监听，避免内存泄漏与 userSelect 残留
  useEffect(() => () => dragCleanupRef.current?.(), []);

  /** 列拖拽排序：把 from 列移动到 to 列的位置 */
  const moveColumn = (from: string, to: string) => {
    if (!result || from === to) return;
    setOrder((prev) => {
      const base = [
        ...prev.filter((k) => result.columns.includes(k)),
        ...result.columns.filter((k) => !prev.includes(k)),
      ];
      const fromIdx = base.indexOf(from);
      const toIdx = base.indexOf(to);
      if (fromIdx < 0 || toIdx < 0) return base;
      base.splice(toIdx, 0, ...base.splice(fromIdx, 1));
      return base;
    });
  };

  // ES 日志视图（@timestamp + log 两列）：时间列窄宽固定，log 列不设宽度以吃掉剩余空间；
  // 普通 SQL 结果仍全部固定宽 + 横向滚动
  // __ 前缀列是后端附带的内部元数据（ES 的 _id/_index 等），只用于行操作，不展示
  const visibleColumns = result?.columns.filter((c) => !c.startsWith('__')) ?? [];
  const isEsLogView = visibleColumns.length === 2 && visibleColumns.includes('@timestamp');

  /** 收集非空筛选条件 */
  const nonEmptyFilters = () =>
    Object.fromEntries(Object.entries(colFilters).filter(([, v]) => v.trim() !== ''));

  /** 提交筛选；overrideValues 提供时以其为基准（用于清空某列后立即重查，绕过 state 异步更新） */
  const submitWith = (overrideValues?: Record<string, string>) => {
    if (!onQuery) return;
    const source = overrideValues ?? colFilters;
    const nonEmpty = Object.fromEntries(
      Object.entries(source).filter(([, v]) => v.trim() !== '')
    );
    onQuery({ filters: nonEmpty, sort });
  };

  const columns = useMemo(() => {
    if (!result) return [];
    const posOf = (key: string) => {
      const i = order.indexOf(key);
      return i === -1 ? order.length + result.columns.indexOf(key) : i;
    };
    const list = [...visibleColumns]
      .sort((a, b) => posOf(a) - posOf(b))
      .map((c): ColumnType<Record<string, unknown>> => ({
        title: (
          <span className="result-col-title">
            <span className="result-col-title__name">{c}</span>
            {columnComments?.[c.toLowerCase()] && (
              <span className="result-col-title__comment">{columnComments[c.toLowerCase()]}</span>
            )}
          </span>
        ),
        dataIndex: c,
        key: c,
        ellipsis: true,
        // 有 onQuery 才启用表头排序（由外层生成 SQL 重新查询，非本地排序）
        ...(onQuery ? {
          sorter: true,
          sortOrder: sort?.column === c ? (sort.order === 'asc' ? 'ascend' : 'descend') : null,
        } : {}),
        width: widths[c] ?? (c === '@timestamp' ? 190 : isEsLogView ? undefined : COLUMN_WIDTH),
        onHeaderCell: () => ({
          resizeKey: c,
          onResizeStart: startResize,
          draggable: true,
          onDragStart: (e: ReactDragEvent) => {
            if (resizingRef.current) {
              e.preventDefault();
              return;
            }
            dragKeyRef.current = c;
          },
          onDragOver: (e: ReactDragEvent) => e.preventDefault(),
          onDrop: () => {
            const from = dragKeyRef.current;
            dragKeyRef.current = null;
            if (from) moveColumn(from, c);
          },
        }),
        render: (v: unknown) => (v === null || v === undefined ? <span style={{ color: '#bbb' }}>NULL</span> : String(v)),
      }));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, widths, order, sort, columnComments]);

  useEffect(() => {
    setPage(1);
  }, [result]);

  if (!result) {
    return (
      <div className="result-empty">
        <Empty description="执行查询后在此显示结果" />
      </div>
    );
  }

  /** CSV 字段转义：含逗号/引号/换行加引号；以 = + @ 开头加前缀防公式注入 */
  const csvCell = (v: unknown): string => {
    let s = v == null ? '' : String(v);
    if (/^[=+@]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };

  const copyCsv = () => {
    if (!result) return;
    const header = result.columns.map(csvCell).join(',');
    const lines = result.rows.map((r) => r.map(csvCell).join(','));
    navigator.clipboard.writeText([header, ...lines].join('\n'))
      .then(() => message.success('CSV 已复制'))
      .catch(() => message.error('复制失败：浏览器剪贴板不可用'));
  };

  const download = (fmt: 'csv' | 'json') => {
    if (!result) return;
    let content = '';
    const fname = `export_${Date.now()}`;
    if (fmt === 'csv') {
      content = [result.columns.map(csvCell).join(','), ...result.rows.map((r) => r.map(csvCell).join(','))].join('\n');
    } else {
      content = JSON.stringify(
        result.rows.map((r) => Object.fromEntries(result.columns.map((c, i) => [c, r[i]]))),
        null,
        2
      );
    }
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${fname}.${fmt}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const filterHeaderCtx: FilterHeaderCtx = {
    columns,
    enabled: Boolean(onQuery),
    queryLoading: Boolean(queryLoading),
    values: colFilters,
    onChange: (col, v) => setColFilters((prev) => ({ ...prev, [col]: v })),
    submit: submitWith,
  };

  return (
    <FilterHeaderContext.Provider value={filterHeaderCtx}>
    <div className="result-panel">
      <div className="result-meta" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{result.message}</span>
        <Space size={4}>
          {allowWrap && (
            <Button
              size="small"
              type={wrap ? 'primary' : 'default'}
              icon={<AlignLeftOutlined />}
              onClick={() => setWrap((w) => !w)}
            >
              换行
            </Button>
          )}
          <Button size="small" icon={<CopyOutlined />} onClick={copyCsv}>
            复制 CSV
          </Button>
          <Dropdown
            menu={{
              items: [
                { key: 'csv', label: '导出 CSV' },
                { key: 'json', label: '导出 JSON' },
              ],
              onClick: ({ key }) => download(key as 'csv' | 'json'),
            }}
          >
            <Button size="small" icon={<DownloadOutlined />}>
              导出
            </Button>
          </Dropdown>
        </Space>
      </div>
      <div className={wrap ? 'result-table-wrap result-table-wrap--wrap' : 'result-table-wrap'} ref={wrapRef}>
        <Table
          size="small"
          bordered
          showSorterTooltip={false}
          columns={columns}
          components={{ header: { cell: HeaderCell, wrapper: FilterHeaderWrapper } }}
          dataSource={dataSource}
          rowKey="__key"
          onRow={onRowClick
            ? (record) => ({ onClick: () => onRowClick(record), style: { cursor: 'pointer' } })
            : undefined}
          onChange={(_pagination, _filters, sorter) => {
            if (!onQuery) return;
            const s = Array.isArray(sorter) ? sorter[0] : sorter;
            const next = s?.field && s.order
              ? { column: String(s.field), order: s.order === 'ascend' ? ('asc' as const) : ('desc' as const) }
              : null;
            setSort(next);
            onQuery({ filters: nonEmptyFilters(), sort: next });
          }}
          virtual
          pagination={false}
          scroll={{ x: Math.max(columns.reduce((s, c) => s + (typeof c.width === 'number' ? c.width : 200), 0), 320), y: bodyHeight, scrollToFirstRowOnChange: true }}
        />
      </div>
      {result.rows.length > 0 && (
        <div className="result-pagination">
          <Pagination
            current={page}
            pageSize={pageSize}
            total={result.rows.length}
            showSizeChanger
            pageSizeOptions={[10, 50, 100, 200, 500, 1000, 2000]}
            showTotal={(t, range) => `第 ${range[0]}-${range[1]} 行 / 共 ${t} 行`}
            onChange={(p, ps) => {
              setPage(p);
              setPageSize(ps);
              if (ps !== pageSize) onPageSizeChange?.(ps);
            }}
          />
        </div>
      )}
    </div>
    </FilterHeaderContext.Provider>
  );
}

