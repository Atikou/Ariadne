# @ariadne/protocol

`@ariadne/protocol` 是 Electron 宿主与独立 Ariadne Runtime 唯一共享的契约包。它使用 Zod 对所有入站消息做严格校验，不依赖 Electron、React、数据库、模型客户端或 Runtime 内部实现。

协议分为两个边界：

- `@ariadne/protocol/public`：允许经 Preload 投影到 Renderer 的命令、结果、事件与公开 DTO。
- `@ariadne/protocol/host`：仅供 Electron Main 与 Runtime 子进程使用的启动、请求、响应、事件和关闭消息。

公开协议不包含 Base64 文件、绝对路径、凭据、端口、PID 或任意方法名。文件和图片只允许以资源引用跨越边界。当前协议版本为 `1.0`，单条 IPC 消息上限为 8 MiB，以覆盖公开 2,000,000 字符消息契约并继续拒绝无界消息。

Public Projection v3 是独立的原子读模型契约。Snapshot 携带
`streamId + cursor + cursorDigest`；增量读取必须回传
`afterCursor + afterDigest`，并只接受连续、整批有界且每个 Commit 都通过
公开内容校验的结果。cursor 0 使用固定 genesis digest，显式重建、迁移或
恢复到不同历史必须旋转 `streamId`。

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```
