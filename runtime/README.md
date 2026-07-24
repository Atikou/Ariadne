# @ariadne/runtime

Ariadne Runtime 是本仓库唯一的 Agent 业务核心。它负责模型、Agent loop、Run、上下文、记忆、工具、权限、计划、SubAgent、资源、调度、领域事件和业务持久化；Electron Main 只拥有桌面能力、Host capability broker 与 Runtime 生命周期。

## 进程边界

- 桌面模式由 Electron Main 使用 `child_process.fork` 启动，并只通过 `@ariadne/protocol/host` 的 Protocol 2.0 Node IPC 通信。
- Headless 模式复用同一 `RuntimeFacade`，stdin/stdout 使用严格 NDJSON；stdout 只输出协议，日志写 stderr。
- Runtime 不创建入站 HTTP Server、不监听端口，也不依赖第二套执行路径。
- 启动参数提供 `installRoot`、`dataRoot`、模型目录与 Main 已授权工作区；安装内容只读，可变数据只写 `dataRoot`。
- Host 注入的工作区级别是权限上限；只读工作区不能批准文件写入、删除、Shell 或危险操作。
- Browser、资源导入和安全存储只能通过 Runtime → Main 的私有 capability request/response 使用，Host DTO 不进入 Renderer。
- 优雅关闭先拒绝新请求，等待已接受命令和持久化投递完成，再释放服务并返回 `shutdown_complete`。

## 持久执行主干

```text
typed command
  -> RunAggregate(expectedAggregateVersion)
  -> SQLite transaction
       ├─ run aggregate
       ├─ checkpoint
       ├─ tool ledger
       └─ domain event outbox
  -> persistent cursor replay
```

- 非法状态转换和旧 aggregate version 写入直接拒绝。
- 工具 intent、start、result 分别落 checkpoint；不确定副作用进入 `recovery_required`，不会静默重放。
- `RuntimeEventEnvelope` 以 `eventId + aggregateVersion` 支持幂等投影和 cursor 重放。
- Trace 和 OpenTelemetry 只用于诊断/观测，不能成为业务事实源。

## 工具与内容安全

- Zod 4 `ToolContract<I,O>` 是输入、输出和 Provider JSON Schema 的唯一契约来源。
- native Tool Calling 与文本 JSON fallback 都先规范化成 `AgentAction`，再进入审批、并发计划和执行。
- 只有无副作用或工作区只读、`parallel_safe` 且资源键不冲突的工具可并发，默认上限为 4。
- 文件、网页、命令输出、Diff、MCP 和 SubAgent 回复使用 `ContentEnvelope`，默认只能作为数据。
- MCP STDIO 通过 Windows 原生沙箱双工租约运行；远程 MCP 的 HTTP 与 OAuth 凭据由 Electron Main 托管，Runtime 不接收 token。
- secret 到模型、网络、Telemetry 和日志的流动统一经过 egress gate。

## 主要目录

- `src/application`：公开命令边界、投影与 `RuntimeFacade`。
- `src/run`：RunAggregate、checkpoint、工具账本和恢复。
- `src/events`：领域 outbox、持久 cursor 和事件投递。
- `src/agent`、`src/orchestrator`：AgentAction、loop、计划和运行编排。
- `src/tools`、`src/security`：ToolContract、并发、内容权限和外发策略。
- `src/context`：Token、Embedding、摘要、长期记忆、LSP/Tree-sitter 与 Repo Map。
- `src/mcp`、`src/skills`、`src/hooks`：受控扩展边界。
- `src/resources`：内容寻址 Resource Registry。
- `src/model`、`src/telemetry`：Provider qualification/resilience 和脱敏观测。
- `src/transport`、`src/entry`：Node IPC 与 Headless NDJSON。
- `src/eval`：隔离工作区评测。
- `native`：Windows Sandbox helper。
- `config`：Schema compatibility 与外部模型资产清单。

## 开发验证

从仓库根目录执行：

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run audit:runtime-independence
```

只验证 Runtime：

```powershell
npm.cmd run verify:runtime
```

直接执行桌面入口需要父进程提供 Host IPC；普通终端启动会 fail-closed。Headless 入口在构建后使用 `npm.cmd run headless --workspace @ariadne/runtime`。

P0/P1 的实现与未验收边界见 [成熟度清单](../docs/Agent成熟度差距与改进路线.md) 和 [验证说明](../docs/verification.md)。
