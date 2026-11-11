# Agent 访问通道设计（AGENT_TOKEN + 只读执行 + ES 查询）

> 目标：让 AI agent（CodeBuddy 等）通过 `curl` 直连 datax，稳定、低摩擦地完成两类日常操作：
> 1. **查数据库**（无需浏览器自动化或各处找客户端，一条 curl 出结果）
> 2. **查日志**（ES，不用裸 curl 拼 DSL、记字段名、算 UTC 时间戳）
>
> 原则：agent 只读；人类走 web 界面，写操作审计链路完全不变。

## 0. 非目标（明确不做）

- **agent 写库**：agent token 只能执行只读语句，写操作请人用 web 界面（保留 AI 审计 + EXPLAIN + 二次确认/审批全流程）。
- **web-cli / xterm 交互终端**：对 agent 而言 curl REST 就是命令行，不做。
- **ES 连接的 web 端浏览树**：第一版 ES 只提供 REST API，web 前端仅支持新建 ES 类型连接，不展开树。
- **token 管理界面**：静态环境变量，吊销 = 换值重启。

## 1. 认证：AGENT_TOKEN 静态 token

### 配置

```
AGENT_TOKEN=token1,token2     # 逗号分隔，支持多 token；留空/未配置 = agent 通道整体禁用（默认）
```

- 进 `config.ts`：`agentTokens: string[]`。
- 进 `deploy/k8s/secret.yaml`。
- 每个 token 建议生成方式：`openssl rand -hex 32`（64 字符）。

### authGuard 改动（`middleware/auth.ts`）

```text
Bearer <token>
  ├─ jwt.verify 成功 → 现有流程，req.user = 数据库用户
  └─ verify 抛错 → 逐个 timingSafeEqual 比对 agentTokens
        └─ 命中 → req.user = AGENT_USER（虚拟用户，不查数据库）
```

`AGENT_USER` 常量：

```ts
const AGENT_USER: User = {
  id: 0,
  username: 'agent',
  role: 'user',
  mustChangePassword: 0,
  isAgent: 1,          // User 类型新增可选字段 isAgent?: 0 | 1
  createdAt: '',
};
```

注意点：
- 比对用 `crypto.timingSafeEqual`（两侧先 sha256 定长化再比，防时序侧信道）。
- agent 不做 `mustChangePassword` 检查、不走登录限流（authGuard 里 JWT 失败才落到 token 比对，登录接口本身不变）。
- 审计日志照记，`username='agent'` 可区分、可追溯。

### 权限：agent 全连接只读放行

`db/store.ts` 的 `hasDataPermission` 入口加一行：

```ts
if ((user as AgentCapableUser).isAgent) return true;
```

理由：agent 的价值就是"随手指哪查哪"，逐连接授权会把通道变得不可用；风险由只读语义兜住。这是本次设计中唯一一处硬编码放行，明确标出供 review。

## 2. 只读执行通道（queryService.executeReadonly）

### 为什么不直接复用 /execute

现有流程对所有语句跑 `auditSql`：strict/warn 模式下调 LLM。agent 的 SELECT 也走 LLM 会慢（秒级）且无意义。新增独立方法，**不调 LLM**：

```ts
async executeReadonly(connectionId, sql, database, user): Promise<QueryResult & { truncated: boolean }>
```

判定链（三道闸，全部通过才执行）：

1. **verb 白名单**：剥离注释后，首语句必须匹配 `^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\b`（不区分大小写）。多语句（splitStatements 后 >1 条）直接拒绝。
2. **写黑名单复检**：`isWriteStatement(sql) === true` → 拒绝（覆盖 CTE 写等花式情况，复用现有 WRITE_CTE 检测）。
3. **规则引擎复检**：`ruleEngine(sql)`（只跑内置规则，不调 LLM）判定 `high` → 拒绝（拦 `INTO OUTFILE`/`LOAD_FILE`/`SLEEP()` 等）。`medium` 放行——写类 medium 已被闸 1/2 挡住，SELECT 类 medium（MISSING_LIMIT）为建议性提示，大结果集由 maxRows 物理截断兜底。

执行后写审计日志：`decision: 'agent_readonly'`（AuditLog.decision 类型 union 扩展一个值）。

### 结果集保护

- `maxRows`：默认 1000，参数可调、上限 10000。超出截断并置 `truncated: true`。
- 实现：`executeLowRisk` 返回 rows 后截断，不动 driver。

### 路由（`routes/query.ts`）

`/api/query/execute` 入口分流：

```ts
if (req.user!.isAgent) {
  const result = await queryService().executeReadonly(connectionId, sql, database, user);
  return { needsConfirm: false, result };
}
// 非走 agent 现有流程，一行不改
```

同时 `/explain`、`/confirm`、`/approvals*` 对 agent 直接 403（agent 不需要确认流，写不了就对了）。

## 3. CSV 输出

`/api/query/execute?format=csv`（或 `Accept: text/csv`）：

```text
GGType,cnt
GG,113442
TZ,19116
...
```

