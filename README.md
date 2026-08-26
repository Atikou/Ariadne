# Ariadne

Ariadne 是 Electron 桌面 Agent 应用。本仓库是协议、Runtime、桌面应用、测试和发布资产的唯一源码来源。

## 当前生产架构

```text
Renderer Feature Stores
  -> fixed sandbox Preload
  -> Electron Main
  -> Protocol 3.0 Node IPC
  -> ComposedRuntimeIngress
       |-> Runtime Kernel（状态、模型目录与推理网关）
       `-> Agent Control（Conversation、Run、Decision、Effect、Projection）
```

- `app/`：Electron Main、Preload、Renderer，以及窗口、文件、终端、Browser 和安全存储等桌面能力。
- `packages/protocol/`：Public、Host、Headless 与 Settings 契约。
- `packages/agent-core/`：Run、Turn、Inference、Decision、Effect、Plan、Budget 和 Child Run 的领域与应用规则。
- `runtime/`：Runtime Ingress、Control、Composition 与具体 Adapter。
- `scripts/`：架构、独立性、打包、签名和发布门禁。

Renderer 只消费 Public DTO；Main 拥有 OS 能力、凭据和 Runtime 生命周期；Runtime 不启动入站 HTTP Server。Conversation、Agent Control、Runtime command journal 和 Public Projection 分别拥有自己的持久化边界。

当前 Public 命令面只有：

- Runtime 状态；
- Projection 快照与 commit replay；
- v3 Session 创建与 Message 接收；
- v3 Decision 处理；
- v3 Run 取消。

目录中仍存在的 Memory、Embedding、SubAgent、Scheduler、Background Task、完整 Hooks、Telemetry 和 Provider Resilience 代码，不等于这些能力已经接入 v3 产品路径。只有具备生产 Provider、Consumer、持久权威、公开投影、恢复测试并由 Runtime status 宣告的能力，才算产品能力。

## 开发验证

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test
npm.cmd run check:architecture
npm.cmd run audit:runtime-independence
npm.cmd run verify:release-contract
npm.cmd run test:electron
```

`test:electron` 当前通过真实 Electron 窗口、Preload、Main、Runtime 子进程、SQLite 和 Public Projection 执行确定性 Agent 产品门禁，覆盖 direct、Tool continuation、Decision allow/deny、运行中取消，以及 inference/effect/projection 三个持久边界的 Runtime 强杀恢复。它使用进程外 HTTPS Provider fixture，不替代 Live Provider、本地模型、Browser/MCP、正式签名 Sandbox Helper 或干净机器发布验收。

正式发布门禁：

```powershell
npm.cmd run verify:release
```

该门禁在缺少模型资产、签名环境或安装包验收条件时 fail closed。自动测试通过不等于正式发布已验收。

## 当前主要不足

- 缺少真实 Electron Agent 闭环门禁；
- 持久化 UoW、Composition Factory 和 First-party Tool Catalog 仍是大型热点；
- 缺少 durable Agent inbox、运行中 steer/follow-up 和可恢复流式事件；
- v3 尚未接入系统性的 Context compaction、Tool result pruning 与 spill；
- Child Run 有领域基础，但 SubAgent 没有形成生产闭环；
- 能力装配仍集中在工厂和静态目录，缺少冻结的 Capability Manifest；
- Diagnostics、Telemetry、Provider Resilience 和完整 Hooks 尚未形成 v3 生命周期。

完整证据和实施顺序见 [Ariadne 与 deepseek-harness 对比审计](docs/deepseek-harness-comparison-audit-2026-08-26.md)。

## 文档

- [文档索引与有效性规则](docs/README.md)
- [当前实现架构](docs/architecture.md)
- [目标架构与不变量](docs/architecture-v3.md)
- [项目结构](docs/project-structure.md)
- [验证说明](docs/verification.md)
- [机器可读验收矩阵](docs/verification-matrix.json)
- [Renderer UI 架构](docs/ui-architecture.md)
- [Provider 与模型推理配置](docs/Provider协议与模型推理配置.md)
- [Runtime 独立性审计](docs/Runtime独立性审计.md)
- [Companion 能力请求协议](docs/agent-proposal-protocol.md)

架构决策记录位于 [`docs/adr/`](docs/adr/README.md)。
