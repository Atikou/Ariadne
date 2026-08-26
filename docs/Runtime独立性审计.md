# Ariadne Runtime 独立性审计

> 最近核对：2026-08-26

## 结论

桌面生产链路为：

```text
Renderer -> fixed Preload -> Electron Main -> Node IPC -> Ariadne Runtime
```

当前自动审计通过：没有 Runtime server/public 目录、入站 HTTP 指标、仓库外 `file:` 依赖或根发布脚本外部路径。生产文件数量以命令输出为准。

这个结论只说明 Runtime 的源码、依赖和进程边界独立。它不说明目录中的每项能力都已接入 v3，也不证明真实模型、Tool、SubAgent、Memory、Scheduler 或发布包已经验收。

## 自动审计

```powershell
npm.cmd run audit:runtime-independence
```

审计 fail closed 检查：

- workspace 与 `file:` 依赖不越出仓库；
- 根构建/发布脚本不引用仓库外实现；
- Runtime 不创建入站 HTTP Server、不监听端口；
- 不存在 `runtime/src/server` 或 `runtime/public` 生产入口；
- 当前 Runtime 入口不依赖外部 Agent 源码。

## 审计边界

该命令不替代：

- `npm.cmd run typecheck` 与 `npm.cmd test`；
- `npm.cmd run check:architecture`；
- 真实 Electron Agent smoke（direct、运行中 inbox continuation、Tool、Decision、Cancel 与 Runtime 恢复）；
- Live Provider、本地模型、Browser/MCP 与正式签名 Sandbox helper 验收；
- Sandbox helper、模型资产、安装器和 Authenticode 验收。

完整分层见 [验证说明](verification.md)。
