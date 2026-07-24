# @ariadne/runtime

Ariadne Runtime 是桌面应用的独立 Agent 服务，负责 Companion、Agent 执行、模型、上下文、记忆、工具、权限、计划、后台任务、调度、持久化和追踪。

## 进程边界

- 由 Electron Main 通过 `child_process.fork` 启动。
- 只使用 `@ariadne/protocol/host` 定义的 Node IPC，不创建本地 HTTP Server，也不监听端口。
- 启动时接收 `installRoot`、`dataRoot`、模型目录和工作区；安装目录按只读处理，可变数据只写入 `dataRoot`。
- 同时处理最多 32 个请求；畸形协议、实例标识不匹配和重复启动消息均 fail-closed。
- 流式文本按 4096 字符或短时间窗口合并后再发送，避免逐 Token 刷新 Renderer。
- 长时间 Agent 执行在提案或审批状态落盘后异步继续；权限、计划、追踪、活动和终态消息由事件桥增量发布，不受单次公开请求超时约束。
- Host 注入的工作区读写级别是全局权限上限；只读工作区不能获得文件写入、删除、Shell 或危险操作批准。
- 关闭时先执行持久化准备与服务释放，再回传 `shutdown_complete`。

## 目录

- `src/application`：面向公开协议的 RuntimeFacade 与上下文装配。
- `src/transport`：Node IPC 宿主。
- `src/entry`：独立进程入口。
- 其余 `src/*`：Ariadne 自有的模型、Agent、上下文、工具、策略、计划、调度与存储能力。
- `native/`：Windows 原生沙箱工程，不含旧桌面宿主。
- `config/`：Runtime 配置模板。

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run sandbox:native:build
```

直接执行 `npm.cmd start` 时必须由父进程提供 IPC 通道；普通命令行启动会按设计拒绝运行。
