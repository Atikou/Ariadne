# Ariadne 与 deepseek-harness 对比审计

> 状态：Completed comparison audit; P0 real Agent acceptance fixed and verified
> 日期：2026-08-26
> Ariadne 审计对象：本文所在的 `main` Git commit；审计起点为 `4d23bd3dbe1bed23d8ea290b9c2cb12dafd93923`
> deepseek-harness 参照提交：`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`（`dsh@0.1.1-rc.2`）
> 范围：架构、生产接线、Agent 交互、上下文、工具、SubAgent、扩展机制和验证边界
> 约束：不把目录存在、类型存在或孤立测试视为产品能力；第 6.1 节记录审计后的已验证修复

## 1. 结论

Ariadne 当前已经是一套可靠性较强的桌面 Agent 控制内核，但还不是一套完整、可组合、可持续扩展的 Agent Harness。

两者的主要差异不是“有没有 AgentLoop”，而是系统优化目标不同：

- Ariadne 优先解决桌面安全边界、单一业务 Owner、事务一致性、崩溃恢复、精确权限和公开投影；
- deepseek-harness 优先解决能力组合、事件扩展、Agent 运行时交互、Provider 替换和插件生态。

Ariadne 不应照搬 deepseek-harness 的 Cordis 或“everything is a plugin”，但应借鉴以下三项设计：

1. **显式 Capability Seam**：能力必须同时定义 Service Definition、Provider、Consumer 和生命周期；
2. **统一 Agent/Event Spine**：运行中输入、模型流、Tool 活动和最终结果具有稳定、可重放的事件语义；
3. **能力按需装配**：工具、Skills、SubAgent、终端、后台任务和上下文策略由组合清单决定，而不是散落在巨型工厂和静态枚举中。

当前最高优先级不是继续增加功能，而是：

1. 在已固定的可复现基线上保持小步、可验证提交；
2. 防止持久化与 Composition 热点重新汇聚；
3. 建设 Agent inbox/event spine、上下文压缩和能力装配边界。

原 P0“真实 Agent Electron 验收不足”已在本审计后修复，当前证据见第 6.1 节。

## 2. 审计基线

### 2.1 deepseek-harness 参照边界

本审计固定使用提交：

