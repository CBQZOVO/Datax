/**
 * 键值检索语法解析器（KQL 极简子集）。
 *
 * 目标：把 ES 日志检索从「单字段精确短语」升级到「field:value 键值 + 布尔 + 范围 + 通配」，
 * 同时保持纯函数、零依赖、可单测，输出可安全拼进 ES bool DSL 的结构化片段。
 *
 * 语法（空格分隔 token，token 之间为 AND）：
 *   field:value          键值匹配（value 含 * 为通配，否则 match_phrase 包含匹配）
 *   -field:value         排除（must_not）
 *   -token               排除裸词（默认字段）
 *   field:>500           范围比较（>= <= > <，操作符与值之间不加空格）
 *   "短语 含空格"         引号包裹的 value（可含空格，引号内特殊符号不参与解析）
 *
 * 刻意不做（追稳不追花哨）：
 *   - OR / 括号 / 嵌套布尔（优先级歧义是解析器 bug 高发区，首版只做 AND + NOT）
 *   - [1 TO 100] 区间语法（用 >= 与 <= 组合即可）
 *   - 大小写不敏感（兼容 ES6：wildcard 不带 case_insensitive 参数）
 */

export interface QueryFragment {
  must: unknown[];
  must_not: unknown[];
  filter: unknown[];
}

const FIELD_RE = /^[\w.@-]+$/;
/** 范围比较：操作符 >= <= > <，值不允许为空 */
const RANGE_RE = /^(>=|<=|>|<)(.+)$/;
const RANGE_OP: Record<string, 'gt' | 'gte' | 'lt' | 'lte'> = {
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
};

function validateField(field: string): void {
  if (!FIELD_RE.test(field)) {
    throw new Error(`非法字段名：${field}（仅允许字母数字 _ . @ -）`);
  }
}

/** 通配符安全：前导通配（值以 * 开头）要求去掉 * 后至少 2 个具体字符，防全表扫描 */
function assertWildcardSafe(value: string): void {
  if (value.startsWith('*')) {
    const suffix = value.replace(/^\*+/, '');
    if (suffix.length < 2) {
      throw new Error(`通配符检索过于宽泛：${value}（前导通配须至少 2 个具体字符）`);
    }
  }
}

/** 切成 token；引号包裹的片段整体作为一个 token（value 可含空格）。引号未闭合抛错。 */
function tokenize(query: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < query.length) {
    while (i < query.length && /\s/.test(query[i])) i++;
    if (i >= query.length) break;
    let text = '';
    while (i < query.length && !/\s/.test(query[i])) {
      if (query[i] === '"') {
        i++; // 跳过开引号
        while (i < query.length && query[i] !== '"') {
          // 转义引号 \" → 字面引号
          if (query[i] === '\\' && query[i + 1] === '"') {
            text += '"';
            i += 2;
            continue;
          }
          text += query[i];
          i++;
        }
        if (i >= query.length) throw new Error(`引号未闭合：${query}`);
        i++; // 跳过闭引号
        continue;
      }
      text += query[i];
      i++;
    }
    if (text !== '') tokens.push(text);
  }
  return tokens;
}

export function parseQuery(query: string, defaultField: string): QueryFragment {
  const must: unknown[] = [];
  const must_not: unknown[] = [];
  const filter: unknown[] = [];

  for (const raw of tokenize(query.trim())) {
    let negated = false;
    let tok = raw;
    if (tok.startsWith('-')) {
      negated = true;
      tok = tok.slice(1);
      if (!tok) throw new Error('排除符 - 后缺少检索内容');
    }

    const colon = tok.indexOf(':');
    let field: string;
    let value: string;
    if (colon >= 0) {
      field = tok.slice(0, colon);
      value = tok.slice(colon + 1);
    } else {
      field = defaultField;
      value = tok;
    }

    validateField(field);
    if (value === '') throw new Error(`字段 ${field} 的值不能为空`);

    // 范围比较：仅 field: 形式下有意义
    const range = colon >= 0 ? value.match(RANGE_RE) : null;
    if (range) {
      const num = Number(range[2]);
      const v: number | string = Number.isFinite(num) && range[2].trim() !== '' ? num : range[2];
      const rangeClause: Record<string, number | string> = { [RANGE_OP[range[1]]]: v };
      (negated ? must_not : filter).push({ range: { [field]: rangeClause } });
      continue;
    }

    if (value.includes('*')) {
      assertWildcardSafe(value);
      (negated ? must_not : must).push({ wildcard: { [field]: { value } } });
      continue;
    }

    (negated ? must_not : must).push({ match_phrase: { [field]: value } });
  }

  return { must, must_not, filter };
}
