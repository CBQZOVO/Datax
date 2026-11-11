import { loadConfig } from '../config.js';
import type { AuditResult } from '../types.js';

/**
 * SQL 安全审计：内置规则引擎（强约束，无 AI 也可用）
 * + LLM 深度审计（OpenAI 兼容协议，可选）。
 * 最终风险等级取两者最高。
 */

// ============ 轻量 SQL 词法处理 ============

/** 去掉字符串字面量、反引号标识符、注释，返回可用于关键字分析的空格化文本 */
export function stripLiterals(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    // 行注释
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (ch === '#') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    // MySQL /*! ... */ 是可执行注释，必须保留内部 SQL 参与审计
    if (ch === '/' && sql[i + 1] === '*' && sql[i + 2] === '!') {
      i += 3;
      while (i < n && /[0-9]/.test(sql[i])) i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === '*' && sql[i + 1] === '/') {
      i += 2;
      out += ' ';
      continue;
    }
    // 字符串
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < n && sql[i] !== quote) {
        if (sql[i] === '\\') i++;
        i++;
      }
      i++;
      out += ' ';
      continue;
    }
    // 反引号标识符
    if (ch === '`') {
      i++;
      while (i < n && sql[i] !== '`') {
        if (sql[i] === '\\') i++;
        i++;
      }
      i++;
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export interface ParsedStatements {
  statements: string[];
  isMulti: boolean;
}

/** 按分号切分语句（已剥离字面量），过滤空语句 */
export function splitStatements(sql: string): ParsedStatements {
  const stripped = stripLiterals(sql);
  const parts = stripped
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { statements: parts, isMulti: parts.length > 1 };
}

interface StatementInfo {
  verb: string; // SELECT / UPDATE / DELETE / ...
  hasWhere: boolean;
  full: string;
}

function analyzeStatement(stmt: string): StatementInfo {
  const full = stmt;
  const upper = stmt.toUpperCase();
  // 找首个字母 token 作为动词
  const tokens = stmt.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const verb = tokens[0] ? tokens[0].toUpperCase() : '';
  // 粗略判断是否含 WHERE（出现在 UPDATE/DELETE/SELECT 之后）
  let hasWhere = /\bWHERE\b/.test(upper);
  // 更精确：WHERE 必须在语句主体内且不在子查询中（简化：只要顶层有 WHERE 关键字即认为有）
  return { verb, hasWhere, full };
}

// ============ 规则引擎 ============

const HIGH_RULES: { name: string; test: (s: StatementInfo, sql: string) => boolean }[] = [
  {
    name: 'DROP_TABLE_OR_DB',
    test: (s) => s.verb === 'DROP',
  },
  {
    name: 'TRUNCATE',
    test: (s) => s.verb === 'TRUNCATE',
  },
  {
    name: 'ALTER_STRUCTURE',
    test: (s) => s.verb === 'ALTER',
  },
  {
    name: 'DELETE_WITHOUT_WHERE',
    test: (s) => s.verb === 'DELETE' && !s.hasWhere,
  },
  {
    name: 'UPDATE_WITHOUT_WHERE',
    test: (s) => s.verb === 'UPDATE' && !s.hasWhere,
  },
  {
    name: 'PRIVILEGE_CHANGE',
    test: (s) => s.verb === 'GRANT' || s.verb === 'REVOKE',
  },
  {
    name: 'MULTI_STATEMENT_INJECTION',
    test: (_s, sql) => splitStatements(sql).isMulti,
  },
  {
    name: 'FILE_WRITE_READ',
    test: (s, sql) => /\bINTO\s+OUTFILE\b|\bINTO\s+DUMPFILE\b|\bLOAD_FILE\s*\(|\bLOAD\s+DATA\b|\bCOPY\b/i.test(s.full),
  },
  {
    name: 'SLEEP_OR_BENCHMARK_ATTACK',
    test: (s) => /\bSLEEP\s*\(|\bBENCHMARK\s*\(|\bPG_SLEEP\s*\(|\bWAITFOR\s+DELAY/i.test(s.full),
  },
  {
    name: 'SYSTEM_COMMAND',
    test: (s) => /\bSYS_EXEC\b|\bXP_CMDSHELL\b|\bEXEC\s+\w+\s+AT\b/i.test(s.full),
  },
];

const MEDIUM_RULES: { name: string; test: (s: StatementInfo) => boolean }[] = [
  {
    name: 'UPDATE_WITH_WHERE',
    test: (s) => s.verb === 'UPDATE' && s.hasWhere,
  },
  {
    name: 'DELETE_WITH_WHERE',
    test: (s) => s.verb === 'DELETE' && s.hasWhere,
  },
  {
    name: 'INSERT_OR_REPLACE',
    test: (s) => s.verb === 'INSERT' || s.verb === 'REPLACE' || s.verb === 'MERGE',
  },
  {
    name: 'CREATE_OBJECT',
    test: (s) => s.verb === 'CREATE',
  },
  {
    name: 'TRANSACTION_CONTROL',
    test: (s) => s.verb === 'BEGIN' || s.verb === 'COMMIT' || s.verb === 'ROLLBACK',
  },
  {
    name: 'MISSING_LIMIT',
    test: (s) => {
      if (s.verb !== 'SELECT') return false;
      const upper = s.full.toUpperCase();
      // 已经有 LIMIT / OFFSET / TOP / FETCH FIRST 视为有分页
      if (/\bLIMIT\b|\bOFFSET\b|\bTOP\s+\d+|\bFETCH\s+(FIRST|NEXT)\b/.test(upper)) return false;
      // 只看存在 FROM 的查询
      return /\bFROM\b/.test(upper);
    },
  },
  {
    name: 'LARGE_BATCH_INSERT',
    test: (s) => {
      if (s.verb !== 'INSERT') return false;
      // 估算 VALUES 中元组数：粗略统计顶级括号对
      const m = s.full.match(/VALUES\s+([\s\S]+)$/i);
      if (!m) return false;
      // 数 "(...)" 顶层出现次数：按 VALUES 段中 ",(" 分隔
      const segment = m[1].split(/\)\s*,\s*\(/).length;
      return segment >= 50;
    },
  },
];

// 性能提示规则：不升级风险等级，只产出 findings + suggestions
const PERF_RULES: { name: string; message: string; suggestion: string; test: (s: StatementInfo) => boolean }[] = [
  {
    name: 'NO_PAGINATION',
    message: '未使用 LIMIT/OFFSET 分页，结果集可能非常大',
    suggestion: '建议加上 LIMIT 限制返回行数，或使用分页查询',
    test: (s) => {
      if (s.verb !== 'SELECT') return false;
      const upper = s.full.toUpperCase();
      if (/\bLIMIT\b|\bOFFSET\b|\bTOP\s+\d+|\bFETCH\s+(FIRST|NEXT)\b/.test(upper)) return false;
      return /\bFROM\b/.test(upper);
    },
  },
  {
    name: 'BULK_INSERT',
    message: '检测到大批量 INSERT，可能影响事务和锁等待',
    suggestion: '建议分批提交（每批 1000 行左右），并避免在高峰时段执行',
    test: (s) => {
      if (s.verb !== 'INSERT') return false;
      const m = s.full.match(/VALUES\s+([\s\S]+)$/i);
      if (!m) return false;
      const tuples = m[1].split(/\)\s*,\s*\(/).length;
      return tuples >= 50;
    },
  },
];

/**
 * 把字符串字面量替换成 ''，保留反引号标识符与其余骨架；引号未闭合返回 null。
 * 与 stripLiterals 不同：这里不能抹掉标识符，否则无法校验 ALTER 的目标对象。
 */
function maskStringLiterals(sql: string): string | null {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2; // '' / "" 转义
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return null;
      out += "''";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 「仅修改注释」的 ALTER，供 agent 元数据维护通道使用。
 *
 * 只放行两种形态，且要求剥离字符串后的骨架完整匹配，骨架里不得出现
 * 分号、注释符、顶层逗号（即第二个 DDL 动作）或危险关键字：
 *   ALTER TABLE `db`.`t` COMMENT = '...'
 *   ALTER TABLE `db`.`t` MODIFY [COLUMN] `c` <列定义> COMMENT '...'
 *
 * 注意：本函数不改动 ruleEngine 的判定，普通用户走审计/确认流时
 * 任意 ALTER 仍是 high；只有开启写权限的 agent 通道会用本函数开窄口子。
 */
export function isCommentOnlyAlter(sql: string): boolean {
  const src = sql.trim();
  if (!src || src.length > 4096) return false;
  const masked = maskStringLiterals(src);
  if (masked === null) return false;
  const s = masked.replace(/;\s*$/, '').trim();
  if (/[;#]|--|\/\*|\*\//.test(s)) return false;

  // 括号内的逗号属于 decimal(28,8) / enum(...) / 默认值表达式；
  // 顶层逗号意味着拼接了第二个 DDL 动作，一律拒绝。
  let flat = s;
  while (/\([^()]*\)/.test(flat)) {
    flat = flat.replace(/\([^()]*\)/g, (m) => m.replace(/[(),]/g, '\u0000'));
  }
  if (flat.includes(',')) return false;

  const ident = '(?:`[A-Za-z0-9_$]+`|[A-Za-z0-9_$]+)';
  const table = `${ident}(?:\\s*\\.\\s*${ident})?`;
  if (new RegExp(`^ALTER\\s+TABLE\\s+${table}\\s+COMMENT\\s*=\\s*''\\s*$`, 'i').test(s)) return true;

  const m = new RegExp(
    `^ALTER\\s+TABLE\\s+${table}\\s+MODIFY\\s+(?:COLUMN\\s+)?${ident}\\s+(.+?)\\s+COMMENT\\s+''\\s*$`,
    'i'
  ).exec(s);
  if (!m) return false;
  // 列定义里不允许出现第二个 DDL 动作、子查询、文件或延时函数
  return !/\b(?:ADD|DROP|RENAME|CHANGE|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|SELECT|INSERT|DELETE|REPLACE|CALL|EXEC|EXECUTE|PREPARE|PARTITION|EXCHANGE|DISCARD|IMPORT|COALESCE|REORGANIZE|ANALYZE|OPTIMIZE|REPAIR|LOCK|ALGORITHM|PRIMARY|FOREIGN|CONSTRAINT|KEY|INDEX|FIRST|AFTER|OUTFILE|DUMPFILE|LOAD_FILE|SLEEP|BENCHMARK)\b/i.test(m[1]);
}

export function ruleEngine(sql: string): { riskLevel: AuditResult['riskLevel']; rulesHit: string[]; findings: AuditResult['findings']; suggestions: string[] } {
  const { statements, isMulti } = splitStatements(sql);
  const rulesHit: string[] = [];
  const findings: AuditResult['findings'] = [];
  const suggestions: string[] = [];

  let level: AuditResult['riskLevel'] = 'low';
  for (const stmt of statements) {
    const info = analyzeStatement(stmt);
    for (const r of HIGH_RULES) {
      if (r.test(info, sql)) {
        rulesHit.push(r.name);
        level = 'high';
        findings.push({ severity: 'high', message: `高危规则命中：${r.name}` });
      }
    }
    for (const r of MEDIUM_RULES) {
      if (level === 'high') break;
      if (r.test(info)) {
        rulesHit.push(r.name);
        level = 'medium';
        findings.push({ severity: 'medium', message: `中危规则命中：${r.name}` });
      }
    }
    for (const r of PERF_RULES) {
      if (r.test(info)) {
        rulesHit.push(r.name);
        findings.push({ severity: 'low', message: r.message });
        suggestions.push(r.suggestion);
      }
    }
  }

  if (isMulti) {
    suggestions.push('检测到多条语句，请确认是否为恶意拼接的 SQL 注入');
  }
  if (isWriteStatement(sql) && statements.some((statement) => analyzeStatement(statement).verb === 'WITH')) {
    rulesHit.push('WRITE_CTE');
    findings.push({ severity: 'high', message: '高危规则命中：WRITE_CTE' });
    suggestions.push('检测到包含写操作的 CTE，请确认实际影响范围');
    level = 'high';
  }

  const dedupRulesHit = [...new Set(rulesHit)];
  if (level === 'high') {
    suggestions.push('建议在执行前使用 EXPLAIN 查看执行计划，并二次确认');
  }
  if (level === 'low') {
    suggestions.push('语句为只读查询，风险较低');
  }

  return { riskLevel: level, rulesHit: dedupRulesHit, findings, suggestions };
}

// ============ LLM 审计（OpenAI 兼容） ============

/** 可用 chat/completions URL 缓存：baseURL → 已验证可用的完整地址，避免每条 SQL 都双倍超时探测 */
const chatUrlCache = new Map<string, string>();

/** LLM 全局并发上限：防止多用户同时提交写 SQL 时打满模型配额 */
const MAX_LLM_CONCURRENCY = 3;
let llmRunning = 0;
const llmQueue: (() => void)[] = [];

async function withLlmSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (llmRunning >= MAX_LLM_CONCURRENCY) {
    await new Promise<void>((resolve) => llmQueue.push(resolve));
  }
  llmRunning++;
  try {
    return await fn();
  } finally {
    // 名额直接转交给队首等待者：若先递减再由等待者自增，
    // 唤醒间隙内新调用者会看到空位，实际并发可突破上限
    const next = llmQueue.shift();
    if (next) {
      next();
    } else {
      llmRunning--;
    }
  }
}

function candidateUrls(baseURL: string): string[] {
  const urls = [`${baseURL}/chat/completions`];
  if (!/\/v1$/.test(baseURL)) urls.push(`${baseURL}/v1/chat/completions`);
  const cached = chatUrlCache.get(baseURL);
  return cached ? [cached, ...urls.filter((u) => u !== cached)] : urls;
}

interface ChatOk { ok: true; content: string }
interface ChatFail { ok: false; error: string }

/** 调用 OpenAI 兼容 chat/completions；baseURL 未带 /v1 时自动兜底探测并缓存可用地址 */
async function chatCompletion(
  cfg: { baseURL: string; apiKey: string; model: string; timeoutMs: number },
  messages: { role: string; content: string }[],
  opts?: { temperature?: number; jsonMode?: boolean }
): Promise<ChatOk | ChatFail> {
  let lastError = '未知错误';
  for (const url of candidateUrls(cfg.baseURL)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: opts?.temperature ?? 0.1,
          ...(opts?.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        lastError = `HTTP ${resp.status}`;
        continue;
      }
      const data = (await resp.json()) as {
        choices?: { message?: { content?: string | null } }[];
      };
      const text = (data.choices?.[0]?.message?.content ?? '').trim();
      if (!text) {
        lastError = '模型返回为空';
        continue;
      }
      chatUrlCache.set(cfg.baseURL, url);
      return { ok: true, content: text };
    } catch (e) {
      lastError = e instanceof Error && e.name === 'AbortError'
        ? `AI 响应超时（>${cfg.timeoutMs}ms）`
        : e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: lastError };
}

interface LlmAuditResponse {
  riskLevel: 'low' | 'medium' | 'high';
  summary: string;
  findings: { severity: 'low' | 'medium' | 'high'; message: string }[];
  suggestions: string[];
}

async function llmAudit(sql: string, databaseType: string, tableNames: string[]): Promise<LlmAuditResponse | null> {
  const cfg = loadConfig().ai;
  if (!cfg.apiKey || !cfg.baseURL) return null;

  const systemPrompt = `你是企业数据库安全审计专家。对用户提交的 SQL 进行安全风险评估。
只输出 JSON，不要输出任何其他文字。JSON 格式必须严格为：
{"riskLevel":"low|medium|high","summary":"一句话结论","findings":[{"severity":"low|medium|high","message":"具体风险点"}],"suggestions":["建议1","建议2"]}
评判标准：
- high: 删除/清空/改表结构/无 WHERE 的 UPDATE 或 DELETE/权限变更/写文件/延时注入/多语句拼接注入
- medium: 带 WHERE 的写操作/大批量 INSERT/建表建索引/事务控制
- low: 只读查询
同时给出 findings 包含性能/最佳实践问题，例如：
- SELECT 未使用 LIMIT，可能拉取全表
- SELECT * 应改为具体列
- 大批量 INSERT 建议分批
- 缺少 WHERE 过滤的全表扫描
数据库类型: ${databaseType}。已知表: ${tableNames.join(', ') || '未知'}。`;

  // 优先使用缓存的可调用地址；baseURL 未带 /v1（如 …/llm）时兜底尝试 /v1/chat/completions
  const res = await withLlmSlot(() => chatCompletion(cfg, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `请审计以下 SQL：\n${sql.slice(0, 8000)}` },
  ], { jsonMode: true }));
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.content) as LlmAuditResponse;
    if (!['low', 'medium', 'high'].includes(parsed.riskLevel)) return null;
    if (!Array.isArray(parsed.findings) || !Array.isArray(parsed.suggestions) || typeof parsed.summary !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 把原始 SQL 与数据库报错交给 LLM，生成中文错误解释与修改建议。
 * 未配置 AI 或调用失败返回 null，调用方静默降级到本地规则提示。
 */
export async function llmExplainSqlError(sql: string, rawError: string): Promise<string | null> {
  const cfg = loadConfig().ai;
  if (!cfg.apiKey || !cfg.baseURL) return null;

  const systemPrompt = `你是资深 DBA。用户的 SQL 在数据库预检查/执行时报错了。
请用中文直接指出错误原因，并给出修正后的 SQL 或具体修改建议。
要求：不超过 200 字；先说结论再给改法；不要复述整条原始 SQL；输出纯文本，不要 Markdown。`;

  const res = await withLlmSlot(() => chatCompletion(cfg, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `SQL：\n${sql.slice(0, 4000)}\n\n数据库报错：\n${rawError.slice(0, 1000)}` },
  ]));
  return res.ok ? res.content.slice(0, 600) : null;
}

/**
 * 用 LLM 分析慢 SQL 的原因与优化建议。
 * 成功返回分析文本；未配置 AI 或调用失败抛错（错误信息可直接展示给用户）。
 */
export async function llmAnalyzeSlowSql(input: {
  sql: string;
  elapsedMs: number;
  databaseType: string;
  result: string;
  /** 真实证据：表结构/索引/EXPLAIN 计划，或 ES mapping/settings/规模；空 = 无 */
  context?: string;
}): Promise<string> {
  const cfg = loadConfig().ai;
  if (!cfg.apiKey || !cfg.baseURL) {
    throw new Error('未配置 AI（系统管理 → AI 配置），无法分析');
  }

  // ES 搜索与 SQL 用不同视角分析：ES 的"审计语句"是搜索参数 JSON，不是 SQL
  const isEs = input.databaseType === 'elasticsearch';
  const systemPrompt = isEs
    ? `你是 Elasticsearch 调优专家。用户的一次 ES 搜索请求耗时过长，请求参数（JSON）如下。请用中文分析：
1. 慢的可能原因（结合参数判断：索引数据量大、通配符匹配了过多索引、缺少时间范围过滤、查询词过于宽泛、返回字段过多或单条过大、size 过大、集群负载高等；不要臆造）
2. 给出具体优化建议（如：加时间范围过滤、缩小返回字段、减小 size、按日期索引收敛匹配范围、拆分大索引等）
要求：总共不超过 200 字，分点陈述，纯文本不要 Markdown。`
    : `你是资深 DBA。用户给你一条执行缓慢的 SQL，请用中文分析：
1. 慢的可能原因（结合 SQL 结构判断：缺索引、全表扫描、排序或函数导致索引失效、返回数据量过大、多表连接方式不佳等；不要臆造表结构和数据）
2. 给出具体可执行的优化建议（建什么索引、如何改写 SQL）
要求：总共不超过 200 字，分点陈述，纯文本不要 Markdown。`;

  const res = await withLlmSlot(() => chatCompletion(cfg, [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `数据库类型：${input.databaseType}\n实际耗时：${input.elapsedMs}ms\n执行结果：${input.result.slice(0, 200)}\n${isEs ? '搜索请求参数' : 'SQL'}：\n${input.sql.slice(0, 4000)}\n\n参考信息（真实环境证据，请优先据此分析，不要臆造）：\n${input.context?.slice(0, 6000) || '（无）'}`,
    },
  ], { temperature: 0.2 }));
  if (res.ok) return res.content.slice(0, 800);
  throw new Error(`AI 调用失败（${res.error}），请稍后重试`);
}

// ============ 编排 ============

export async function auditSql(sql: string, databaseType: string, tableNames: string[] = []): Promise<AuditResult> {
  const rule = ruleEngine(sql);

  // strict 模式下 LLM 只做增强；off 模式不调用 LLM
  const mode = loadConfig().ai.auditMode;
  if (mode === 'off') {
    return { ...rule, source: 'rule', summary: rule.findings.map((f) => f.message).join('；') || '未发现明显风险' };
  }

  // 只读语句跳过 LLM：纯读没有破坏面，SELECT 等不必等一次 LLM 往返才开跑
  if (!isWriteStatement(sql)) {
    return { ...rule, source: 'rule', summary: rule.findings.map((f) => f.message).join('；') || '未发现明显风险' };
  }

  const llm = await llmAudit(sql, databaseType, tableNames);
  if (!llm) {
    return { ...rule, source: 'rule', summary: rule.findings.map((f) => f.message).join('；') || '未发现明显风险' };
  }

  // 合并：风险等级取最高，findings 合并去重
  const levelRank = { low: 0, medium: 1, high: 2 } as const;
  const combinedLevel: AuditResult['riskLevel'] =
    levelRank[rule.riskLevel] >= levelRank[llm.riskLevel] ? rule.riskLevel : llm.riskLevel;

  const findings = [...rule.findings];
  const seen = new Set(rule.findings.map((f) => f.message));
  for (const f of llm.findings ?? []) {
    if (!seen.has(f.message)) {
      seen.add(f.message);
      findings.push(f);
    }
  }
  const suggestions = [...new Set([...rule.suggestions, ...(llm.suggestions ?? [])])];

  return {
    riskLevel: combinedLevel,
    summary: llm.summary || rule.findings.map((f) => f.message).join('；') || '未发现明显风险',
    findings,
    suggestions,
    rulesHit: [...new Set([...rule.rulesHit, ...llm.findings.filter((f) => f.severity === 'high').map((f) => `llm:${f.message}`)])],
    source: 'both',
  };
}

/** 判断是否为写操作（需要 EXPLAIN 预查询的） */
export function isWriteStatement(sql: string): boolean {
  const { statements } = splitStatements(sql);
  const writeVerbs = new Set([
    'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'DROP', 'TRUNCATE', 'ALTER',
    'CREATE', 'GRANT', 'REVOKE', 'CALL', 'DO', 'EXEC', 'EXECUTE',
  ]);
  return statements.some((statement) => {
    const info = analyzeStatement(statement);
    if (writeVerbs.has(info.verb)) return true;
    if (info.verb === 'WITH') {
      // CTE 写检测：剥离字符串字面量后全文查写动词。
      // 不依赖「UPDATE x SET」形态（PG 的 UPDATE ONLY / 引号表名可绕过正则）；
      // CTE 的 SELECT 部分不会出现独立写动词，仅列名/标识符撞名时误判为写（安全方向的误判）。
      if (/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(stripLiterals(info.full))) return true;
    }
    return false;
  });
}
