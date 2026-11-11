/**
 * 按顶层分号把 SQL 拆成多条语句（保留原文，可直接执行）。
 * 扫描规则与 aiAuditService.stripLiterals 一致（字符串/反引号/注释内不拆分），
 * 保证驱动实际执行的语句数与审计引擎 MULTI_STATEMENT_INJECTION 的计数一致。
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    // 行注释（-- 与 #）
    if ((ch === '-' && sql[i + 1] === '-') || ch === '#') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    // 块注释（含 MySQL 可执行注释 /*! ... * /，内部分号不参与拆分）
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // 字符串字面量
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < n && sql[i] !== quote) {
        if (sql[i] === '\\') i++;
        i++;
      }
      i++;
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
      continue;
    }
    // 顶层分号：切分
    if (ch === ';') {
      const part = sql.slice(start, i).trim();
      if (part.length > 0) out.push(part);
      i++;
      start = i;
      continue;
    }
    i++;
  }
  const tail = sql.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/** 取语句首个关键词（跳过前导注释），如 SELECT / UPDATE / INSERT */
export function leadingVerb(stmt: string): string {
  const clean = stmt.replace(/^\s*(?:--[^\n]*\n|#[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/, '');
  const m = /^([A-Za-z]+)\b/.exec(clean);
  return m ? m[1].toUpperCase() : '';
}
