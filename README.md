# Ariadne

Ariadne 是 Electron 桌面 Agent 应用。当前仓库是协议、Runtime、测试、构建和发布的唯一来源；不依赖项目外 Agent 实现，也不保留退役框架的兼容层。

## 架构

```text
Electron Renderer
  └─ 固定、类型化 Preload API
       └─ Electron Main
            ├─ 窗口 / 终端 / 文件 / Browser / 安全存储
            ├─ Host capability broker
            └─ RuntimeSupervisor
                 └─ Protocol 2.0 Node IPC
                      └─ Ariadne Runtime
                           ├─ RunAggregate / checkpoint / tool ledger
                           ├─ domain event outbox / snapshot / replay
                           ├─ Agent / 模型 / Context / Memory
                           ├─ ToolContract / 权限 / Egress / Sandbox
                           └─ MCP / Skills / Hooks / Resource / Eval
```

- `app/`：Electron Main、Preload、Renderer 和桌面系统能力。
- `packages/protocol/`：App 与 Runtime 唯一共享的 Public、Host、Headless 2.0 协议。
- `runtime/`：Agent 业务核心和 Windows Sandbox helper。
- `scripts/`：独立性、打包、签名与发布门禁。
- `docs/`：架构、成熟度、验证和验收矩阵。

Renderer 只接收 Public DTO，不接触 Node、数据库、密钥、PID、端口或本机绝对路径。Main 拥有 Browser、安全存储与桌面资源，但不承载 Agent 编排。Runtime 不启动本地 HTTP Server、不监听端口。

## P0/P1 主干

- 单一 `RunAggregate` 使用 typed command 和 `expectedAggregateVersion`。
- aggregate、checkpoint、tool ledger 与 domain event outbox 在同一事务提交。
- Renderer 从单 revision 快照初始化，再按持久 cursor 幂等重放事件；Trace 只用于诊断。
- Zod 4 `ToolContract` 是工具输入、输出和 Provider JSON Schema 的唯一来源。
- native Tool Calling 与文本 fallback 统一为 `AgentAction`；协议修复最多两次且无副作用。
- 工具 checkpoint、稳定幂等键、安全只读并发和不确定副作用恢复阻塞。
- `ContentEnvelope`、分层指令权限和统一 secret egress gate。
- TokenCounter、预算装箱、本地 GGUF Embedding、严格摘要、可治理长期记忆。
- LSP 3.18 优先、Tree-sitter WASM fallback 与持久 Repo Map。
- MCP、Skills、Hooks、内容寻址 Resource Registry、隔离 Browser Service。
- Headless NDJSON、Task compare/restore、Provider resilience/qualification 和脱敏 OTel。
- 数据库迁移备份/回滚、新 Schema 拒写与 fail-closed Windows 发布门禁。

## 开发与验证

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test
npm.cmd run audit:runtime-independence
npm.cmd run verify:release-contract
npm.cmd run test:electron
```

当前自动基线为 Protocol 18、Runtime 162、App 163，共 343 项。真实 Electron 冒烟会启动真实窗口与 Runtime 子进程，并把证据写入 `artifacts/electron-runtime-smoke/`。

正式发布门禁：

```powershell
npm.cmd run verify:release
```

该命令要求依赖、协议、Runtime、App、独立性、真实 Electron、原生 Sandbox、模型 Runtime、签名环境、Windows 安装包和 Authenticode 产物全部通过。缺少真实模型、正式证书或干净 Windows 验收机时会 fail-closed，不能把开发构建描述为可生产发布。

## 当前未验收边界

- 真实远程 Provider/本地聊天模型的工具、权限、计划、取消和强杀恢复。
- 实际 BGE-M3 资产的多语言语义召回。
- 签名原生 Sandbox helper 下的真实 MCP STDIO 服务器，以及真实远程 MCP OAuth 授权、刷新和断线恢复。
- Browser 真实网站重定向、敏感输入和下载隔离。
- 正式签名安装包的全新安装、N-1 升级、迁移失败回滚、备份降级和卸载。

这些条目不会因为自动测试通过而被标记为已验收。

## 文档

- [架构设计](docs/architecture.md)
- [Agent 成熟度与 P0/P1 验收清单](docs/Agent成熟度差距与改进路线.md)
- [Runtime P0/P1 完成状态](docs/Runtime接入-TODO.md)
- [验证说明](docs/verification.md)
- [机器可读覆盖矩阵](docs/verification-matrix.json)
- [项目结构](docs/project-structure.md)
- [Renderer UI 架构](docs/ui-architecture.md)
- [Provider 协议与模型推理配置](docs/Provider协议与模型推理配置.md)
- [Runtime 独立性审计](docs/Runtime独立性审计.md)
