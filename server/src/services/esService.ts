import { decryptSecret } from '../db/store.js';
import type { DataSource } from '../types.js';

/**
 * Elasticsearch 只读查询服务。
 * 基于原生 fetch（Node 18+），Basic auth，无连接池、无新依赖。
 * 仅暴露 test / listIndices / search 三个只读能力。
 */

export interface EsIndexInfo {
  name: string;
  docs: number;
}

export interface EsSearchOptions {
  index: string;
  q?: string;
  qField?: string;
  /** 多条件过滤：每条 field 对 value 做包含匹配（match_phrase），条件间 AND */
  conditions?: { field: string; value: string }[];
  start?: string;
  end?: string;
  /** 时间范围字段名，默认 @timestamp（业务索引可用自己的时间字段） */
  timeField?: string;
  fields?: string[];
  sort?: string;
  size?: number;
  lines?: boolean;
}

export interface EsSearchHit {
  [field: string]: unknown;
}

export interface EsSearchResult {
  total: number;
  hits: EsSearchHit[];
  lines?: string[];
}

const INDEX_NAME_RE = /^[a-zA-Z0-9_.*-]+$/;
const SORT_RE = /^[\w.@-]+:(asc|desc)$/i;

function baseUrl(ds: DataSource): string {
  // host 支持完整 baseURL（https://es.example.com）或纯主机名
  const host = ds.host.trim();
  const scheme = host.startsWith('http://') || host.startsWith('https://') ? '' : 'http://';
  return `${scheme}${host}:${ds.port}`.replace(/\/+$/, '');
}

function authHeader(ds: DataSource): string {
  const cred = `${ds.username}:${decryptSecret(ds.passwordEnc)}`;
  return `Basic ${Buffer.from(cred).toString('base64')}`;
}

