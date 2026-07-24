# Ariadne P0/P1 验证说明

> 状态日期：2026-07-24。自动回归不能替代真实模型、正式签名或干净机器验收。

## 1. 开发门禁

协议发生变化后必须先构建 Protocol，再检查或测试下游。根命令已经固定该顺序：

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run audit:runtime-independence
npm.cmd run verify:release-contract
npm.cmd run test:electron
```

当前证据：

| 层 | 自动测试 | 结果 |
|---|---:|---|
| Protocol | 18 | 通过 |
| Runtime | 162 | 通过 |
| App | 163 | 通过 |
| 合计 | 343 | 通过 |

全量 TypeScript 检查、Runtime 独立性审计、发布契约静态检查，以及真实 Electron 窗口加真实 Runtime 子进程冒烟均已通过。精确数量以当前命令输出为准。

## 2. P0 自动覆盖

- Protocol 2.0 的 Public、Host、Headless 严格 envelope、未知字段和版本拒绝。
- `RunAggregate` typed command、非法转换、`expectedAggregateVersion` 竞争和 `recovery_required`。
- aggregate、checkpoint、tool ledger、domain event outbox 的事务提交。
- outbox 断线、重启、缺口、分页、重复事件及消费者幂等。
- 单 revision `runtime.snapshot.get`、`events.replay` 和 Renderer 的 `eventId + aggregateVersion` 投影。
- Zod 4 `ToolContract` 的嵌套字段、枚举、必填、未知字段和输出校验。
- native tool 与文本 fallback 到同一 `AgentAction`，以及最多两次无副作用协议修复。
- 安全只读工具并发、资源冲突串行、取消、超时、部分失败和结果顺序。
- 工具 intent/start/result checkpoint、幂等键、文件哈希恢复和不确定副作用阻塞。
- 文件、网页、命令输出、Diff、MCP、SubAgent 的指令权限隔离及 secret egress gate。
- Browser 服务健康与工具注册一致性。
- 11 类隔离工作区 Eval 场景。

## 3. P1 自动覆盖

- 精确/保守 TokenCounter、输出与工具 Schema 预留、超大 section 跳过。
- GGUF Embedding 接口、严格摘要 Schema、记忆生命周期及 list/get/update/delete。
- TS/JS、JSON/Markdown、Python、C# fixture，LSP 假服务、Tree-sitter fallback 和 Repo Map。
- MCP Streamable HTTP、HTTPS 限制、ToolContract 适配、原生沙箱双工 STDIO、Main-owned OAuth/PKCE、state/授权拒绝、凭据加密、崩溃和工具变更通知。
- Skills 指令优先级，session/run/model/tool/subagent/stop Hook 的超时、拒绝和 delivery 去重。
- Resource Registry 内容寻址、opaque DTO、更新与删除。
- Browser 安全默认值、动态能力和 Runtime 工具适配。
- Headless NDJSON 的 cursor、重连、取消、`--once` 与退出码。
- Task Checkpoint compare/restore 的账本范围与哈希冲突。
- Provider 限流、退避、熔断和首 token 后不可透明重试。
- OTel endpoint allowlist 与属性脱敏。
- 数据库迁移前备份、事务回滚及新 Schema 拒写。
- NSIS 生命周期和发布资产静态契约。

Windows 原生 Sandbox helper 还需独立构建并执行受限 Runner 冒烟；当前工作树的协议输入、Broker pipe、路径别名/Junction/Symlink、资源限制和受限 Runner 均已通过：

```powershell
npm.cmd run sandbox:native:build --workspace @ariadne/runtime
dotnet run --project runtime/native/Ariadne.WindowsSandbox.RunnerSmokeTests/Ariadne.WindowsSandbox.RunnerSmokeTests.csproj -c Release --no-build
```

## 4. Runtime 独立性

```powershell
npm.cmd run audit:runtime-independence
```

该审计只读取当前工作树，验证：

- workspace 与 `file:` 依赖不越出当前仓库；
- Runtime 不创建入站 HTTP Server、不监听端口；
- 构建与发布脚本不引用仓库外实现；
- Electron Main → Node IPC → Runtime 是桌面应用唯一执行路径。

它不替代功能测试、真实窗口或发布机验收。

## 5. 真实 Electron

```powershell
npm.cmd run test:electron
```

该命令使用隔离的临时 `userData` 启动真实 Electron 和真实 Runtime 子进程，验证主 Renderer、固定 Preload、Runtime ready、单快照/事件状态流、工作区与会话、设置、Dockview Popout 安全边界及 Renderer 控制台。

证据输出：

- `artifacts/electron-runtime-smoke/electron-runtime-smoke.json`
- `artifacts/electron-runtime-smoke/electron-runtime-smoke.png`

这项测试没有注入真实远程/本地模型，也没有覆盖真实网站下载或正式安装器。

## 6. 发布门禁

只检查无需证书的静态契约：

```powershell
npm.cmd run verify:release-contract
```

正式门禁：

```powershell
npm.cmd run verify:release
```

`verify:release` 依次执行依赖审计、发布契约、Protocol、Runtime、App、独立性、真实 Electron、签名环境、Windows 安装包构建、打包 Runtime/模型/Sandbox 资产校验和 Authenticode 产物校验。缺少证书、固定模型资产或受信任 helper 时必须失败，不能降级成“跳过但通过”。

NSIS 行为：

- 安装、升级和卸载前回收残留应用及 Sandbox helper；
- 静默卸载默认保留用户数据；
- 交互卸载只有用户显式确认才删除用户数据；
- 数据库升级前备份，失败回滚；降级通过恢复版本化备份完成。

## 7. 尚未验收

- 真实远程 Provider 与真实本地聊天模型：工具、权限、计划、取消、强杀恢复。
- 实际 BGE-M3 GGUF 资产的多语言语义召回。
- 签名原生 helper 下的真实 MCP STDIO 服务，以及真实远程 OAuth 首次授权、刷新、撤销和断线恢复。
- Browser 真实 HTTPS、重定向、敏感输入和下载隔离。
- 真实 OTLP collector。
- 正式签名应用、安装器和 Sandbox helper。
- 干净 Windows 机器上的全新安装、N-1 升级、迁移失败回滚、备份降级和卸载。

逐模块状态由 [verification-matrix.json](verification-matrix.json) 记录；`not_accepted` 不能因单元测试通过而改成 `verified`。
