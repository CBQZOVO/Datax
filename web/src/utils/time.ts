/**
 * 服务端时间统一存 SQLite datetime('now') 产出的 UTC 串（无时区标记，如 "2026-11-01 02:35:22"）。
 * 展示时补上 Z 按 UTC 解析，再转浏览器本地时区，否则会差时区偏移（东八区差 8 小时）。
 */
export function fmtTime(v: string): string {
  if (!v) return '';
  const d = new Date(v.includes('T') ? v : `${v.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return v;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
