# Ariadne 架构

## 当前状态

当前仓库只实现完整的 Electron 桌面壳：

```text
Renderer
  → 固定 Preload API
Electron Main
  → 桌面系统能力
```

Main 目前只负责窗口、托盘、偏好、布局、剪贴板、受限工作区文件树和集成终端。Renderer 开启 sandbox 和 context isolation，不能直接访问 Node.js、数据库或文件系统。

当前不存在 Runtime 进程、Runtime IPC、Agent 业务、模型调用、本地 HTTP Server 或端口监听。

桌面壳保留原 `apps/desktop` 的全部界面模块和交互效果。Chat、会话、Agent 状态、计划、工具输出、日志和权限模块当前由 Renderer 内的 `MockScenarioStore` 提供纯 UI 演示状态；这些状态不发起网络请求、不执行 Agent 任务，也不代表 Runtime 已接入。

## 未来目标

Runtime 正式接入后的目标仍是：

```text
Electron Renderer
  → Electron IPC
Electron Main
  → 子进程 IPC
Runtime
```

```text
app      = 显示 + 输入 + 权限确认 + 桌面能力 + Runtime 生命周期
runtime  = Agent + 模型 + 记忆 + 工具 + 任务 + 实际功能
protocol = app 与 Runtime 之间唯一的通信边界
```

这只是目标边界，不代表当前已实现。

## 当前桌面壳边界

- Main 不放置 Agent、模型、记忆、工具或任务编排逻辑。
- Preload 只暴露按能力命名的固定 API，不暴露通用 `ipcRenderer`。
- Renderer 不直接读取文件路径、执行 Node API 或访问任意传输。
- 工作区文件树由 Main 限制在配置根目录内。
- 终端会话由 Main 按 WebContents 所有权管理并在退出时释放。
- 桌面状态和布局与未来 Runtime 数据完全分离。
- Renderer 本地 Mock 只用于保留和验证桌面交互；未来接入 Runtime 时由协议事件替换，不迁入 Runtime 业务实现。

## 未来不可违反的边界

- 不启动本地 HTTP Server，不监听本地端口。
- app 与 Runtime 只能依赖 `packages/protocol`，不能互相引用内部源码。
- Main 只做进程生命周期、协议转发、资源登记和桌面能力。
- 文件和图片只传资源 ID 或 Main 创建的受控引用，不传 Base64。
- 模型流式增量必须在 Runtime 合并后跨进程发送。
- 大文件和 CPU 密集工作必须在 Runtime Worker 中执行。
