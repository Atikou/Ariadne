# Ariadne 项目结构

> 核对日期：2026-08-26

本仓库使用 npm workspaces，构建顺序为：

```text
Protocol -> Agent Core -> Runtime -> App
```

## 物理结构

```text
Ariadne/
├─ app/
│  ├─ src/main/                 # Electron Main、RuntimeSupervisor、OS capabilities
│  ├─ src/preload/              # 固定、类型化的 Renderer bridge
│  ├─ src/renderer/             # React + Dockview Feature Stores/UI
│  ├─ src/shared/               # App 内部桌面契约
│  └─ tests/
├─ packages/
│  ├─ protocol/
│  │  ├─ src/public.ts          # Public command/result/status
│  │  ├─ src/public/            # Projection v3 DTO
│  │  ├─ src/host.ts            # Main <-> Runtime 私有协议
│  │  ├─ src/headless.ts        # NDJSON v3
│  │  └─ src/settings.ts        # 非密钥 Runtime Policy
│  └─ agent-core/
│     ├─ src/domain/            # Run、Turn、Decision、Effect、Plan、Budget
│     ├─ src/application/       # Command、Dispatcher、UoW Port
│     └─ tests/
├─ runtime/
│  ├─ src/entry/                # Runtime 进程入口
│  ├─ src/transport/            # Node IPC / Headless adapter
│  ├─ src/ingress/              # command identity、deadline、lifecycle ports
│  ├─ src/application/          # Runtime Kernel、模型目录与推理网关
│  ├─ src/control/              # Agent Control use cases/ports
│  ├─ src/conversation/         # Conversation domain contracts
│  ├─ src/composition/          # 唯一生产组装入口
│  ├─ src/adapters/             # Persistence、Model、Tool、MCP adapters
│  ├─ src/projection/           # Conversation/Agent/Model publishers
│  ├─ src/tools/                # 通用 Tool contracts/implementations
│  ├─ src/security/             # Content/egress/policy boundaries
│  ├─ src/sandbox/              # Process sandbox integration
│  ├─ src/context/              # Context/Memory/Embedding/Repo Map implementations
│  ├─ src/adapters/model/       # v3 exact inference 与生产长上下文生命周期
│  ├─ src/subagent/             # 尚未形成 v3 产品闭环
│  ├─ src/background/           # 尚未形成 v3 产品闭环
│  ├─ src/scheduler/            # 尚未形成 v3 产品闭环
│  ├─ src/telemetry/            # 尚未形成完整 v3 lifecycle
│  ├─ native/                   # Windows Sandbox helper
│  └─ tests/
├─ scripts/                     # 架构、独立性、打包、签名与发布门禁
├─ docs/                        # 当前文档、目标架构、ADR 与验收矩阵
├─ artifacts/                   # 本地验证证据，不是 Runtime 数据目录
└─ .github/workflows/           # CI
```

`runtime/src/agent`、`runtime/src/app`、`runtime/src/orchestrator` 等历史模块目录仍可能存在源码和测试，但它们不是当前 v3 命令入口。新增能力不得从这些目录建立第二生产路径。

## 依赖方向

```text
Renderer -> Public Contracts
Preload/Main -> Public + Host/Desktop Contracts
Runtime Transport -> Runtime Ingress
Runtime Ingress -> Control
Control -> Agent Core Application/Domain
Runtime Adapters -> Agent Core Ports
Composition -> Kernel + Control + Adapters + Transport
```

硬约束：

- App 与 Runtime 只通过版本化 Protocol 通信；
- Renderer/Preload 不导入 Host、Node、Electron、数据库或 Runtime 源码；
- Transport 不创建 Store、Context 或业务 Facade；
- Agent Core 不依赖 Electron、Node、SQLite、Provider 或 Tool 实现；
- 具体 Adapter 只由 Composition Root 实例化；
- Runtime 不引用仓库外源码或启动入站 HTTP Server。

## Runtime 数据目录

```text
<dataRoot>/
└─ data/
   ├─ runtime-control/runtime-command.db
   ├─ conversation/conversation.db
   ├─ agent-control/agent-control.db
   └─ public-projection/projection.db
```

每个数据库只有一个 Writer 和 owner fence。Conversation 与 Agent Control 通过持久 Saga 协作；Projection 可重建；Trace 和 Renderer cache 不属于业务权威。

当前实现细节见 [当前架构](architecture.md)，长期不变量见 [目标架构](architecture-v3.md)。
