import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 启动时加载 server/.env（KEY=VALUE，# 注释）；不覆盖已存在的环境变量，文件不存在则跳过 */
function loadDotEnv(): void {
  try {
    const envPath = path.resolve(import.meta.dirname ?? process.cwd(), '../.env');
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // 没有 .env 文件时静默跳过（K8s/Docker 用真实环境变量注入）
  }
}

loadDotEnv();

export interface AppConfig {
  host: string;
  port: number;
  jwtSecret: string;
  jwtExpiresIn: string | number;
  dataDir: string;
  adminUsername: string;
  adminPassword: string;
  /** AES-256-GCM 密钥（32 字节） */
  secretKey: Buffer;
  /** AGENT_TOKEN 静态令牌（逗号分隔，可多个；空数组 = agent 通道禁用） */
  agentTokens: string[];
  /** agent 写权限（默认关闭；开启后仍受单语句与高危规则约束） */
  agentWrite: {
    enabled: boolean;
    /** 允许写入的连接 ID；空数组 = 不限（仍受 enabled 约束） */
    connectionIds: number[];
  };
  ai: {
    baseURL: string;
    apiKey: string;
    model: string;
    /** strict | warn | off */
    auditMode: 'strict' | 'warn' | 'off';
    timeoutMs: number;
  };
}

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const DEFAULT_JWT_SECRET = 'change-me-in-production-please';
const DEFAULT_SECRET_KEY = '0123456789abcdef0123456789abcdef';
const DEFAULT_ADMIN_PASSWORD = 'admin123';

function buildSecretKey(): Buffer {
  const raw = str('SECRET_KEY', DEFAULT_SECRET_KEY);
  // 无论用户传多长，都派生为 32 字节，保证一致性
  return crypto.createHash('sha256').update(raw).digest();
}

let cachedConfig: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;
  const nodeEnv = str('NODE_ENV', 'development');
  const jwtSecret = str('JWT_SECRET', DEFAULT_JWT_SECRET);
  const secretKeyRaw = str('SECRET_KEY', DEFAULT_SECRET_KEY);
  const adminPassword = str('ADMIN_PASSWORD', DEFAULT_ADMIN_PASSWORD);
  if (nodeEnv === 'production' && (
    jwtSecret === DEFAULT_JWT_SECRET
    || secretKeyRaw === DEFAULT_SECRET_KEY
    || adminPassword === DEFAULT_ADMIN_PASSWORD
  )) {
    throw new Error('生产环境必须配置安全的 JWT_SECRET、SECRET_KEY 和 ADMIN_PASSWORD');
  }
  if (nodeEnv !== 'production' && (
    jwtSecret === DEFAULT_JWT_SECRET
    || secretKeyRaw === DEFAULT_SECRET_KEY
    || adminPassword === DEFAULT_ADMIN_PASSWORD
  )) {
    // 开发环境允许默认值，但必须醒目提示，避免带默认密钥直接对外部署
    console.warn('┌──────────────────────────────────────────────────────────┐');
    console.warn('│  ⚠ 警告：正在使用默认 JWT_SECRET / SECRET_KEY / 密码。  │');
    console.warn('│  数据源密码将以公开已知的密钥加密，admin/admin123 可直接登录。│');
    console.warn('│  仅限本地开发使用；对外部署请配置 NODE_ENV=production     │');
    console.warn('│  并显式设置 JWT_SECRET、SECRET_KEY、ADMIN_PASSWORD。     │');
    console.warn('└──────────────────────────────────────────────────────────┘');
  }
  cachedConfig = {
    host: str('HOST', '0.0.0.0'),
    port: Number(str('PORT', '8080')),
    jwtSecret,
    jwtExpiresIn: str('JWT_EXPIRES_IN', '12h'),
    dataDir: path.resolve(str('DATA_DIR', './data')),
    adminUsername: str('ADMIN_USERNAME', 'admin'),
    adminPassword,
    agentTokens: str('AGENT_TOKEN', '')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
    agentWrite: {
      enabled: ['1', 'true', 'yes'].includes(str('AGENT_WRITE_ENABLED', '').toLowerCase()),
      connectionIds: str('AGENT_WRITE_CONNECTIONS', '')
        .split(',')
        .map((v) => Number(v.trim()))
        .filter((n) => Number.isInteger(n) && n > 0),
    },
    secretKey: buildSecretKey(),
    ai: {
      baseURL: str('AI_BASE_URL', '').replace(/\/$/, ''),
      apiKey: str('AI_API_KEY', ''),
      model: str('AI_MODEL', 'deepseek-chat'),
      auditMode: (str('AUDIT_MODE', 'strict') as AppConfig['ai']['auditMode']),
      timeoutMs: Number(str('AI_TIMEOUT_MS', '20000')),
    },
  };
  return cachedConfig;
}