async function esFetch(
  ds: DataSource,
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
  method?: 'GET' | 'POST' | 'DELETE'
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl(ds)}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        Authorization: authHeader(ds),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`ES ${res.status}: ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

/** 校验时间参数：ISO 8601 或 yyyy-MM-dd；否则拒绝（ES/Date.parse 均按 UTC 解释无时区输入） */
function assertTime(value: string, name: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`参数 ${name} 不是合法的 ISO 8601 / yyyy-MM-dd 时间：${value}`);
  }
}

/** 把 _source 递归展平为点路径键（如 json.level）；数组转 JSON 字符串 */
function flattenSource(src: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (src === null || typeof src !== 'object') {
    if (prefix) out[prefix] = src ?? null;
    return out;
  }
  if (Array.isArray(src)) {
    out[prefix] = JSON.stringify(src);
    return out;
  }
  for (const [k, v] of Object.entries(src)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      flattenSource(v, path, out);
    } else {
      out[path] = Array.isArray(v) ? JSON.stringify(v) : v;
    }
  }
  return out;
}

/** 从 mapping 递归收集叶子字段点路径；兼容 ES6/7 带 type 的 mappings.<type>.properties 结构 */
function collectMappingPaths(node: Record<string, unknown>, prefix = '', out: Set<string> = new Set()): Set<string> {
  const props = node.properties;
  if (props && typeof props === 'object') {
    for (const [name, def] of Object.entries(props as Record<string, unknown>)) {
      if (def === null || typeof def !== 'object') continue;
      const path = prefix ? `${prefix}.${name}` : name;
      const d = def as Record<string, unknown>;
      if (d.properties && typeof d.properties === 'object') {
        collectMappingPaths(d, path, out);
      } else {
        out.add(path);
      }
    }
    return out;
  }
  // 旧版 mapping：mappings 下先是一层 type 名，再是 properties
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      collectMappingPaths(value as Record<string, unknown>, prefix, out);
    }
  }
  return out;
}

export class EsService {
  /** 连接测试：GET / */
  async test(ds: DataSource): Promise<void> {
    const res = (await esFetch(ds, '/')) as { cluster_name?: string } | null;
    if (!res || typeof res !== 'object') {
      throw new Error('ES 响应异常：根路径未返回集群信息');
    }
  }

  /** 索引列表（可选 pattern 前缀过滤） */
  async listIndices(ds: DataSource, pattern?: string): Promise<EsIndexInfo[]> {
    const res = (await esFetch(ds, '/_cat/indices?h=index,docs.count&format=json')) as { index: string; 'docs.count': string | number }[];
    let list = Array.isArray(res) ? res : [];
    if (pattern) {
      const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')}$`);
      list = list.filter((it) => re.test(it.index));
    }
    return list
      .map((it) => ({ name: it.index, docs: Number(it['docs.count']) || 0 }))
      // 按名称倒序：日期后缀索引（xxx-YYYY.MM.DD）最新的排最前
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  /** 字段列表：GET /{index}/_mapping，返回展平后的叶子字段点路径（升序） */
  async listFields(ds: DataSource, index: string): Promise<string[]> {
    if (!INDEX_NAME_RE.test(index)) {
      throw new Error(`非法索引名：${index}（仅允许字母数字 _ . * -）`);
    }
    const res = (await esFetch(ds, `/${encodeURIComponent(index)}/_mapping`)) as Record<
      string,
      { mappings?: { properties?: Record<string, unknown> } }
    >;
    const paths = new Set<string>();
    for (const entry of Object.values(res ?? {})) {
      const mappings = entry?.mappings;
      if (mappings && typeof mappings === 'object') {
        collectMappingPaths(mappings as Record<string, unknown>, '', paths);
      }
    }
    return [...paths].sort((a, b) => a.localeCompare(b));
  }

  /** 索引关键 Settings：分片数、副本数、刷新间隔（供慢查询分析参考） */
  async getIndexSettings(ds: DataSource, index: string): Promise<Record<string, unknown>> {
    if (!INDEX_NAME_RE.test(index)) {
      throw new Error(`非法索引名：${index}（仅允许字母数字 _ . * -）`);
    }
    const res = (await esFetch(ds, `/${encodeURIComponent(index)}/_settings?flat_settings=true`)) as Record<
      string,
      { settings?: Record<string, unknown> }
    >;
    const out: Record<string, unknown> = {};
    for (const entry of Object.values(res ?? {})) {
      const s = entry?.settings ?? {};
      for (const key of ['index.number_of_shards', 'index.number_of_replicas', 'index.refresh_interval']) {
        if (s[key] !== undefined) out[key] = s[key];
      }
    }
    return out;
  }

  /** 原生 DSL 查询：POST /{index}/_search，body 原样透传（强制 size 上限 2000） */
  async searchDsl(ds: DataSource, index: string, dsl: Record<string, unknown>): Promise<EsSearchResult> {
    if (!INDEX_NAME_RE.test(index)) {
      throw new Error(`非法索引名：${index}（仅允许字母数字 _ . * -）`);
    }
    const body: Record<string, unknown> = {
      ...dsl,
      size: Math.min(Math.max(Number(dsl.size ?? 20) || 20, 1), 2000),
    };
    const res = (await esFetch(ds, `/${encodeURIComponent(index)}/_search`, body)) as {
      hits: {
        total: { value: number } | number;
        hits: { _id: string; _index: string; _source: Record<string, unknown> }[];
      };
    };
    const total = typeof res.hits.total === 'number' ? res.hits.total : res.hits.total.value;
    return {
      total,
      // __ 前缀为内部元数据（供前端「删除此行」定位文档），表格列不展示
      hits: res.hits.hits.map((h) => ({
        ...flattenSource(h._source),
        __id: h._id,
        __index: h._index,
      })),
    };
  }

  /** 按 _id 删除单条文档；index 必须是具体索引（非通配视图） */
  async deleteById(ds: DataSource, index: string, id: string): Promise<number> {
    if (!INDEX_NAME_RE.test(index) || index.includes('*')) {
      throw new Error('删除文档须指定具体索引（不允许通配视图）');
    }
    const res = (await esFetch(
      ds, `/${encodeURIComponent(index)}/_doc/${encodeURIComponent(id)}`,
      undefined, 30_000, 'DELETE'
    )) as { result?: string };
    return res?.result === 'deleted' ? 1 : 0;
  }

  /** 条件删除前预估匹配条数（_count，不产生变更） */
  async countByQuery(ds: DataSource, index: string, dsl: Record<string, unknown>): Promise<number> {
    if (!INDEX_NAME_RE.test(index)) throw new Error(`非法索引名：${index}`);
    const res = (await esFetch(ds, `/${encodeURIComponent(index)}/_count`, { query: dsl.query })) as { count?: number };
    return Number(res?.count ?? 0);
  }

  /** 按条件删除（_delete_by_query），maxDocs 为硬上限，防止误删海量文档 */
  async deleteByQuery(ds: DataSource, index: string, dsl: Record<string, unknown>, maxDocs: number): Promise<number> {
    if (!INDEX_NAME_RE.test(index)) throw new Error(`非法索引名：${index}`);
    const res = (await esFetch(
      ds, `/${encodeURIComponent(index)}/_delete_by_query?conflicts=proceed&refresh=true`,
      { ...dsl, max_docs: maxDocs }
    )) as { deleted?: number };
    return Number(res?.deleted ?? 0);
  }

  /** 参数化搜索：后端拼 DSL，q → match_phrase(qField)，时间 → @timestamp range */
  async search(ds: DataSource, opts: EsSearchOptions): Promise<EsSearchResult> {
    if (!INDEX_NAME_RE.test(opts.index)) {
      throw new Error(`非法索引名：${opts.index}（仅允许字母数字 _ . * -）`);
    }
    const qField = opts.qField?.trim() || 'log';
    const timeField = opts.timeField?.trim() || '@timestamp';
    // 未指定 fields：返回全字段（展平）；lines 模式无 fields 时退回默认两列，避免拼接出超长行
    const fields = opts.fields?.length
      ? opts.fields
      : (opts.lines ? ['@timestamp', 'log'] : null);
    const size = Math.min(Math.max(opts.size ?? 20, 1), 2000);
    const sort = opts.sort?.trim() || '@timestamp:desc';
    if (!SORT_RE.test(sort)) {
      throw new Error(`非法排序参数：${sort}（格式 field:asc|desc）`);
    }
    if (opts.start) assertTime(opts.start, 'start');
    if (opts.end) assertTime(opts.end, 'end');

    const must: unknown[] = [];
    const filter: unknown[] = [];
    if (opts.q !== undefined && opts.q.trim() !== '') {
      must.push({ match_phrase: { [qField]: opts.q } });
    }
    for (const cond of opts.conditions ?? []) {
      must.push({ match_phrase: { [cond.field]: cond.value } });
    }
    if (opts.start || opts.end) {
      const range: Record<string, string> = {};
      if (opts.start) range.gte = opts.start;
      if (opts.end) range.lt = opts.end;
      filter.push({ range: { [timeField]: range } });
    }

    // unmapped_type：索引没有该排序字段时不报错，历史/业务索引也能用同一套参数
    const [sortField, sortOrder] = sort.split(':');
    const sortClause = sortField === '_doc'
      ? { _doc: { order: sortOrder.toLowerCase() } }
      : { [sortField]: { order: sortOrder.toLowerCase(), unmapped_type: 'date' } };

    const body = {
      size,
      sort: [sortClause],
      ...(fields ? { _source: fields } : {}),
      query: must.length + filter.length > 0
        ? { bool: { ...(must.length ? { must } : {}), ...(filter.length ? { filter } : {}) } }
        : { match_all: {} },
    };

    const res = (await esFetch(ds, `/${encodeURIComponent(opts.index)}/_search`, body)) as {
      hits: {
        total: { value: number } | number;
        hits: { _id: string; _index: string; _source: Record<string, unknown> }[];
      };
    };
    const total = typeof res.hits.total === 'number' ? res.hits.total : res.hits.total.value;
    const hits: EsSearchHit[] = res.hits.hits.map((h) => {
      const flat = flattenSource(h._source);
      // __ 前缀为内部元数据（供前端「删除此行」定位文档），表格列不展示
      const meta: EsSearchHit = { __id: h._id, __index: h._index };
      if (!fields) return { ...flat, ...meta };
      const out: EsSearchHit = { ...meta };
      for (const field of fields) {
        out[field] = flat[field] ?? null;
      }
      return out;
    });

    if (opts.lines && fields) {
      return {
        total,
        hits,
        lines: hits.map((hit) => fields.map((f) => (hit[f] === null || hit[f] === undefined ? '' : String(hit[f]))).join(' | ')),
      };
    }
    return { total, hits };
  }
}

const service = new EsService();
export function esService(): EsService {
  return service;
}