- Commit：[`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`](https://github.com/deepseek-ai/deepseek-harness/commit/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e)
- Release merge：`dsh@0.1.1-rc.2`
- 提交时间：2026-08-21

固定提交的目的，是避免 `master` 后续变更导致审计结论漂移。

deepseek-harness 自身仍标记为 developer preview，并明确允许破坏性变更。因此本审计只把它作为架构和能力参照，不把它视为生产成熟度基准。

关键上游资料：

- [README](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/README.md)
- [Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/architecture.md)
- [Capability Seams](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/capability-seams.md)
- [Extension Cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/cookbook/extension-cookbook.md)
- [SubAgent Capability Family](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/subagent/README.md)
- [Windows ACL Sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/sandbox/sandbox-windows-acl/README.md)

### 2.2 Ariadne 快照边界

本审计最初针对未提交工作树。该状态现已作为本文所在的 `main` commit 固定；下表保留审计起点数字，仅用于说明修复前为什么无法由 HEAD 重建。

修复前状态：

| 指标 | 当前值 |
|---|---:|
| 分支 | `main` |
| HEAD | `4d23bd3b...` |
| tracked 变更项 | 200 |
| untracked 状态项 | 123 |
| untracked 文件 | 291 |
| tracked diff | 8,465 additions / 12,608 deletions |

修复后，517 个源码、测试、文档和配置变更均进入同一个经过验证的基线 commit；没有把 artifacts、日志、运行数据库、本机绝对路径或真实凭据加入 Git。当前结论可以从本文所在 commit 干净检出并按第 3 节门禁复核。

## 3. 当前验证结果

本次重新执行了当前工作树的主要门禁：

| 验证项 | 结果 | 证据边界 |
|---|---|---|
| `npm.cmd run typecheck` | PASS | Protocol、Agent Core、Runtime、App 类型检查通过 |
| `npm.cmd test` | PASS | Protocol 39、Agent Core 97、Runtime 676、App 249，共 1,061 项 |
| `npm.cmd run check:architecture` | PASS | 845 个 TS/TSX 文件、3,387 条内部边、0 SCC、0 循环边、0 规则违规 |
| `npm.cmd run audit:runtime-independence` | PASS | 866 个生产文件；无 Runtime server/public 目录、无入站 HTTP、无仓库外文件依赖 |
| `npm.cmd run test:electron` | PASS | 真实窗口覆盖 direct、真实 Composer 运行中 inbox continuation、Tool continuation、Decision allow/deny、cancel，以及 inference/effect/projection 三个持久边界的 Runtime 强杀恢复 |

Electron 结果位于：

- `artifacts/electron-runtime-smoke/electron-runtime-smoke.json`
- `artifacts/electron-runtime-smoke/electron-runtime-smoke.png`

这些结果证明当前已覆盖路径稳定，但不证明所有 Agent 能力已经进入生产路径。

## 4. Ariadne 已有优势：必须保留

### 4.1 桌面进程与安全边界

Ariadne 当前稳定边界是：

```text
Renderer
  -> fixed sandbox Preload
  -> Electron Main
  -> Node IPC
  -> Runtime Ingress
  -> Control / Agent Core / Adapters
```

应继续保持：

- Renderer 不访问 Node、数据库、密钥、PID、端口和绝对路径；
- Main 拥有窗口、OS 能力、设置、凭据和 Runtime 生命周期；
- Runtime 不启动入站 HTTP Server；
- Public DTO 与 Host DTO 分离；
- Runtime capability 必须按真实生产接线宣告。

deepseek-harness 的 Web Profile、Web Server 和 HMR 不适合直接进入该边界。

### 4.2 持久控制面

Ariadne 已建立比普通 AgentLoop 更严格的持久控制语义：

- Run、Turn、Inference、Decision、Effect、Plan、Budget、Delegation 使用明确身份和版本；
- 外部 I/O 前先提交 intention/start；
- command replay、effect replay 和 provider idempotency 有明确边界；
- 不确定外部结果进入 `uncertain` 或 recovery，而不是默认重试；
- Conversation Handoff 使用持久 Saga、Inbox/Outbox 和固定点处理；
- Public Projection 使用 Snapshot + cursor replay；
- Renderer 不再负责补查或修复领域状态。

这些语义不能为了插件化而退回进程内事件或最终一致的内存 Map。

### 4.3 工具与权限的精确绑定

Ariadne 当前使用编译验证过的 immutable Tool Catalog，并将工具身份、版本、输入摘要、Workspace 和 Capability Grant 固定到 Run/Effect。

建议借鉴 deepseek-harness 的 Provider 注册方式，但不能取消 Ariadne 的：

- admission-time pin；
- exact tool identity；
- immutable authority snapshot；
- Process Sandbox；
- opaque Decision action token；
- fail-closed 执行和恢复。

## 5. 主要差距总览

| 优先级 | 差距 | 当前表现 | 目标结果 |
|---|---|---|---|
| 已修复 | 真实 Agent 验收不足 | 确定性真实窗口门禁已覆盖模型、Tool、Decision、取消和强杀恢复 | 保持为必跑门禁；另设可选 Live Provider gate |
| 已修复 | 当前重构不可复现 | 517 个变更文件已进入本文所在的可检出基线 commit | 后续修改保持小步提交，并由完整门禁验证 |
| 已修复 | 巨型热点迁移 | 命令路由、Tool family、outbox、execution intent、Conversation row/projection 已形成独立边界 | 由 Hotspot Boundary Gate 阻止职责和规模重新汇聚 |
| 已修复 | 统一运行中 Agent inbox | 同一 Run 已支持 durable next-turn/next-step、replace/remove、原子 claim 和 Public Projection | 后续独立建设不唤醒模型的 context injection |
| P1 | 无 v3 token/reasoning 流 | 公共 Projection 主要发布已提交最终状态 | Chunk 有稳定 attempt/sequence，并可重放或明确声明仅临时 |
| 部分修复 | 无生产 Context Compaction/Spill | Conversation 历史、确定性压缩、Tool result pruning、精确容量和 overflow recovery 已进入 v3 | 剩余：spill 引用恢复与精确 tokenizer |
| 部分修复 | SubAgent 产品闭环 | one-shot ordinary Child 已接通 Directive、原子创建、调度、结果回灌和父子投影 | 剩余：continuable/external Provider、Child 专用控制和真实窗口场景 |
| 已修复 | 能力装配硬编码 | 单一 bootstrap Manifest 驱动 Provider 图、Catalog、status、诊断与生命周期 | 保持静态、冻结、可审计；不引入任意磁盘动态加载 |
| 已修复 | Skills 全量注入 | bootstrap 固定 metadata/revision，正文只经 `skill.load` 进入受保护 continuation | 保持按需加载、版本核验和无脚本执行 |
| 已修复 | Hooks 仅有 `run.pre` | 8 个 typed v3 生命周期边界已接入，pre 可拒绝、post 只观察 | 保持稳定 delivery identity、去重和敏感数据零载荷 |
| P2 | 后台任务与终端缺失 | 一次性命令为主，无持久 PTY/Job 控制 | owner-scoped terminal、background job list/read/stop |
| 已修复 | Diagnostics/Telemetry 未闭环 | 生命周期诊断已脱敏、持久、可重放且有 512 条 retention；Telemetry 由启动成功的 Provider 宣告 | 扩展事件种类时继续保持 observer 与 authority 分离 |
| P2 | Provider Resilience 设置未落地 | schema 可配置，v3 Gateway 不消费 | Adapter 层统一 retry/rate-limit/circuit-breaker |

## 6. 差距详解

### 6.1 已修复：真实 Electron Agent 验收

当前 `test:electron` 已通过真实 Electron、Sandbox Preload、Main、Node IPC、Runtime、SQLite authority/outbox 和 Public Projection 执行完整确定性 Agent smoke。实现参考 deepseek-harness 的外部录制 fixture、稳定状态等待和精确 world-state 断言，但保留 Ariadne 的持久控制面与 fail-closed 权限边界。

当前门禁验证：

1. direct answer 形成带因果 `runId` 的 terminal assistant message；
2. 首轮推理期间从真实 Composer 排入输入，由同一 Run 的 continuation Turn 消费并在 UI 显示两轮 assistant response；
3. `workspace.read_file` 结果进入 Provider continuation；
4. `workspace.write_file` 在 allow 前无副作用、allow 后只写一次、deny 后不写；
5. 运行中 cancel 中止真实 Provider HTTP 请求，并通过持久 recovery evidence 收敛；
6. 独立只读 SQLite watcher 在 inference started、effect started、Agent authority completed/Public Projection pending 三个精确边界触发 Runtime 强杀；
7. 重启后分别收敛为 interrupted 或完成投影，没有重复 Provider 请求或文件写入；
8. fixture 精确记录 13 次 Provider 请求、11 次响应、2 次 abort，Renderer console 无错误。

Provider fixture 是进程外、确定性 HTTPS OpenAI-compatible 服务，经过生产 Provider adapter，但不是外部商业 Provider。失败时 smoke 保存结构化诊断和截图。

修复过程中还暴露并修正了两个真实生产边界缺陷：assistant Public Message 丢失因果 `runId`，以及 public cancel 无法中止进行中的 initial inference。初始推理强杀恢复也改为根据已持久化 started attempt 进入不确定恢复状态，而不是盲目重发。

#### 仍需独立建设：可选 Live Provider gate

只在具备外部凭据和网络的受控环境执行：

- 至少一个 OpenAI-compatible Provider；
- 一个直接回答；
- 一个 Tool call；
- 一个 Decision；
- 记录安全摘要，不持久化原始凭据、完整 Provider 输入或敏感输出。

### 6.2 已修复：复杂度从 Facade 转移到持久化和 Composition

旧 `RuntimeFacade.ts` 删除后曾出现新的集中热点。本轮没有再增加一层兼容 Facade，而是按稳定职责替换了这些边界；同一 UoW 的 SQLite transaction、owner lease、replay 和 fail-closed 语义保持不变。

修复前后：

| 原热点 | 修复前 | 当前 | 新边界 |
|---|---:|---:|---|
| `SqliteAgentRunUnitOfWork.ts` | 6,045 行 | 4,991 行 | `outbox/SqliteAgentRunOutboxStore`；`execution-intent` store、validation、row mapper |
| `SqliteConversationRunHandoffUnitOfWork.ts` | 2,276 行 | 1,923 行 | Conversation authority row mapper；只读 Projection reader |
| `DefaultAgentControlRuntimeFactory.ts` | 1,313 行 | 713 行 | 公开命令由 Router 分发；Tool/权限装配移交 bootstrap Capability Manifest |
| `AgentControlPublicCommandRouter.ts` | 940 行 | 658 行 | `AgentInboxPublicCommandHandler` 与 `AgentPublicCommandFailures` 已迁出，Router 保留协议路由和 replay/reconciliation |
| 旧 `FirstPartyAgentToolCatalog.ts` | 1,034 行 | 已删除 | Browser/MCP/Workspace Provider 各自贡献 Tool；238 行 Manifest compiler 统一校验和冻结 |

持久化子模块接收同一个 `DatabaseSync`，由外层 UoW 统一调度并在既有 transaction 内调用；没有按表拆成互相补偿的 Repository，也没有引入第二 Writer。

当前结构：

```text
adapters/persistence/agent-control/
  rows/
  execution-intent/
  outbox/
  SqliteAgentRunUnitOfWork.ts    # 事务、租约和 command-commit 边界

adapters/persistence/conversation/
  rows/
  projection/

composition/
  AgentControlPublicCommandRouter.ts
  first-party-tools/
```

防回归由 `npm.cmd run check:architecture` 中的 Hotspot Boundary Gate 执行。它不仅限制文件规模，还检查已迁出的职责没有重新定义回 Factory、Catalog 或 UoW。

已满足：

- 所有写入仍由同一 SQLite transaction 提交；
- 没有新增跨 Repository 补偿；
- crash/replay/owner lease 测试保持不变；
- schema migration 仍由独立 schema 模块拥有，row mapping、Projection read、outbox 和 execution intent 不再混在主 UoW；
- Architecture Gate 继续保持 0 SCC、0 rule violation。

`SqliteAgentRunUnitOfWork.ts` 仍然较大，但剩余主体是同一 command-commit/recovery 原子边界。本次不为追求行数把它切成跨 Repository 补偿流程；后续若继续拆分，应以独立 command fact/preparation 模块为单位，并继续复用唯一事务。

### 6.3 已修复：统一 Agent inbox 和运行中交互

当前 v3 公共命令新增：

- `agent.inbox.enqueue.v3`
- `agent.inbox.replace.v3`
- `agent.inbox.remove.v3`

同一 `AgentRun` 现在稳定表达：

- followup：`next_turn` 在响应边界领取最早一条；
- steer：`next_step` 在 Tool-result Step 或更早到达的响应边界领取全部；
- replace/remove：按 input version 修改尚未领取的排队消息；
- Provider inference 期间接纳输入，并在最新 Run version 上提交原 Provider 结果；
- crash/replay：claim 与 continuation Turn 原子提交，稳定 ID 防止重复消费；
- Public Projection：队列状态与同 Run 中间对话均可恢复，Renderer 只读投影。

实现借鉴 deepseek-harness 的 Agent handle、inbox、turn 和 step 语义，但没有复制进程内 Agent 对象。Ariadne 将输入接纳、版本、claim、Turn input、receipt 和投影保持在既有 durable authority 中。

当前领域边界：

```text
AgentRun.inbox
  next_turn
  next_step

InputState
  queued -> replaced | removed
  queued -> claimed (inside run.register_turn)
```

每一条输入绑定：

- `messageId/inputId`；
- `runId`；
- delivery；
- input version 和 content digest；
- claimed Turn；
- durable receipt。

完整不变量、权威链路和剩余非目标见 [Agent inbox 与运行中交互](agent-inbox.md)。独立 context injection、跨 Child Run inbox 和 token/reasoning stream 仍未完成，不随本项标记为已修复。

### 6.4 P1：模型流和可重放交互不完整

旧协议仍保留 `companion.reasoning.delta` 和 `companion.token.delta`，但 v3 Exact Inference 和 Public Projection 没有形成流式闭环。

必须先确定流的权威语义：

- partial token/reasoning 可以是临时 UI 数据；
- terminal assistant message 必须是持久权威；
- 如需恢复流式 UI，chunk 必须绑定 `attemptId + sequence`；
- Runtime 重启后不得把未知 partial 当成最终消息；
- Renderer 不得通过拼接多个来源推断最终内容。

推荐事件：

```text
inference.chunk.observed       # 可丢失，attempt-scoped
inference.message.committed    # 持久权威
inference.stream.interrupted   # 明确终止 partial
```

不要为了获得打字机效果而让每个 token 进入 Agent Control 主事务。

### 6.5 P1：Context Compaction、Tool Result Pruning 和 Spill 缺失

deepseek-harness 将以下能力拆成独立 seam：

- token pressure measurement；
- automatic/manual compaction；
- request overflow recovery；
- current tool-result pruning；
- oversized result spill store。

Ariadne 当前虽然有 TokenCounter、Context、Memory、Embedding 等旧实现或配置，但这些没有形成 v3 Production Control 的完整消费链。

风险包括：

- 长会话最终超过 Provider context window；
- 大型命令输出占满下一轮输入；
- 为了恢复而重复保存大块敏感 Tool 输出；
- 不同 Provider 使用不一致的裁剪策略；
- UI 显示“上下文压缩”但生产链没有唯一权威。

建议建立：

```text
ContextPressurePort
CompactionPlanner
CompactionArtifactStore
ToolResultPruner
SpillStore
```

验收标准：

- 压缩输入、摘要版本和被替换范围可重放；
- Tool Result spill 返回受权 locator，而不是任意绝对路径；
- 摘要失败不破坏原始会话；
- 相同 checkpoint 恢复不会重复压缩；
- 删除会话时能删除对应私有 spill/summary 数据。

### 6.6 部分修复：one-shot SubAgent 已形成生产闭环

Ariadne 当前生产路径已有：

- Child Run 普通聚合模型；
- 父子授权子集校验；
- Budget allocation/release；
- Delegation 和 Child terminal facts；
- 严格 `delegate_subagent` 模型 Directive；
- Parent 推理结果、Delegation、Budget 和普通 Child Run 的单事务提交；
- dedicated Child 首轮调度与 started-work recovery；
- Child terminal observation、protected `child_results` 回灌和 Parent 续跑；
- Parent/Child Public Projection 与 Agent Status 消费。

当前仍缺少：

- spawn/fork/external provider 选择；
- continuable child 控制；
- Child 专用公开取消和续接命令；
- 多 Child 批处理、超时和部分失败策略；
- 真实商业模型和真实 Electron SubAgent 场景。

第一种 Provider 已固定为 **in-process fresh child**。旧 `runtime/src/subagent` 不作为 fallback；fork、ACP、Codex 和 Claude Code 必须以后续独立 Provider seam 接入。

第一阶段验收状态：

1. 已完成：单个 Parent/Delegation/Child 原子提交；
2. 已完成：Child 权限、Workspace、Tool、Model、Policy、Budget 子集校验；
3. 已完成：Child 运行、终态事实和结果回灌持久化；
4. 已完成：Parent 等待 required child 并在终态后恢复；
5. 待补：Parent/Child 活跃取消的完整确定性传播；
6. 部分完成：started Provider 恢复已接入，真实进程强杀场景待补；
7. 已完成：Public Projection 和 Renderer 显示父子关系；
8. 已完成：稳定 identity、command receipt 与 replay 防止重复 Child。

### 6.7 已修复：bootstrap 冻结的 Capability Manifest

历史生产路径由以下集中点分别组装：

- `DefaultAgentControlRuntimeFactory`
- `ProductionAgentControlExecutionPipelineFactory`
- 已删除的旧 `FirstPartyAgentToolCatalog`
- `RuntimeKernelApplication.status()` 的静态 capability 列表

新增一种完整能力通常需要同时修改：

- Protocol；
- Runtime Policy；
- Composition；
- Tool Catalog；
- Runtime status；
- Public Projection；
- Main/Preload；
- Renderer。

现已借鉴 deepseek-harness 的 capability seam，并落地静态、冻结、可审计的 Ariadne 版本：

```ts
interface CapabilityDefinition {
  id: CapabilityId;
  contractVersion: string;
  requires: readonly CapabilityId[];
  provides: readonly CapabilityServiceId[];
}

interface CapabilityProvider {
  definition: CapabilityDefinition;
  start(context: CapabilityStartContext): Promise<CapabilityHandle>;
}

interface CapabilityHandle {
  status(): CapabilityStatus;
  prepareShutdown(context: ShutdownContext): Promise<void>;
  close(context: ShutdownContext): Promise<void>;
}
```

当前约束与结果：

- Manifest 在 Runtime bootstrap、业务 Store 打开前编译并冻结，并由 Kernel/Agent Control 共享；
- status、Tool Catalog 和无敏感诊断只能从已成功启动的 Provider 推导；
- Tool Catalog 仍在 admission 时编译并 pin；
- 不允许 Runtime 从任意磁盘路径动态加载 JavaScript；
- 第一阶段不做热重载；
- 一个 capability 的删除必须同时移除 Provider、Consumer、协议广告和持久数据迁移；缺 Provider 时即使配置仍存在也不会宣告；
- Protocol 已定义但没有 Provider owner 的条目由 `unwiredPublicCapabilities` 自动报告。

实现与删除规则见 [Runtime Capability Manifest](capability-manifest.md)。

### 6.8 已修复：Skills 渐进披露

生产 `skills.catalog` Provider 现在只在 admission 提供启用 Skill 的名称、描述与 SHA-256 revision。完整正文只能通过 immutable Tool Catalog 中的 `skill.load` 按 exact revision 加载，并经 durable Effect result 进入后续受保护 Turn。

相比之下，deepseek-harness 将 Skill 分为：

- catalog/metadata；
- model-visible tool；
- invocation 时加载完整 Skill body；
- scoped prompt/tool contributions。

当前约束为：

1. Admission 只固定 Skill id、revision、description 和 authority；
2. 模型通过 `skill.load` 请求完整正文；
3. 加载结果进入受保护 Turn input；
4. Skill 不允许执行任意脚本；
5. Skill 删除、更新和版本不一致必须 fail closed；
6. 当前 Run 始终使用 admission 时 pin 的版本。

### 6.9 已修复：Hooks、Diagnostics、Telemetry；Provider Resilience 待办

v3 已消费下列固定 extension point；旧 HookManager 不再是生产回退路径：

```text
run.admission.pre
inference.dispatch.pre/post
tool.dispatch.pre/post
turn.commit.post
run.terminal.post
runtime.stop
```

当前每个 Hook 的规则为：

- 是否能修改权威输入；
- 是否允许拒绝；
- 是否是观察者；
- timeout；
- delivery identity；
- replay/去重语义；
- 敏感数据 allowlist；
- 失败是否阻断主流程。

Provider Resilience 必须留在 Provider Adapter 层，不能由 AgentLoop、Scheduler 和 UI 各自重试。

Diagnostics/Telemetry 当前满足：

- 与 Agent Control 权威分离；
- 默认脱敏；
- 不能驱动业务恢复；
- diagnostics 最多保留 512 条；
- exporter 缺失或失败不能导致核心文本 Agent 不可用；
- Runtime status 只在 allowlisted exporter 成功构造后宣称 `telemetry.export`。

实现与删除规则见 [Skills、Hooks 与可观测性生产边界](skills-hooks-observability.md)。

### 6.10 P2：后台 Job、持久终端和代码搜索工具

当前第一方 Tool Catalog 主要包括：

- MCP list/call；
- Browser screenshot/download/click/type/scroll/navigate/snapshot/wait；
- Workspace list/read/write/run command。

仍缺少：

- owner-scoped persistent PTY；
- background job registry；
- list/read/send/kill 控制；
- 结构化文件搜索；
- Git 状态/差异工具；
- v3 Code Intelligence/LSP consumer。

这些能力现在必须作为独立 Capability Provider 实现，不能再次把装配逻辑塞回 Factory 或 Tool family 聚合文件。

## 7. 不应照搬 deepseek-harness 的部分

### 7.1 不直接引入 Cordis

原因：

- Ariadne 已有明确的 Domain/Application/Adapter/Composition 依赖方向；
- 动态 Context/Service Locator 容易重新引入隐式依赖；
- 当前首要问题是完成生产闭环，不是建立第三方插件市场；
- Runtime 的安全、权限和恢复依赖启动期不可变身份。

可借鉴其 seam 设计，但实现为显式 TypeScript interface、构造注入和冻结 manifest。

### 7.2 第一阶段不做热重载

热重载要求同时解决：

- 活跃 Run 使用旧/新 Provider 的版本隔离；
- Tool identity 和 schema revision；
- 持久事件 replay；
- Provider 卸载时的 in-flight I/O；
- Sandbox 和 credential 生命周期；
- Projection contract 兼容。

这些工作不应阻塞当前 v3 完成。

### 7.3 不复制 Web Server 边界

Ariadne 继续保持：

- Electron Main -> Node IPC -> Runtime；
- Headless 使用受控 NDJSON/stdio；
- Runtime 不监听入站端口；
- HTTP/OAuth 由 Main 或明确的出站 Adapter 所有。

### 7.4 不降低 Sandbox 标准

deepseek-harness 的 Windows ACL backend 自身明确报告 partial enforcement，并记录 Everyone、hard-link、FAT volume、named pipe 等边界。

Ariadne 应继续使用自身的 fail-closed Sandbox Helper、签名和发布验证，不应因为上游接口更易组合而替换安全模型。

## 8. 建议实施路线

### 阶段 0：固定当前基线（已完成）

目标：把当前大规模工作树变成可审计、可回滚的垂直切片。

已完成：

- 复核 517 个变更文件，并将当前 v3 生产状态固定为本文所在的 `main` commit；
- 扫描私钥、Provider token、授权头、本机绝对路径和运行数据库；命中项均为脱敏测试 fixture；
- 执行 typecheck、全量测试、architecture、independence、release contract 和真实 Electron smoke；
- 更新过时文档，明确历史路径不再存在。

退出条件：

- 当前生产入口和基线 commit 可检出、可验证；
- 后续提交恢复为一个可解释的修复切片；
- 无意外生成物、凭据、运行数据库或机器路径进入 Git。

### 阶段 1：真实 Agent 产品门禁（已完成）

目标：证明当前已宣称的 Agent 能力在真实窗口和真实 Runtime 中工作。

退出条件：

- direct answer、Tool continuation、Decision allow/deny、cancel、Runtime restart 全部通过；
- Renderer console 无错误；
- 外部动作不重复；
- terminal assistant message 可从 Projection 冷启动恢复；
- smoke artifact 明确记录每个断言，不只输出总 PASS。

上述退出条件已由当前 `test:electron` 和 `artifacts/electron-runtime-smoke/electron-runtime-smoke.json` 满足。Live Provider、真实 Browser/MCP、本地模型和正式签名 Sandbox Helper 仍属于独立验收项。

### 阶段 2：拆分持久化与 Composition 热点

目标：降低修改扩散，不改变业务语义。

退出条件：

- UoW 保持唯一事务边界；
- schema/codec/mapper/reader/recovery 分离；
- Factory 不再拥有所有错误映射、命令执行和生命周期细节；
- FirstParty Tool 定义按能力族拆分；
- 0 SCC、0 rule violation。

### 阶段 3：Capability Manifest（已完成）

目标：让能力接线状态可由系统计算和验证。

退出条件：

- 每个 capability 有 definition/provider/consumer/status/lifecycle；
- 缺 Provider 的能力不会出现在 Runtime status；
- 存在代码但未接线的模块能被审计工具自动列出；
- 删除一个 capability 不需要修改无关 Agent Core 文件；
- Manifest 可输出为无敏感信息的诊断快照。

实现已拆为 28 行生产入口、48 行 Provider seam、75 行 bootstrap context、91 行生产 Provider 定义和 238 行通用 compiler，并由 Hotspot Boundary Gate 锁定，避免把旧 Catalog/Factory 复杂度整体搬进新的 Manifest 巨型入口。

### 阶段 4：流式事件与 Context 生命周期

Agent inbox、followup 和 steer 已完成；本阶段剩余目标是可恢复流式交互、独立 context injection 和大输出生命周期。

退出条件：

- 独立 context injection 具有 durable receipt；
- chunk 与 terminal message 的权威边界明确；
- compaction、pruning 和 spill 可恢复、可删除；
- Runtime 重启后不会重复消费输入或重复压缩；
- Renderer 仍只读 Projection。

### 阶段 5：按产品价值接入扩展能力

建议顺序：

1. in-process fresh Child Run；
2. background jobs；
3. persistent terminal；
4. Skill progressive disclosure；
5. typed Hooks；
6. Diagnostics/Telemetry；
7. Provider Resilience；
8. Memory/Embedding；
9. external SubAgent providers。

每项必须独立满足：

- 唯一 Owner；
- typed command；
- 持久状态；
- Projection；
- Renderer 或 Headless consumer；
- restart/cancel/permission 测试；
- Runtime status advertisement；
- 完整删除路径。

## 9. 统一验收模板

以后每个能力合入前必须回答：

1. 能力的 Service Definition 是什么？
2. 哪个 Provider 拥有外部 I/O 和生命周期？
3. 哪个 Consumer 使它成为真实产品能力？
4. 权威状态由谁写入？
5. 是否存在第二 Writer、fallback 或长期双写？
6. 外部动作前后的 intention/result 如何持久化？
7. command、effect 和 delivery 如何去重？
8. Runtime 在每个强杀点之后如何恢复？
9. capability status 如何从真实接线推导？
10. Renderer 是否只消费公开 Projection？
11. 敏感输入、绝对路径、凭据和 Tool payload 是否被公共 DTO 隔离？
12. Provider 缺失、崩溃或删除时，核心文本 Agent 是否仍可用？
13. 自动测试、真实进程和真实窗口分别验证了什么？
14. 如何完整删除该能力及其持久数据？

## 10. 最终判断

Ariadne 当前最准确的定位是：

> 具备强事务控制面和安全桌面边界的单一产品 Runtime，正在完成从历史 Agent 实现到 v3 权威链路的收口。

它尚不应被描述为：

> 已拥有完整 SubAgent、后台任务、长期记忆、流式交互、可插拔 Provider、完整 Hooks 和通用插件生态的 Agent Harness。

deepseek-harness 最值得参考的是它让“增加一种能力”成为显式、局部、可替换的系统动作。Ariadne 下一阶段应把这种局部性引入现有强一致架构，而不是用动态插件系统替换已经验证过的事务与安全边界。

## 11. 关联文档

- [文档索引](README.md)
- [当前实现架构](architecture.md)
- [目标架构](architecture-v3.md)
- [项目结构](project-structure.md)
- [验证说明](verification.md)
- [机器可读验收矩阵](verification-matrix.json)
