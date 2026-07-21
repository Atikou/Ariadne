# 桌面壳 UI 架构

当前 Renderer 是完整的桌面工作区。它保留原桌面壳的模块、Mock 演示状态和全部交互，但不创建 Agent、调用模型或连接 Runtime。

## 模块

| 模块 | 数据来源 | 当前职责 |
|---|---|---|
| Chat | Renderer 本地 Mock | 保留消息区、对话标尺、跳转最新消息、时间、复制、改写、输入和附件交互 |
| 会话 | Renderer 本地 Mock | 保留新建、搜索、收藏、重命名、删除和选中状态 |
| Agent 状态 | Renderer 本地 Mock | 展示可切换的任务、上下文、进度和控制状态 |
| 执行计划 | Renderer 本地 Mock | 展示计划步骤和进度 |
| 工具输出 | Renderer 本地 Mock | 展示结构化工具结果 |
| 日志 | Renderer 本地 Mock | 展示桌面壳日志样例，不读取 Runtime 日志源 |
| 权限 | Renderer 本地 Mock | 展示桌面审批交互，不向 Runtime 提交决定 |
| 文件 | Main 的受限工作区文件服务 | 浏览目录树，不读取文件内容 |
| 终端 | Main 管理的终端会话 | PowerShell/CMD 交互和会话切换 |
| 设置 | 桌面状态仓库和系统能力 | 主题、后台常驻、登录启动、安全边界说明 |

## UI 原则

- Dockview 负责模块布局、分组和持久化。
- Activity Bar 和命令面板保留完整桌面模块入口。
- 状态栏明确标识本地 Mock，不能把演示状态标记为真实 Runtime 连接。
- 本地 Mock 只用于桌面壳开发与回归验证，不调用模型、工具或任务执行逻辑。
- 未接入模块不得调用 Main、Preload 或临时 HTTP 服务获取 Agent 业务数据。
- 后续接入 Runtime 时，新增模块必须只消费协议层暴露的能力，不能直连子进程。
