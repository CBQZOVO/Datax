import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { closeDb, getDb } from './db/database.js';
import { connectionService } from './services/connectionService.js';
import { redisService } from './services/redisService.js';
import { applyPersistedAiConfig } from './services/aiConfigService.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  // 初始化 SQLite（含管理员）
  getDb();
  // 用界面保存过的 AI 配置覆盖 env 默认值
  applyPersistedAiConfig();

  const app = buildApp();
  try {
    await app.listen({ host: cfg.host, port: cfg.port });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Received ${signal}, shutting down...`);
    // 任何一步失败都不能阻止进程退出（否则编排层只能强杀）；allSettled 保证前面的失败不跳过后续清理
    try {
      await Promise.allSettled([
        app.close(),
        connectionService().closeAll(),
        redisService().closeAll(),
      ]);
      closeDb();
    } catch (err) {
      app.log.error(err);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
