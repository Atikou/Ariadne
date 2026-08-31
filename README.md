# Ariadne

Ariadne 是 Electron 桌面 Agent 应用。本仓库是协议、Runtime、桌面应用、测试和发布资产的唯一源码来源。

## 当前生产架构

```text
Renderer Feature Stores
  -> fixed sandbox Preload
  -> Electron Main
  -> Protocol 3.0 Node IPC
  -> ComposedRuntimeIngress
       |-> Runtime Kernel（状态、模型目录与推理网关）
       `-> Agent Control（Conversation、Run、Decision、Effect、Projection）
```

- `app/`：Electron Main、Preload、Renderer，以及窗口、文件、终端、Browser 和安全存储等桌面能力。
- `packages/protocol/`：Public、Host、Headless 与 Settings 契约。
- `packages/agent-core/`：Run、Turn、Inference、Decision、Effect、Plan、Budget 和 Child Run 的领域与应用规则。
- `runtime/`：Runtime Ingress、Control、Composition 与具体 Adapter。
- `scripts/`：架构、独立性、打包、签名和发布门禁。

Renderer 只消费 Public DTO；Main 拥有 OS 能力、凭据和 Runtime 生命周期；Runtime 不启动入站 HTTP Server。Conversation、Agent Control、Runtime command journal 和 Public Projection 分别拥有自己的持久化边界。

当前 Agent 产品使用的 Public 命令面收口为：

- Runtime 状态；
- Projection 快照与 commit replay；
- v3 Session 创建与 Message 接收；
- v3 Decision 处理；
- v3 Run 取消；
- v3 Agent inbox enqueue/replace/remove。

目录中仍存在的旧 Memory、Embedding 和旧 SubAgent 代码，不等于这些能力已经接入 v3 产品路径。Provider Resilience 已由共享协调器进入 exact v3 transport；旧 `ModelFactory` wrapper 不再被当作生产证据。旧 Background Task 第二进程表与可执行 JSONL Scheduler 均已删除。只有具备生产 Provider、Consumer、持久权威、公开投影、恢复测试并由 Runtime status 宣告的能力，才算产品能力。

## 开发验证

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test
npm.cmd run check:architecture
npm.cmd run audit:runtime-independence
npm.cmd run verify:release-contract
npm.cmd run test:electron
```

`test:electron` 当前通过真实 Electron 窗口、Preload、Main、Runtime 子进程、SQLite 和 Public Projection 执行确定性 Agent 产品门禁，覆盖 durable token/reasoning stream、direct、真实 Composer 中同一 Run 的运行中 inbox continuation、稳定 command receipt/权威对账、Agent `ask_user` 卡片回答与同 Run 续跑、Tool continuation、Decision allow/deny、运行中取消，以及 inbox response loss、user-question waiting、inference、effect、projection 五个持久边界的 Runtime 强杀恢复。它还用同一隔离 userData 验证未结算 enqueue 经 Main-only 系统加密 outbox 跨 Renderer reload 和完整桌面进程重启恢复为同 ID `reconcile`，且启动时不会自动重放。它使用进程外 HTTPS Provider fixture，不替代 Live Provider、本地模型、Browser/MCP、正式签名 Sandbox Helper 或干净机器发布验收。

正式发布门禁：

```powershell
npm.cmd run verify:release
```

该门禁在缺少模型资产、签名环境或安装包验收条件时 fail closed。自动测试通过不等于正式发布已验收。

## 当前主要不足

