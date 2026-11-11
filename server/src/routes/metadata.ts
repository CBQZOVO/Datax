import type { FastifyInstance } from 'fastify';
import { metadataService } from '../services/metadataService.js';
import { authGuard } from '../middleware/auth.js';
import { hasDataPermission, listAuthorizedConnectionIds, listAuthorizedDatabases, listHiddenDatabasesFor } from '../db/store.js';

export async function metadataRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authGuard);

  app.get('/:id/databases', async (req, reply) => {
    const { id } = req.params as { id: string };
    const connectionId = Number(id);
    const allowedIds = listAuthorizedConnectionIds(req.user!);
    if (allowedIds !== null && !allowedIds.includes(connectionId)) {
      return reply.code(403).send({ error: '无权访问该数据源' });
    }
    const allowedDatabases = listAuthorizedDatabases(req.user!, connectionId);
    const list = await metadataService().databases(connectionId);
    let result = allowedDatabases === null ? list : list.filter((database) => allowedDatabases.includes(database));
    // 管理员隐藏配置：默认过滤掉隐藏项；?all=1 返回全量（权限分配/隐藏配置界面勾选用）
    if (req.user!.role === 'admin' && (req.query as { all?: string }).all !== '1') {
      const hidden = new Set(listHiddenDatabasesFor(req.user!.id, connectionId));
      result = result.filter((database) => !hidden.has(database));
    }
    return { databases: result };
  });

  app.get('/:id/schemas', async (req, reply) => {
    const { id } = req.params as { id: string };
    const connectionId = Number(id);
    const database = (req.query as { database?: string }).database ?? '';
    if (!hasDataPermission(req.user!, connectionId, database)) {
      return reply.code(403).send({ error: '无权访问该数据库' });
    }
    const list = await metadataService().schemas(connectionId, database);
    return { schemas: list };
  });

  app.get('/:id/tables', async (req, reply) => {
    const { id } = req.params as { id: string };
    const connectionId = Number(id);
    const q = req.query as { database?: string; schema?: string };
    const database = q.database ?? '';
    if (!hasDataPermission(req.user!, connectionId, database)) {
      return reply.code(403).send({ error: '无权访问该数据库' });
    }
    const result = await metadataService().tables(connectionId, database, q.schema ?? null);
    return { tables: result.items, total: result.total, truncated: result.truncated };
  });

  app.get('/:id/tables/search', async (req, reply) => {
    const { id } = req.params as { id: string };
    const connectionId = Number(id);
    const q = req.query as { database?: string; schema?: string; q?: string };
    const database = q.database ?? '';
    if (!hasDataPermission(req.user!, connectionId, database)) {
      return reply.code(403).send({ error: '无权访问该数据库' });
    }
    const list = await metadataService().searchTables(
      connectionId,
      database,
      q.schema ?? null,
      q.q ?? ''
    );
    return { tables: list };
  });

  app.get('/:id/views', async (req, reply) => {
    const { id } = req.params as { id: string };
    const connectionId = Number(id);
    const q = req.query as { database?: string; schema?: string };
    const database = q.database ?? '';
    if (!hasDataPermission(req.user!, connectionId, database)) {
      return reply.code(403).send({ error: '无权访问该数据库' });
    }
    const list = await metadataService().views(connectionId, database, q.schema ?? null);
    return { views: list };
  });

  app.get('/:id/columns', async (req, reply) => {
    const { id } = req.params as { id: string };
    const connectionId = Number(id);
    const q = req.query as { database?: string; schema?: string; table?: string };
    const database = q.database ?? '';
    if (!hasDataPermission(req.user!, connectionId, database)) {
      return reply.code(403).send({ error: '无权访问该数据库' });
    }
    const list = await metadataService().columns(connectionId, database, q.schema ?? null, q.table ?? '');
    return { columns: list };
  });
}
