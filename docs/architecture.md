# DataX — 类 Navicat 的 B/S 数据库管理平台

> 由 macOS 原生应用 invicat（SwiftUI + CLI）改造而来：去掉桌面客户端，重构为 Browser/Server 架构。

## 1. 总体架构

```
┌─────────────────────────────┐
│        浏览器 (B)            │
│  React + Ant Design 5       │
│  登录 / 连接树 / SQL 编辑器   │
│  结果集 / AI 审计确认弹窗     │
└──────────────┬──────────────┘
               │ HTTPS / REST (JSON)
┌──────────────▼──────────────┐
│        后端服务 (S)          │
│  Node.js + TypeScript +     │
│  Fastify                    │
│                             │
│  ├ Auth 模块    JWT + RBAC   │
│  ├ Connection  连接池/凭证   │
│  ├ Metadata    库/表/列     │
│  ├ Query       执行/结果     │
│  ├ DDL         建表/删表     │
│  ├ Export      导出/导入     │
│  ├ AI Audit    SQL 安全审计   │
│  │   ├ 规则引擎(内置)        │
│  │   └ LLM(OpenAI兼容)      │
│  └ Audit Log   全量审计日志   │
└──────────────┬──────────────┘
               │ 连接池 (mysql2 / pg)
┌──────────────▼──────────────┐
│   MySQL / PostgreSQL         │
└─────────────────────────────┘
```

### 关键设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 后端语言 | Node.js + TypeScript | 与前端同语言、异步 IO 适合 IO 密集的数据库网关、生态成熟 |
| Web 框架 | Fastify | 高性能、Schema 校验、插件体系 |
| 前端 | React 18 + Vite + Ant Design 5 | 类 Navicat 的高密度管理界面，antd Tree/Table/Tabs 开箱即用 |
| 数据库驱动 | mysql2 / pg（官方驱动），ES/Redis 走独立服务 | 替代原 CLI 方案：支持连接池，无外部命令行依赖 |
| 元数据存储 | SQLite (better-sqlite3) | 保存用户、数据源凭证（AES 加密）、审计日志，零运维 |
| 登录 | JWT + bcrypt | 无状态、可水平扩展（多副本共享 JWT 密钥即可） |
| AI 审计 | 规则引擎 + LLM 双通道 | 无 AI Key 也能用（内置规则），配 LLM 后能力增强；LLM 走 OpenAI 兼容协议（支持 DeepSeek/Qwen/Ollama 等） |

## 2. 模块设计

### 2.1 认证与用户（Auth）
- 首次启动初始化管理员账号（`ADMIN_USERNAME`/`ADMIN_PASSWORD` 环境变量，默认 `admin`/`admin123`，首次登录强制要求修改）。
- 登录颁发 JWT（`Authorization: Bearer <token>`），可配置过期时间。
- 预留 RBAC：`admin`（全部权限）/ `user`（可建连接、执行查询，不能管理用户）。
- 数据库密码存储：AES-256-GCM 加密后入库，密钥来自环境变量 `SECRET_KEY`。

### 2.2 数据源（Connections）
- 当前支持 MySQL / PostgreSQL / Elasticsearch / Redis。
- 保存前可"测试连接"。
- 每个数据源按需创建连接池，空闲超时自动回收。

### 2.3 元数据（Metadata）
- 树形：连接 → 数据库 → Schema → 表 / 视图（与 invicat 一致）。
- 表行数取系统统计表（MySQL `INFORMATION_SCHEMA.TABLES`、PG `pg_stat_user_tables`），秒开不卡。
- 表结构（列名/类型/可空/默认值/主键）。

### 2.4 查询（Query）
- 执行任意 SQL，返回 `{columns, rows, message, elapsedMs}`（与 invicat 的 `QueryResult` 同构）。
- 结果集支持分页、导出 CSV/JSON/SQL INSERT。
- 写操作（UPDATE/DELETE 等）影响行数回显。

### 2.5 AI SQL 安全审计（核心新增）
审计流程（对"不安全" SQL 生效）：

```
用户提交 SQL
   │
   ▼
① 规则引擎初判（无需 AI 也可用）
   │  命中高危规则：DROP / TRUNCATE / DELETE|UPDATE 无 WHERE /
   │  改表结构 ALTER / 多语句注入等
   ▼
② LLM 深度审计（配置 AI_API_KEY 时）
   │  返回 JSON: { riskLevel, summary, findings[], suggestions[] }
   ▼
③ 风险定级：high / medium / low（取规则与 LLM 的最高级）
   │
   ├─ low ───────────────► 直接执行
   ├─ medium ────────────► 弹窗展示审计结果，用户确认后执行
   └─ high ──────────────► 弹窗展示审计结果 + 先执行 EXPLAIN 预查询
                            （展示执行计划/影响行数预估），二次确认后才执行
   ▼
④ 所有执行（含被拒的）写入审计日志：谁、何时、什么 SQL、风险等级、结论
```

- `EXPLAIN` 预查询：MySQL `EXPLAIN ...`，PG `EXPLAIN (ANALYZE, COSTS, VERBOSE)`（不带 ANALYZE 以免真实执行）。
- 二次确认：前端弹窗展示"AI 审计结论 + 执行计划"，用户点"确认执行"才发真实 SQL；确认动作本身记入审计日志，可审计追责。
- 可配置：`AUDIT_MODE = strict | warn | off`（strict 下高危 SQL 必须二次确认，warn 下仅警告）。

