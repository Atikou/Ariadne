# Renderer UI 架构

> 核对日期：2026-08-29

Renderer 使用 React 与 Dockview。业务状态只来自 Public Projection v3；文件、终端、设置等桌面能力通过固定 Preload API 调用 Electron Main。

## 模块边界

| 模块 | 当前数据来源 | 边界 |
|---|---|---|
| Chat | v3 Session、Message、Model Projection | 创建、重命名、归档/恢复会话，发送消息，选择执行模式和模型 |
| Session Activity | Conversation/Run Projection | 只读会话活动 |
| Agent Status | Run Projection | 展示状态并发出 v3 Cancel |
| Plan / Permission | Decision Projection | 使用 opaque action token 发出 v3 Decision |
| Tool Output | Run Activity Projection | 展示已公开的 Tool 活动 |
| Logs | 当前可用的公开诊断行 | 尚无完整生产 Diagnostics publisher，不应宣称持久 Runtime 日志 |
| Files | Main 的受限工作区文件服务 | 只使用授权 `workspaceId` |
| Terminal | Main 管理的 node-pty 会话 | 桌面能力，不等于 Agent 的持久终端 Tool |
| Settings | Main 的设置仓库 | Provider、工作区、权限模式和桌面偏好 |

Agent Status 已消费 one-shot/continuable SubAgent 的 Parent/Child Run Projection，并为等待输入的 continuable Child 提供 direct-parent follow-up、为运行中 Child 提供非终态 interrupt。Settings 可配置 fresh-process ACP one-shot Provider。旧 Background Task 已删除；Scheduler、Memory 管理、批量 Child、外部 continuable/Codex/Claude Provider 当前仍没有 v3 product consumer，不应增加占位按钮或用本地 Mock 伪装成可用能力。

## 状态流

```text
startup
  -> projection.snapshot.get
  -> initialize Projection cache at one revision/cursor
  -> projection.commits.read(afterCursor)
  -> idempotently apply ordered commits
```

Renderer 当前只发送：

- `conversation.session.create.v3`；
- `conversation.session.rename.v3`、`conversation.session.archive.v3`、`conversation.session.restore.v3`；
- `conversation.message.accept.v3`；
- `agent.decision.resolve.v3`；
- `agent.run.cancel.v3`；
- `agent.inbox.*.v3` 与 direct-parent SubAgent 控制命令。

Renderer 不读取 Host DTO，不访问 Runtime 源码，也不使用旧 `runtime.snapshot.get`、`events.replay` 或分散 Proposal/Permission/Plan 列表修补状态。

发送消息时，Renderer 可维护按 `messageId` 关联的临时 pending overlay；正式 Projection 到达后必须原位替换。临时状态不能创建 Run、Decision 或业务终态。

## 窗口模型

- 默认只有一个主 Renderer；所有模块注册到 Dockview。
- Popout 只承载被移动的模块，不创建第二 Runtime 连接或第二业务 Store。
- Popout 不装载 Preload，不属于 IPC 授权主体；模块逻辑仍由主 Renderer 的服务拥有。
- Main 对新窗口、导航和资源协议执行 allowlist。

## 交互原则

- 所有业务状态必须可追溯到 Public Projection；不使用 Mock 任务或伪造执行进度。
- Session title/status 是 Conversation Authority；本机导航存储只拥有 pin/unread，不能覆盖 Projection 生命周期。
- Permission/Plan 只展示 Runtime 提供的 sanitized Decision presentation；Renderer 不推断权限范围。
- Runtime 不可用时禁用真实操作并显示稳定诊断，不自动切换到本地替代状态。
- Workspace 导航偏好不提升文件、终端或 Agent 权限。
- 模块布局与业务状态分离；恢复 Dockview 布局不能改变 Run/Session 所有权。
- 界面正文和状态使用中文；Agent、Runtime、API、模型名与快捷键可保留英文。

当前真实窗口验收只覆盖桌面壳与 Conversation/Projection；完整 Agent 交互边界见 [验证说明](verification.md)。
