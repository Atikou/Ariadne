# @ariadne/runtime

Ariadne Runtime 是桌面应用唯一的 Agent 业务进程。当前生产入口只使用 `RuntimeKernelApplication`、`ComposedRuntimeIngress` 和 `DefaultAgentControlRuntimeFactory`，不再使用已删除的 `RuntimeFacade`。

## 进程边界

- Electron Main 通过 `child_process.fork` 启动 Runtime，并使用 `@ariadne/protocol/host` 的 Protocol 3.0 Node IPC。
- Headless 复用 `RuntimeIngress`，使用严格 NDJSON v3；command 必须携带稳定 `commandId` 与绝对 `deadlineAt`。
- Runtime 不创建入站 HTTP Server、不监听端口。
- Main 注入 `installRoot`、`dataRoot`、模型目录、授权工作区、非密钥 Runtime Policy 和私有 capability client。
- Browser、MCP 远程凭据和 OS 能力由 Main 持有；Runtime 只能通过私有 Host capability 使用。

## 当前命令所有权

`RuntimeKernelApplication` 负责 Runtime 状态、模型目录和模型推理网关。`DefaultAgentControlRuntimeFactory` 只负责生产组装和生命周期；其内部的 `AgentControlPublicCommandRouter` 负责：

- `projection.snapshot.get`；
- `projection.commits.read`；
- `conversation.session.create.v3`；
- `conversation.message.accept.v3`；
- `agent.decision.resolve.v3`；
- `agent.run.cancel.v3`。

未知命令 fail closed，不会回退到旧 Facade 或第二 Writer。

`FirstPartyAgentToolCatalog` 只组合并冻结 Browser、MCP、Workspace 三个 tool family，不再同时拥有全部 schema、校验和执行实现。Agent/Conversation SQLite UoW 仍是唯一事务所有者；outbox、execution intent、row mapping 和 Projection read 作为同连接子模块运行，不拥有独立提交或补偿流程。

## 持久控制面

```text
Runtime command journal
  -> Conversation Authority + Handoff Saga
  -> Agent Control UoW
       -> Run / Turn / Inference / Decision / Effect
       -> Plan / Budget / Delegation / Child Run
       -> checkpoint / receipt / outbox
  -> Public Projection publisher
  -> Snapshot + commit replay
```

外部 Provider 和 Tool I/O 必须先持久化 intention/start。跨过外部边界后结果未知的操作进入明确恢复状态，不自动重复非幂等动作。

## 当前生产能力

- v3 Conversation、Agent Run、Decision、Cancel 和 Public Projection；
- 远程/本地模型目录与精确模型绑定；
- immutable first-party Tool Catalog、权限准入和 Process Sandbox；
- Workspace、Browser 与经授权的 MCP 工具；
- Admission 时的 Skills 指令和声明式 `run.pre` Hook。

以下目录或设置目前没有完整 v3 产品闭环：SubAgent、Background Task、Scheduler、Memory/Embedding、完整 Hooks、Diagnostics/Telemetry 和 Provider Resilience。它们不得仅因有源码或单元测试就出现在能力声明中。

## 主要目录

- `src/entry`、`src/transport`、`src/ingress`：进程入口、Node IPC/Headless 和命令身份。
- `src/application`：小型 Runtime Kernel 与模型推理网关。
- `src/control`、`src/conversation`：Agent Control 与 Conversation 业务边界。
- `src/composition`：唯一生产组装入口和生命周期。
- `src/adapters`：SQLite、模型、工具、MCP 等 Port 实现。
- `src/projection`：Conversation、Agent Run 和 Model 的公共投影 publisher。
- `src/tools`、`src/security`、`src/sandbox`：工具、内容外发和受控进程边界。
- `src/context`、`src/subagent`、`src/background`、`src/scheduler`、`src/telemetry`：尚需按生产接线逐项判定的能力实现。
- `native`：Windows Sandbox helper。

## 验证

从仓库根目录执行：

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run check:architecture
npm.cmd run audit:runtime-independence
npm.cmd run test:electron
```

当前验收边界见 [验证说明](../docs/verification.md)，能力差距见 [对比审计](../docs/deepseek-harness-comparison-audit-2026-08-26.md)。
