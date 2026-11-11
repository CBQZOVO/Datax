import esSvg from '../assets/ElasticSearch.svg';
import mysqlSvg from '../assets/mysql.svg';
import pgSvg from '../assets/PostgreSQL.svg';
import type { DbType } from '../api';

// Redis 无单独资源文件，用内联 SVG（红底 + 白色分层）
const redisSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%23d82c20'/><path d='M8 11.5l8-3.2 8 3.2-8 3.2z' fill='%23fff'/><path d='M8 16.5l8-3.2 8 3.2-8 3.2z' fill='%23fff' opacity='.85'/><path d='M8 21.5l8-3.2 8 3.2-8 3.2z' fill='%23fff' opacity='.7'/></svg>";

// 颜色内嵌在各 SVG 文件中，img 引 URL 即可；ES 的 viewBox 非正方形，按高度自适应宽
const ICONS: Record<DbType, string> = {
  mysql: mysqlSvg,
  postgres: pgSvg,
  elasticsearch: esSvg,
  redis: redisSvg,
};

export default function DbTypeIcon({ type, size = 16 }: { type: DbType; size?: number }) {
  return (
    <img
      src={ICONS[type] ?? mysqlSvg}
      alt={type}
      draggable={false}
      style={{ height: size, width: 'auto', display: 'block', flexShrink: 0 }}
    />
  );
}