- 仅头行 + 数据行，标准 RFC 4180 转义（含逗号/引号/换行的值加引号）。
- NULL → `\N`，空串 → 空字段（可区分）。
- `truncated: true` 时 CSV 尾行加注释行 `-- truncated at 1000 rows`。
- 对 agent 的价值：表格类结果 CSV 比 JSON 省一半以上 token，且解析无歧义。

## 4. ES 数据源与 /api/es/search

### 连接模型

- `DatabaseType` 扩展：`'mysql' | 'postgres' | 'elasticsearch'`。
- ES 连接的字段映射：`host`（完整 baseURL，如 `https://es.example.com`）、`port`、`username`（elastic）、`password`（AES 加密存储，复用现有机制）、`database` 字段留空。
- **ES 不实现 DatabaseDriver 接口**（fetchDatabases/executeQuery 语义不匹配，硬套是假抽象）：
  - `drivers/index.ts` 的 `createDriver` 对 es 类型抛 `'ES 连接不支持 SQL 驱动'`；
  - `/api/query/*`、`/api/metadata/*` 入口检查 `conn.type === 'elasticsearch'` → 400，防止 agent 误用 SQL 通道打 ES 连接。
  - `connectionService.test()` 对 es 特判走 `esService.test()`（`GET /` 鉴权探测）。

### 新增 `services/esService.ts`

基于 Node 原生 fetch（Node 18+，**零新依赖**），Basic auth 头随请求带。三个能力：

```ts
test(ds): Promise<void>                  // GET / ，校验 200
listIndices(ds, pattern?): Promise<...> // GET /_cat/indices?h=index,docs.count&format=json
search(ds, opts): Promise<EsSearchResult>
```

`search` 参数在后端拼 DSL：

| 参数 | 类型 | 说明 |
|---|---|---|
| `index` | string 必填 | 支持通配符（`...-2026.10.*`），URI 编码后透传 |
| `q` | string 可选 | 关键词 → `match_phrase` 查 `qField` 字段（默认 `log`，日志场景 90% 是它） |
| `qField` | string 可选 | 指定 `q` 检索的字段 |
| `conditions` | array 可选 | 多条件过滤：每条 `{field, value}` 做 match_phrase，条件间 AND |
| `query` | string 可选 | 键值检索语法（见下），与 `q`/`conditions` 互斥 |
| `start` / `end` | string 可选 | ISO 8601 或 `yyyy-MM-dd`；**不带时区按 UTC 解释**（ES @timestamp 是 UTC，避免歧义）→ `range: { @timestamp: { gte, lt } }` |
| `fields` | string[] 可选 | 返回哪些 _source 字段，默认 `["@timestamp", "log"]` |
| `sort` | string 可选 | 默认 `@timestamp:desc` |
| `size` | number 可选 | 默认 20，上限 1000 |
| `lines` | boolean 可选 | 见下 |

#### 键值检索语法（`query`）

空格分隔的 token，token 之间为 AND；`-` 前缀表示排除（NOT）；`field:` 指定字段，裸词查 `qField`（默认 `log`）。

| 语法 | 例子 | 语义 |
|---|---|---|
| `field:value` | `level:ERROR` | 该字段包含匹配（match_phrase） |
| `-field:value` | `-thread:heartbeat` | 排除该字段匹配 |
| 裸词 / `-裸词` | `timeout -heartbeat` | 查默认字段 / 排除 |
| 通配 | `path:*timeout*`、`pod:api-*` | `*` 通配（前导通配须至少 2 个具体字符） |
| 范围 | `status:>=500`、`cost:>100` | 数值范围（`>= <= > <`，操作符与值不加空格） |
| 引号短语 | `message:"out of memory"` | value 含空格时用双引号包裹 |

- `query` 与 `q`、`conditions` 互斥，同时传返回 400。
- token 之间是 AND，暂不支持 OR/括号（保持解析简单可靠）。
- 字段名仅允许字母数字 `_ . @ -`；值区分大小写（`level:error` 匹配不到 `ERROR`）。
- 数值范围会尽量转数字传给 ES `range`；非数字则原样传字符串（可作用于日期等字段）。

curl 示例：

```bash
# 查 ERROR 且 message 含超时、排除 heartbeat 线程、耗时 >=500ms
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"connectionId":2,"index":"logs-2026.10.*",
       "query":"level:ERROR message:\"timeout\" -thread:heartbeat cost:>=500",
       "size":50,"lines":true}' \
  $BASE/api/es/search
```

### 响应格式

默认 JSON（字段拉平，去掉 ES 信封）：

```json
{ "total": 72, "hits": [ { "@timestamp": "2026-10-31T02:19:46.188Z", "log": "..." } ] }
```

`lines: true` 时返回预拼接文本行（对 agent 最省 token）：

```json
{ "total": 72, "lines": ["2026-10-31T02:19:46.188Z | ### Error updating database..." ] }
```

拼接规则：`fields.join(' | ')` 每条一行。`format=csv` 时直接输出 `total` + lines 文本。

### 路由（新增 `routes/es.ts`，挂 `/api/es`，preHandler authGuard）

```
GET  /api/es/indices?connectionId=2            → { indices: [{ name, docs }] }
POST /api/es/search                             → 见上
```

