# Ariadne

Ariadne 是一个以 Electron 为桌面宿主、以独立 Node 子进程承载 Agent 能力的桌面应用。Agent 核心完整维护在本项目的 `runtime/` 中，桌面端不依赖外部源码仓库、Mock、本地 HTTP 或端口通信。

## 架构

```text
Electron Renderer
  └─ 固定、类型化的 Preload API
       └─ Electron Main
            ├─ 桌面能力：窗口、托盘、终端、剪贴板、工作区文件
            └─ RuntimeSupervisor
                 └─ Node IPC
                      └─ Ariadne Runtime
                           ├─ Companion / Agent / 模型
                           ├─ 上下文 / 记忆 / 计划 / 工具
                           ├─ 权限 / 调度 / 追踪
                           └─ Runtime 独占持久化
```

- `app/`：Electron Main、Preload、Renderer 和桌面系统能力。
- `packages/protocol/`：App 与 Runtime 唯一共享的版本化协议。
- `runtime/`：Ariadne 自有的 Agent、模型、上下文、工具、权限、计划与存储服务。
- `runtime/native/`：Windows 原生沙箱及其烟雾测试工程；不包含旧 DesktopHost。

Renderer 只看到公开 DTO，不会获得 PID、端口、令牌、密钥或私有绝对路径。Main 只管理 Runtime 生命周期和协议转发，不承载 Agent、模型、记忆或工具编排逻辑。

## 开发与验证

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd run audit:runtime-independence
npm.cmd test
npm.cmd run build
npm.cmd run test:electron
```

`test:electron` 会启动真实 Electron 窗口和真实 Runtime 子进程，验证 Preload 桥、Runtime 就绪、工作区与新建会话主按钮可见、通过界面在当前工作区创建会话、工作区会话树及折叠/展开、紧凑会话行、悬停详情、双击重命名、置顶、消息文本保真、无模型时的 Chat 引导、四档权限菜单、设置页 Provider/API Key 表单、`settings.toml` 落盘、Dockview 模块拖出/回停、Popout 不具备高权限 Preload 桥、外部窗口白名单和 Renderer 控制台错误，并输出截图与 JSON 到 `artifacts/electron-runtime-smoke/`。

## Provider 与模型设置

远程模型接入按 `Provider → Protocol → Model profile` 分层。OpenAI、DeepSeek 与 Kimi 当前复用 Ariadne 自己实现的 `openai-compatible` transport，不依赖 OpenAI SDK；Anthropic 默认使用原生 `anthropic-messages` adapter。每个 Provider 使用独立 API Key 槽位，后续新增厂商不需要修改 Chat 协议。

设置页当前支持 OpenAI、DeepSeek、Kimi、Anthropic 与本地模型目录。实际配置写入 Electron `userData/settings.toml`，API Key 通过系统安全存储加密，Renderer 只能看到“已配置/未配置”状态。模型的推理模式和强度由 TOML 中的 profile 声明；Chat 切换模型时只显示该模型支持的选项。Chat 权限菜单提供请求批准、风险审批、完全访问和 TOML 自定义四档。

本地模型由 Ariadne Runtime 通过内嵌模型运行时直接发现、加载和启动，不连接也不依赖 Ollama、LM Studio、vLLM 等外部应用。`openai-compatible` 只用于远程 API transport，不作为本地模型进程间协议。

开发环境会从 `npm_node_execpath`、`NODE` 或 `PATH` 查找独立 Node。可选配置必须使用绝对路径：

- `ARIADNE_RUNTIME_ENTRY`：仅开发态覆盖 Runtime 入口。
- `ARIADNE_RUNTIME_NODE_EXECUTABLE`：仅开发态覆盖 Runtime 的 Node 可执行文件。
- `ARIADNE_MODEL_ROOTS`：仅开发态按平台路径分隔符指定一个或多个外部模型目录；打包态模型目录来自持久化设置。
- `ARIADNE_RUNTIME_PROFILE`：仅开发态选择 Runtime 配置档，默认 `default`。

## 当前交付边界

项目内 Runtime、协议、进程联调、独立性审计、真实窗口冒烟测试，以及带 SHA-256 校验的独立 Node runner 与 Runtime 生产依赖装配流水线已完成。正式安装包发布前仍需完成 Windows 原生沙箱正式签名、Transformers Runtime 装配、真实模型及工具审批全链路验收、升级/回滚和安装包签名验证。未完成这些发布门槛前，不应把开发构建描述为可生产发布版本。

## 文档

- [架构设计](docs/architecture.md)
- [项目结构](docs/project-structure.md)
- [Renderer UI 架构](docs/ui-architecture.md)
- [Provider 协议与模型推理配置](docs/Provider协议与模型推理配置.md)
- [Runtime 独立性审计](docs/Runtime独立性审计.md)
- [Runtime 接入 TODO 与完成状态](docs/Runtime接入-TODO.md)
- [验证说明](docs/verification.md)
