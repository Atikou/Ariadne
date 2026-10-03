# Renderer UI 架构

> 核对日期：2026-09-05

Renderer 使用 React 与 Dockview。持久业务状态来自 Public Projection；精确 Attempt 的实时 token/reasoning 是可丢失的显示增量，必须与持久 stream head 对账。文件、终端、设置等桌面能力通过固定 Preload API 调用 Electron Main。

## 模块边界

| 模块 | 当前数据来源 | 边界 |
|---|---|---|
| Chat | v3 Session、Message、Model Projection | 创建、重命名、归档/恢复会话，发送消息，选择执行模式和模型 |
| Session Activity | Conversation/Run Projection | 只读会话活动 |
| Agent Status | Run Projection | 展示状态并发出 v3 Cancel |
| Plan / Permission | Decision Projection | 使用 opaque action token 发出 v3 Decision |
| Tool Output | Run Activity Projection 与受保护 detail 查询 | 公共活动定位调用，正文经 owner 校验的 detail API 分段读取，不复制进公共投影 |
| Logs | 持久、脱敏的生命周期 Diagnostics Projection | 512 条 retention；不等于完整 Prompt/Tool 日志 |
| Files | Main 的受限工作区文件服务 | 只使用授权 `workspaceId` |
| Terminal | Main 管理的 node-pty 会话 | 桌面能力，不等于 Agent 的持久终端 Tool |
| Settings | Main 的设置仓库 | Provider、工作区、权限模式和桌面偏好 |

Agent Status 已消费 one-shot/continuable SubAgent 的 Parent/Child Run Projection，并为等待输入的 continuable Child 提供 direct-parent follow-up、为运行中 Child 提供非终态 interrupt。Settings 可选择 ACP、Codex app-server 或 Claude Code，并只暴露对应产品协议字段；批量 Child 共用同一 Parent 状态区和一次聚合续跑。“目标与工作流”模块消费 same-session Goal、Todo、受限 Workflow 与 durable Schedule，Schedule 只投递普通 v3 Conversation Turn。旧 Background Task 与可执行 JSONL Scheduler 已删除；Memory 管理和 structured SubAgent report 当前仍没有完整 v3 product consumer，不应增加占位按钮或用本地 Mock 伪装成可用能力。

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

此外，模型检测使用 `model.qualification.run.v3`，会话导航、分支和消息解析使用相应 query/reference API，工具正文使用 protected detail API，目标/工作流模块使用 productivity 命令。以上是按职责归类的入口，不是完整协议命令白名单；完整集合由 `packages/protocol` schema 和 Main/Runtime router 校验。

Renderer 不读取 Host DTO，不访问 Runtime 源码，也不使用旧 `runtime.snapshot.get`、`events.replay` 或分散 Proposal/Permission/Plan 列表修补状态。

发送消息时，Renderer 可维护按 `messageId` 关联的临时 pending overlay；正式 Projection 到达后必须原位替换。临时状态不能创建 Run、Decision 或业务终态。

`LiveInferenceStreamStore` 仅保留每个 Attempt 有界的连续后缀和待补齐片段。中途订阅或序号缺口触发现有 Projection 同步；过旧持久 head 不覆盖较新的连续 live 后缀，同 identity 的冲突仍报错。Attempt 使用 `committed`/`interrupted` 终态，不能重新展示为 streaming；最终答案仍来自 Message。Main 每次创建 Runtime 进程实例都重置临时投递游标，包含自动强杀恢复。

派生 Session、Model、Run、Decision、Diagnostics 按各自集合引用缓存，功能订阅只在所选字段变化时通知。连续 live token 以约 16 ms 的发布间隔合并，持久变更和终态立即发布；这是批量发布间隔，不是对渲染帧率的保证。历史 Message/ConversationNode 复用引用，消息行使用 memo；列表仍完整挂载当前会话，超长会话的首次布局成本仍需按产品规模考虑。

`desktop-default`、`desktop-no-speech`、`desktop-stt-only`、`desktop-tts-only` 均不包含 `review.visual`。可视化审查只属于显式 `desktop-preview`，面板读取当前会话的 Public Projection，工具详情仍按受保护 detail API 读取；Runtime health、恢复和权限基础设施不受此划分影响。

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

真实 Electron 门禁已覆盖 token 完成前可见、丢包/重复/重载恢复、工具与权限、运行中 inbox、主动提问、取消、五个 Runtime 强杀边界及完整桌面重启。五个 Profile 的窗口矩阵也已验证。受控 HTTPS Provider fixture 不代签真实模型、正式签名安装包或硬件语音验收；具体版本与证据见 [当前修复进度](architecture-review-and-remediation.md)。
