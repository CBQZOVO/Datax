import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { authGuard } from '../middleware/auth.js';
import { getAiConfigView, saveAiConfig, testAiConfig } from '../services/aiConfigService.js';

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ status: 'ok', time: new Date().toISOString() }));

  app.get('/config', { preHandler: authGuard }, async () => {
    const cfg = loadConfig();
    return {
      aiEnabled: Boolean(cfg.ai.apiKey && cfg.ai.baseURL),
      aiModel: cfg.ai.apiKey ? cfg.ai.model : null,
      auditMode: cfg.ai.auditMode,
    };
  });

  function requireAdmin(req: { user?: { role?: string } }, reply: FastifyReply): boolean {
    if (req.user?.role !== 'admin') {
      reply.code(403).send({ error: '仅管理员可管理系统配置' });
      return false;
    }
    return true;
  }

  /** 查看当前生效的 AI 配置（Key 脱敏） */
  app.get('/ai-config', { preHandler: authGuard }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return getAiConfigView();
  });

  const aiConfigSchema = z.object({
    baseURL: z.string().max(500),
    model: z.string().min(1).max(100),
    auditMode: z.enum(['strict', 'warn', 'off']),
    /** 不传 = 保持现有 Key；空串 = 清除（关闭 AI） */
    apiKey: z.string().max(300).optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
  });

  /** 保存 AI 配置（写 SQLite，立即生效，重启后仍生效） */
  app.put('/ai-config', { preHandler: authGuard }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const parsed = aiConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '参数错误', detail: parsed.error.issues });
    }
    return saveAiConfig(parsed.data);
  });

  /** 用当前配置实际调用一次模型，验证连通性 */
  app.post('/ai-config/test', { preHandler: authGuard }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return await testAiConfig();
  });
}
