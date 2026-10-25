# Ariadne 项目结构

> 核对日期：2026-10-05

本仓库使用 npm workspaces，构建顺序为：

```text
Component Contracts -> Protocol -> Agent Core -> Live Work -> Runtime -> App
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
│  ├─ src/composition/          # 唯一生产组装入口与静态 Capability Provider 图
│  │  ├─ runtime-capabilities/   # Provider seam、定义、context 与 Manifest compiler
│  ├─ src/ingress/RuntimeCapabilityManifest.ts # Kernel/Control 共享的冻结 Manifest Port
│  ├─ src/adapters/             # Persistence、Model、Tool、MCP adapters
│  ├─ src/projection/           # Conversation/Agent/Model publishers
│  ├─ src/security/             # Content/egress/policy boundaries
│  ├─ src/sandbox/              # Process sandbox integration
│  ├─ src/adapters/model/       # v3 exact inference 与生产长上下文生命周期
│  ├─ native/                   # Windows Sandbox helper
│  └─ tests/
├─ scripts/                     # 架构、独立性、打包、签名与发布门禁
├─ docs/                        # 当前文档、目标架构、ADR 与验收矩阵
├─ artifacts/                   # 本地验证证据，不是 Runtime 数据目录
└─ .github/workflows/           # CI
```

退役 Agent／会话执行闭包已删除。长期记忆在 adapters/persistence 与 composition 中，Schedule／Workflow／Goal Worker 在 composition 中。SubAgent 使用 adapters/subagent 与 Agent Core 的普通 Child Run。当前所有者与验证范围见 [整改验证记录](remediation-verification.md)。

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

当前实现细节见 [当前架构](architecture.md)，长期不变量见 [目标架构](architecture.md)。
