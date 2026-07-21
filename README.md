# Ariadne

Ariadne 当前是一个干净的 Electron 桌面壳。现阶段只提供桌面显示和系统能力，不接入 Runtime，不包含 Agent、模型、记忆、工具编排或后端通信实现。

## 当前目录

```text
project/
├─ app/                  # 当前唯一参与构建的 Electron 桌面应用
├─ runtime/              # 空占位；当前没有实现，也不参与构建
└─ packages/
   └─ protocol/          # 空占位；当前没有协议包，也不参与构建
```

桌面壳目前保留：

- Electron Main、Preload、Renderer 的安全隔离；
- 文件树、集成终端、剪贴板、托盘、窗口和系统能力；
- 主题、偏好和 Dockview 布局持久化；
- Chat、会话、Agent 状态、执行计划、工具输出、日志、权限、文件、终端和设置模块；
- 未接入 Runtime 的业务模块只保留界面边界、空态和禁用态，不生成模拟业务数据。

明确不存在：

- Runtime 子进程和子进程 IPC；
- Agent/模型/记忆/工具/任务实现；
- 本地 HTTP Server、端口监听和 HTTP/SSE 适配器；
- Renderer 到后端、数据库或任意文件系统 API 的直连；
- 模拟后端、虚假任务、虚假执行进度或伪造的工具输出。

## 开发命令

```powershell
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

只有 `app/` 是 npm workspace。未来开始 Runtime 阶段时，必须先按 [Runtime 接入 TODO](docs/Runtime接入-TODO.md) 建立协议和验收边界，再把 `runtime/`、`packages/protocol/` 加回构建。

## 文档

- [当前与目标架构](docs/architecture.md)
- [项目结构](docs/project-structure.md)
- [桌面壳 UI 架构](docs/ui-architecture.md)
- [Runtime 接入 TODO](docs/Runtime接入-TODO.md)
- [双项目融合方案](docs/双项目融合方案.md)
- [验证说明](docs/verification.md)
