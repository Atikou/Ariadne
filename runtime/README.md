# Ariadne Runtime

Runtime 是无入站 HTTP 端口的 Node 进程。Electron 的 `RuntimeSupervisor` 启动 `dist/entry/runtime-process.js`，Headless 通过 `dist/entry/headless.js` 接收 NDJSON。两者组装同一个 `ComposedRuntimeIngress`、Runtime Kernel 和 Agent Control。

## 生产所有者

| 能力 | 所有者 |
| --- | --- |
| 会话、消息、导航、附件 | Conversation Authority 与 Conversation SQLite UoW |
| Run、推理、Decision、Effect、Plan、Budget、Child | Agent Core 与 Agent Control SQLite UoW |
| 模型目录、资格、精确推理 | Runtime Kernel、ModelCapabilityRegistry、精确推理网关 |
| 工具、工作区文件、MCP、进程能力 | 冻结 Capability Manifest 与 first-party Tool Catalog |
| 工作流、目标自治、调度 | Productivity Authority 与对应 Worker |
| 长期记忆 | LongMemory Authority 与 ProductionLongMemoryService |
| 公开展示、重放 | Public Projection publisher 与 SQLite Projection Store |
| 命令身份和未知结果 | Runtime command journal、权威 receipt 与恢复服务 |

公开投影不包含受保护正文、完整工具输出或密钥。详情读取必须通过所属 Authority 的授权接口。外部操作先持久化意图；结果未知时对账原身份，不能重新创建命令身份重复执行。

投影读接口提供固定边界分页和具有连续扫描水位的作用域增量查询。Main 通知已消费分页；Renderer 的订阅缓存迁移仍在实施。写入不再以全应用 8 MiB 快照作为校验门槛，原标量快照接口仍有传输上限。具体契约、保留策略与未完成范围见 [ADR 0035](../docs/adr/0035-scoped-projection-reads-and-journal-settlement.md)。

## 存储维护

`DatabasePaths.ts` 定义当前七个业务数据库的稳定路径。`schema-compatibility.json` 和 `database-layout.json` 描述当前系统的 Schema 契约；Trace index 是附加的诊断索引。

支持当前系统自己的显式 Schema 升级和命名规范化。运行前停止 Runtime，迁移获取 Owner lease 并保存恢复副本。可用命令见 `package.json`：`agent-control:migrate:v5-v6`、`agent-control:migrate:v6-v7`、`migrate:productivity:v1-v2`、`storage:normalize:agent`、`storage:normalize:model`、`storage:normalize:protocol`。

不支持退役 Agent／会话格式导入。现存退役数据文件保持原样，不作为当前数据源，不自动转换或清空。只读识别发现退役控制数据时报告 `retired_control_data_unsupported`。当前格式记录中已有的来源元数据仍可读取，这不提供旧格式解析或导入能力。

## 目录与入口

- `src/entry`、`transport`、`ingress`：Node IPC／Headless 与生命周期。
- `src/application`：Runtime Kernel 与模型推理网关。
- `src/control`、`conversation`：应用服务、Port 与 Conversation 权威。
- `src/composition`：唯一生产组装、命令所有者、Worker 与 Capability Provider。
- `src/adapters`：持久化、模型、工具、记忆、指令与可观测性实现。
- `src/projection`：公开投影契约与 publisher。
- `src/model`、`sandbox`、`security`、`mcp`：当前推理及安全边界。
- `native`：Windows Sandbox helper。

开发入口 `npm.cmd run dev --workspace @ariadne/runtime` 启动真实 Headless，必须提供其协议输入。模型连接自检 `models:check` 只验证模型连接；重启和外部 SubAgent 验收有各自独立命令，不代表整体验收。

## 验证

从仓库根目录运行 `npm.cmd run typecheck`、`npm.cmd test`、`npm.cmd run check:architecture`、`npm.cmd run audit:runtime-independence`、`npm.cmd run verify:persistence-contract` 和 `npm.cmd run verify:release-contract`。真实 Electron、安装包和真实 Provider 的验收范围分别记录，自动测试通过不能代替它们。

生产入口依赖清单可通过 `node scripts/audit-production-reachability.mjs` 重建。该清单包括静态值／类型导入、字面量动态加载及 Worker URL；不可达只用于调查，不能单独作为删除依据。
