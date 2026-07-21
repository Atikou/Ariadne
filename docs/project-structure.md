# 项目结构

```text
Ariadne/
├─ app/
│  ├─ src/main/          # Electron 生命周期和桌面系统能力
│  ├─ src/preload/       # 固定、类型化的 Renderer 桥
│  ├─ src/renderer/      # 桌面 UI
│  ├─ src/shared/        # 仅限 app 内部的桌面 IPC 契约
│  └─ tests/             # 桌面壳测试
├─ runtime/
│  └─ README.md          # 空占位，不参与构建
├─ packages/protocol/
│  └─ README.md          # 空占位，不参与构建
└─ docs/
```

根 `package.json` 目前只注册 `app` workspace。`runtime` 和 `packages/protocol` 不包含 `package.json`、源码或构建产物，防止工程误认为后端已接入。

## app 内部职责

- `src/main/windows`：主窗口、安全选项和窗口状态。
- `src/main/ipc`：固定桌面能力 IPC 和 sender 校验。
- `src/main/persistence`：仅保存桌面偏好和布局。
- `src/main/services`：终端、受限工作区文件树和系统能力。
- `src/preload`：最小能力桥。
- `src/renderer/src/modules`：从原 `apps/desktop` 保留的完整桌面模块集合，包括 Chat 标尺、消息时间/复制/改写、会话管理、Agent 状态、计划、工具输出、日志、权限、文件、终端和设置。
- `src/renderer/src/core/mock`：仅供桌面壳交互与视觉验收的 Renderer 本地状态，不是 Server、Runtime 客户端或 Agent 实现。

以下目录当前不应出现：

- `app/src/main/runtime` 或后端适配器；
- `app/src/main/agent-*`；
- Renderer Agent store、Runtime 客户端、业务状态同步或任务执行实现；
- HTTP/SSE 客户端或本地 Server fixture。
