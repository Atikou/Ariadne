# @ariadne/runtime

Ariadne Runtime 是桌面应用唯一的 Agent 业务进程。当前生产入口只使用 `RuntimeKernelApplication`、`ComposedRuntimeIngress` 和 `DefaultAgentControlRuntimeFactory`，不再使用已删除的 `RuntimeFacade`。

## 进程边界

- Electron Main 通过 `child_process.fork` 启动 Runtime，并使用 `@ariadne/protocol/host` 的 Protocol 3.0 Node IPC。
- Headless 复用 `RuntimeIngress`，使用严格 NDJSON v3；command 必须携带稳定 `commandId` 与绝对 `deadlineAt`。
- Runtime 不创建入站 HTTP Server、不监听端口。
- Main 注入 `installRoot`、`dataRoot`、模型目录、授权工作区、非密钥 Runtime Policy 和私有 capability client。
- Browser、MCP 远程凭据和 OS 能力由 Main 持有；Runtime 只能通过私有 Host capability 使用。

## Live Work

持久 pipe process、沙箱内 Agent PTY 与 Electron Main PTY 都使用纯 TypeScript `@ariadne/live-work` registry。producer 持有真实进程/PTY handle；registry 统一精确 owner、并发上限、状态、UTF-8 byte cursor、有限输出、互斥输入、resize/signal/wait、完成通知和 shutdown join。Agent 用 `workspace.process_start` 或 `workspace.terminal_start` 创建 producer；`workspace.job_list/output/write/resize/signal/wait/kill` 是唯一通用控制面。Agent PTY 由既有 `AgentProcessSandbox` 启动 worker，`node-pty` 及其子进程留在同一受限令牌和 Windows Job 内。live-work 终态由 `AgentLiveWorkCompletionInboxBridge` 先写入带 `live_work` 来源的 durable inbox，再唤醒 scheduler/projection；成功投递后 `job_list` 不会重复领取。关机先 close/join live work、排空通知并解绑，再冻结 Agent Store。启动时恢复器从活跃 Run 的受保护成功 `process_start`/`terminal_start` Effect 结果重建 `interrupted` 系统事实；旧 OS handle/output 明确不可恢复。旧第二进程表已删除。

## 当前命令所有权

`RuntimeKernelApplication` 负责 Runtime 状态、模型目录和模型推理网关。`DefaultAgentControlRuntimeFactory` 只负责生产组装和生命周期；其内部的 `AgentControlPublicCommandRouter` 负责：

- `projection.snapshot.get`；
- `projection.commits.read`；
- `conversation.session.create.v3`；
- `conversation.message.accept.v3`；
- `agent.decision.resolve.v3`；
- `agent.run.cancel.v3`。

未知命令 fail closed，不会回退到旧 Facade 或第二 Writer。

Runtime bootstrap 只编译一次 `RuntimeCapabilityManifest`。Workspace、Browser、MCP 等静态 Provider 各自贡献 Tool family、公开能力和生命周期；同一个冻结快照同时驱动 immutable Tool Catalog 与 Runtime status。`dependsOn` 只表达 Provider 顺序，`consumes`/`provides` 表达实际 service 图；compiler 为每个 Provider 注入仅含已声明依赖的只读 scope，并在缺失 owner、非法可选性、越权读取或必需输出缺失时 fail closed。Skills、Telemetry 与 live-work 由终端 Provider 组装成类型化 Agent Control service bundle，默认 Factory 不再按字符串定位扩展 service。Agent/Conversation SQLite UoW 仍是唯一事务所有者；outbox、execution intent、row mapping 和 Projection read 作为同连接子模块运行，不拥有独立提交或补偿流程。

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

Agent Control 当前为 schema v7 / ledger revision 55。Runtime 启动对旧库 fail closed，不隐式迁移：v5 数据库先在 Ariadne 停止时运行 `corepack.cmd npm run agent-control:migrate:v5-v6 --workspace @ariadne/runtime -- --data-root <absolute-data-root>`，再运行 `corepack.cmd npm run agent-control:migrate:v6-v7 --workspace @ariadne/runtime -- --data-root <absolute-data-root>`；每一步获取同一 owner lease、执行完整性/历史校验并生成 durable backup。v6 数据库只执行第二步。

## 当前生产能力

- v3 Conversation、Agent Run、Decision、Cancel 和 Public Projection；
- durable `ask_user` Directive、受保护问题载荷、公开回答 Decision 和统一 inbox continuation；
- 远程/本地模型目录与精确模型绑定；
- immutable first-party Tool Catalog、权限准入和 Process Sandbox；Catalog revision 17 同时固定模型可见 description/guidance 与可公开静态 kind/label，受保护 Tool 结果不进入 Public Projection；
- Workspace、Browser 与经授权的 MCP 工具；Workspace 文件族包含 opaque-version read/write、bounded literal search/glob 和同一文件权威下的 Unicode text edits；
- Admission 时的 Skills 指令、固定 package 资源读取和声明式 `run.pre` Hook。

以下目录或设置目前没有完整 v3 产品闭环：外部 continuable/Codex/Claude SubAgent adapter、Scheduler、Memory/Embedding 和人类 Skill command catalog。可取消 scoped Skill snapshot/last-good、固定 package 资源读取与 model/user policy、Manifest-owned 静态可信 Hook Provider 生命周期、continuable ordinary Child、运行中 interrupt、冻结 execution Provider seam、fresh-process ACP one-shot adapter 和 exact Provider Resilience 已进入 v3，不能再列为未接线。旧 Background Task 第二进程表及其 Tool/trigger contract 已删除；脱敏 Diagnostics 与受控 Telemetry 已进入 v3。外部动态 Hook 包发现有意不开放；Manifest 会自动列出 Protocol 中缺少生产 Provider owner 的公开能力。

## 主要目录

- `src/entry`、`src/transport`、`src/ingress`：进程入口、Node IPC/Headless 和命令身份。
- `src/application`：小型 Runtime Kernel 与模型推理网关。
- `src/control`、`src/conversation`：Agent Control 与 Conversation 业务边界。
- `src/composition`：唯一生产组装入口、Capability Provider 图和生命周期。
- `src/adapters`：SQLite、模型、工具、MCP 等 Port 实现。
- `src/projection`：Conversation、Agent Run 和 Model 的公共投影 publisher。
- `src/tools`、`src/security`、`src/sandbox`：工具、内容外发和受控进程边界。
- `src/context`、`src/subagent`、`src/scheduler`、`src/telemetry`：尚需按生产接线逐项判定的能力实现；`src/notifications` 只保留 legacy Agent/Scheduler notification journal，不拥有进程。
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

当前验收边界见 [验证说明](../docs/verification.md)，能力装配契约见 [Runtime Capability Manifest](../docs/capability-manifest.md)，能力差距见 [对比审计](../docs/deepseek-harness-comparison-audit-2026-08-28.md)。