- 持久化 UoW 仍是大型热点，但 SQLite 串行化、事务、deadline 与 owner lease 已抽成共享 transaction owner；Factory 的执行装配也已拆出，门禁上限同步收紧到 Agent UoW 5000、Conversation UoW 2025、Factory 830 行；
- Agent inbox、运行中 steer/follow-up 和可恢复 token/reasoning 流已接入；未结算发送回执可跨 Renderer/桌面重启恢复且不会自动重放；仍缺独立 context injection；
- exact Provider 请求和输出已形成类型化内容块：历史 Tool exchange 会从受保护 Effect 输入恢复并原生投影到 OpenAI/Anthropic/本地模型，响应侧支持 `text/reasoning/tool_call`、finish、脱敏 replay evidence 和互斥 cache usage；Conversation 图片以内容寻址引用持久化，按精确 Message owner 读取并原生发送到 OpenAI/Anthropic，仍缺可复用 adapter-private replay state；
- v3 已接入 Conversation 历史、确定性因果语义 compaction、可恢复 Tool result spill、request-envelope-bound Provider usage anchor 和有界 Provider overflow recovery；每个精确 binding 都提供 route-local tokenizer，嵌入式 llama.cpp/Transformers 复用实际 chat-template tokenizer，source/primary/recovery 会重新计数并按硬输入上限准入。真实本地 Qwen 3.5 已完成跨进程重启长上下文验收；真实远程 Provider 因本机无 credential 尚未执行；
- one-shot/continuable ordinary Child 与原子批量 Child 已复用同一生产链；公开 list/status/send/interrupt 与冻结 Provider seam 已接入；Settings 可配置 fresh-process ACP（含加密 session reconnect）、Codex app-server 和 Claude Code one-shot Provider；Codex 已有本机真实产品验收，Claude 商业登录态仍需可选 live gate；
- bootstrap 冻结的 Capability Manifest 已统一 Tool Catalog、公开能力、Provider service 依赖解析和关机顺序；Provider 只能读取显式声明的依赖，默认 Factory 只消费类型化 Runtime service bundle；仍未接线的 Public Capability 会被自动审计但不会被宣告；
- Skills 已具备静态 Provider、可取消 scoped snapshot/last-good、固定 package 资源读取和 model/user invocation policy；人类 Skill 命令目录从同一快照过滤并在命令面板中独立加载，不启动 Agent。8 个 typed Hooks 由 Manifest-owned 静态可信 Provider service 管理并统一关闭；外部动态 Hook 包发现仍有意不开放；
- Main Credential Authority 统一 `resolve/describe/update`：模型只在每次推理操作边界用 opaque ref 解析一次，MCP OAuth 也经同一 Main owner 代理，ACP 保持 external/unmanaged 且不继承 ambient secret；API key 热轮换不重启 Runtime，secret 不进入 bootstrap、日志或 Public Projection；
- Goal/Todo/Workflow/Schedule 已进入 v3：同 Session Goal CAS、完整 Todo 快照事件、带并发/转换预算/deadline/cancel/quiescence/结构化结果的受限 Workflow，以及可跨重启恢复的 durable occurrence；投递可重试，普通 Conversation Turn 由稳定 command/message ID 保证幂等接收。旧 JSONL Scheduler 仅保留显式迁移读取，生产启动不再 arm 或创建旧 `scheduled` Run；
- Agent 可通过 `ask_user` Directive 发起结构化问题：问题正文/选项保存在受保护载荷，Run 进入 durable `waiting/user_question`，Public Projection 只发布脱敏 `question` 展示；Renderer 的回答以精确 Decision action 写入，并与 `next_step` inbox 输入在同一事务提交。确定性 HTTPS Provider 驱动的真实 Electron 卡片回答、`waiting/user_question` 强杀恢复与同 Run 续跑已经通过；仍缺真实商业 Provider、自由文本窗口场景和取消等待问题的产品语义；
- Agent pipe process、沙箱内 Agent PTY 与用户 PTY 已共用 `@ariadne/live-work` 生命周期；native Windows Sandbox runner 支持交互 write/resize 与 `interrupt/terminate/kill`，信号帧和真实长运行 PowerShell Job 已通过 Runner smoke。Main 以原子 session journal 保存无正文元数据；强杀后旧 `running` 收敛为 `interrupted/main_process_lost`，真实 Electron 窗口只允许用户显式重启并记录 `restartOf`，不会自动重放命令。live-work 终态仍先进入统一 Agent inbox，再唤醒 scheduler/projection；旧第二进程表和幽灵 Scheduler contract 已删除。
- Workspace Tool Catalog revision 18 已提供 bounded literal `search_text`、安全 `glob`、版本化 `apply_text_edits/move_file/delete_file`，以及由沙箱内持久 `typescript-language-server` 提供的 definition/reference/hover/document-symbol 查询；全部文件变更继续要求 opaque version CAS，目标路径不允许覆盖。Tool 终态只在 Public Projection 发布 `detailAvailable` 与固定 kind/label，正文仍由 Agent Control 的受保护 Effect result owner 按 Run/Workspace/effect 和 UTF-8 cursor 提供；Renderer 已有 read/search/diff/terminal 专用详情卡，不再复制正文到公开投影。

完整证据和实施顺序见 [Ariadne 与 deepseek-harness 对比审计](docs/deepseek-harness-comparison-audit-2026-08-28.md)。

## 文档

- [文档索引与有效性规则](docs/README.md)
- [当前实现架构](docs/architecture.md)
- [目标架构与不变量](docs/architecture-v3.md)
- [项目结构](docs/project-structure.md)
- [验证说明](docs/verification.md)
- [机器可读验收矩阵](docs/verification-matrix.json)
- [Renderer UI 架构](docs/ui-architecture.md)
- [Provider 与模型推理配置](docs/Provider协议与模型推理配置.md)
- [v3 长上下文生命周期](docs/long-context-v3.md)
- [Runtime Capability Manifest](docs/capability-manifest.md)
- [Runtime 独立性审计](docs/Runtime独立性审计.md)
- [Companion 能力请求协议](docs/agent-proposal-protocol.md)

架构决策记录位于 [`docs/adr/`](docs/adr/README.md)。