权限：复用 `hasDataPermission`（agent 放行、普通用户按授权表）。ES 查询天然只读，无审计确认流；执行记录进审计日志（sql 字段存 JSON 化查询参数，decision `agent_readonly` 或 `auto_allow`）。

## 5. web 前端最小改动

- 连接新建表单：类型下拉加 `elasticsearch`（port 默认 9200，密码字段复用）。
- 连接树：ES 类型连接显示节点、不可展开（后端 metadata 对 es 返回空列表即可，前端无需特判逻辑）。
- 其余（SQL 编辑器、审计、审批）不动。

## 6. 部署

- `deploy/k8s/secret.yaml` 增加 `AGENT_TOKEN`（值 ≥ 32 随机字符）。
- 生产检查：`AGENT_TOKEN` 为空时 agent 分支完全不启用（authGuard 跳过比对、路由分流不生效），零配置不引入新攻击面。
- 部署后 admin 在 web 界面手工配置两个数据源：
  - `mysql-prod`：`mysql.example.internal:3306`（示例：内网 MySQL）
  - `es-prod`：`https://es.example.com:443` + elastic 凭据
- 网络前提：datax 所在 namespace 能访问 MySQL svc 与 ES 域名（同集群，默认可达）。

## 7. Agent 使用契约（curl 示例）

```bash
BASE=http://datax-host
AUTH="Authorization: Bearer $AGENT_TOKEN"

# ① SQL 查询（JSON）
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"connectionId":1,"database":"mydb",
       "sql":"SELECT GGType,COUNT(*) AS cnt FROM op_purbidnotice GROUP BY GGType"}' \
  $BASE/api/query/execute

# ② SQL 查询（CSV，适合表格结果）
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{...同上...}' \
  "$BASE/api/query/execute?format=csv"

# ③ 日志关键词搜索（按天，返回行文本）
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"connectionId":2,"index":"logs-2026.10.31",
       "q":"Data too long","start":"2026-10-30","end":"2026-11-01",
       "size":50,"lines":true}' \
  $BASE/api/es/search

# ④ 发现索引名
curl -s -H "$AUTH" "$BASE/api/es/indices?connectionId=2"
```

错误语义：401 token 无效；403 agent 越界（写语句 / 无权连接）；400 参数错误。返回体统一 `{ error: string }`。

## 8. 改动清单与工作量

| 文件 | 改动 | 估算 |
|---|---|---|
| `server/src/config.ts` | agentTokens 解析 | ~5 行 |
| `server/src/types.ts` | User.isAgent；DatabaseType 加 es；decision union 加 'agent_readonly' | ~5 行 |
| `server/src/middleware/auth.ts` | token 比对 + AGENT_USER | ~25 行 |
| `server/src/db/store.ts` | hasDataPermission agent 放行 | ~2 行 |
| `server/src/services/queryService.ts` | executeReadonly（白名单/黑名单/规则三闸 + 截断 + 日志） | ~80 行 |
| `server/src/routes/query.ts` | agent 分流、CSV、explain/confirm 对 agent 403 | ~50 行 |
| `server/src/services/esService.ts`（新） | fetch 封装：test/indices/search | ~150 行 |
| `server/src/routes/es.ts`（新） | 两个端点 + zod | ~100 行 |
| `server/src/routes/connections.ts` + `connectionService.ts` | es 类型 test 分流；SQL 路由对 es 连接 400 | ~20 行 |
| `web/` 连接表单 | 类型下拉 + port 默认值 | ~10 行 |
| `deploy/k8s/secret.yaml` | AGENT_TOKEN | ~3 行 |

合计约 450 行，无新增 npm 依赖（ES 用原生 fetch）。

## 9. 安全考量

- **token 泄漏影响面**：全部数据源只读 + 日志查询。缓解：token 仅存 K8s secret、审计日志全量留痕（username=agent）、换 token 重启即吊销。
- **只读强度**：verb 白名单 + isWriteStatement 黑名单 + 规则引擎三层判定，任何一层不过即拒。有意不依赖单一判定（正则可被注释/CTE 绕过的历史教训）。
- **数据源凭据**：继续走现有 AES-256-GCM 加密存储，agent 请求链路不接触明文密码（只在 driver 创建时解密）。
- **ES 透传面**：参数化搜索由后端拼 DSL，index 名透传做 URI 编码；原生 DSL 端点（/api/es/dsl）对全员递归禁用脚本字段（script/script_fields/runtime_mappings），不开放 _delete_by_query 等写 API。
- **网络面**：datax ingress 走现有 JWT/token 认证；如需更紧，可在 ingress 加 IP 白名单（运维项）。
- **已知局限**：只读闸无法静态识别 SELECT 调用自定义写函数的情况，需靠数据库侧账号权限兜底（agent 建议只授权只读账号）。

## 10. 风险与开放问题

1. `hasDataPermission` 对 agent 硬编码放行是最大的权限决策（全连接只读），部署前请评估。
2. CSV 的 NULL→`\N` 约定：如果后续有程序消费，需文档化（本文档即约定处）。