### 2.6 审计日志（Audit Log）
- 记录：用户、时间、数据源、SQL（脱敏截断）、风险等级、规则命中、AI 结论、是否执行、耗时、结果。
- 提供查询接口，前端"审计日志"页展示。

### 2.7 DDL 与导入导出
- 建库/建 Schema/建表（列编辑器 + SQL 预览）、Truncate、Drop。
- 导出：SQL dump（复用 mysqldump/pg_dump 逻辑改为驱动级导出，或用 SQL 生成器）；结果集导出 CSV/JSON/INSERT。

## 3. 目录结构

```
datax/
├── docs/architecture.md
├── server/                     # 后端 (Node + TS + Fastify)
│   ├── src/
│   │   ├── index.ts            # 入口
│   │   ├── app.ts              # Fastify 装配
│   │   ├── config.ts           # 环境配置
│   │   ├── types.ts
│   │   ├── db/                 # SQLite 存储
│   │   ├── middleware/auth.ts  # JWT
│   │   ├── drivers/            # mysql/pg 驱动封装（ES/Redis 为独立 service）
│   │   ├── services/           # auth/connection/query/metadata/aiAudit/es/redis
│   │   └── routes/             # REST 路由
│   ├── Dockerfile
│   └── package.json
├── web/                        # 前端 (React + Vite + AntD)
│   ├── src/
│   │   ├── api/                # axios 封装 + 类型
│   │   ├── stores/             # zustand
│   │   ├── pages/              # Login / Workspace
│   │   └── components/         # ConnectionTree / SQLEditor / ResultTable / AuditConfirm
│   ├── Dockerfile
│   └── nginx.conf
└── deploy/
    ├── docker-compose.yml
    └── k8s/                    # namespace/secret/configmap/deployment/service/ingress
```

## 4. API 一览（REST）

| Method | Path | 说明 |
|---|---|---|
| POST | /api/auth/login | 登录 |
| POST | /api/auth/change-password | 改密 |
| GET | /api/auth/me | 当前用户 |
| GET/POST/PUT/DELETE | /api/connections | 数据源 CRUD |
| POST | /api/connections/test | 测试未保存的连接 |
| POST | /api/connections/:id/test | 测试已保存的连接 |
| GET | /api/metadata/:id/databases | 库列表 |
| GET | /api/metadata/:id/schemas | Schema 列表 |
| GET | /api/metadata/:id/tables | 表 + 行数 |
| GET | /api/metadata/:id/views | 视图 |
| GET | /api/metadata/:id/columns | 表结构 |
| POST | /api/query/execute | 执行 SQL（内部先审计） |
| POST | /api/query/audit-only | 仅审计不执行（编辑器实时检查） |
| POST | /api/query/explain | EXPLAIN 预查询 |
| POST | /api/query/confirm | 二次确认后执行（携带 auditId） |
| GET | /api/logs | 审计日志 |
| GET | /api/es/indices | ES 索引列表 |
| POST | /api/es/search | ES 参数化搜索 |
| POST | /api/redis/execute | Redis 命令执行 |
| GET | /api/system/config | 系统信息（是否已配置 AI 等） |

> 审计的关键设计：`/api/query/execute` 返回 `{needsConfirm, auditId, audit}`；高危 SQL 先 `/api/query/explain`；最后 `/api/query/confirm` 携带 `auditId` + `confirmed: true` 执行，服务端校验该 auditId 已确认过且未过期。

## 5. 部署

### 5.1 Docker
- `web`：多阶段构建，产物由 Nginx 托管，`/api` 反代到 `server`。
- `server`：多阶段构建，`node:20-alpine` 运行；数据卷挂载 SQLite 与导出目录。
- `docker-compose up -d` 一键起。

### 5.2 Kubernetes
- `deploy/k8s/`：Namespace、Secret（SECRET_KEY/JWT/DB 凭证/AI Key）、ConfigMap、Server Deployment + Service、Web Deployment + Service、Ingress（可选 TLS）。
- Server 多副本无状态（会话在 JWT），SQLite 用 PVC 单写（或生产切换外部数据库）。
- 滚动更新、健康检查（`/api/healthz`）、资源配额。

## 6. 安全设计

1. **传输层**：生产强制 HTTPS（Ingress TLS / 反代）。
2. **凭证**：数据库密码 AES-256-GCM 加密存储；前端不回显明文。
3. **AI 审计**：高危写操作强制 EXPLAIN + 二次确认；确认动作不可绕过（服务端校验 auditId）。
4. **审计日志**：所有执行与拒绝均留痕，支持事后追责。
5. **注入防护**：所有元数据查询使用参数化/标识符转义；对用户 SQL 仅审计不信任，落库前脱敏。
6. **限流**：登录接口限流，防爆破。

## 7. 里程碑

- M1 后端：认证 + 数据源 + 元数据 + 查询 + AI 审计 + 审计日志 ✅
- M2 前端：登录 + 工作台（连接树/SQL 编辑器/结果集/确认弹窗/日志页）✅
- M3 部署：Docker + docker-compose + K8s manifests + 文档 ✅
- M4 增强：ES / Redis 数据源、Agent 只读通道、审批流 ✅
- M5 规划：Oracle 驱动、导入导出增强、WebSocket 实时日志
