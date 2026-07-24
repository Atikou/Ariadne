# Ariadne Agent 成熟度审阅与 P0/P1 验收清单

> 状态日期：2026-07-24
>
> 范围：只包含 P0、P1；产品扩展不在本轮范围内。
>
> 证据原则：只有当前仓库的设计、实现、自动测试和对应真实验收同时存在，条目才算完整验收。

## 1. 当前结论

Ariadne 已从“多个松散 Store、Trace 轮询和扁平工具描述”重建为以下主干：

```text
typed command
  -> RunAggregate(expectedAggregateVersion)
  -> SQLite transaction
       ├─ aggregate
       ├─ checkpoint
       ├─ tool ledger
       └─ domain event outbox
  -> persistent cursor replay
  -> Renderer idempotent projection
```

当前自动证据：

- Protocol：18 项；
- Runtime：162 项；
- App：163 项；
- 合计：343 项自动测试；
- Protocol、Runtime、App 全量 TypeScript 检查通过；
- Runtime 独立性审计通过；
- 真实 Electron 窗口与真实 Runtime 子进程冒烟通过；
- 发布契约静态检查通过。

这些证据证明了实现和开发机器回归，不证明生产发布已经验收。以下项目仍保持“未验收”：

- 真实远程 Provider 与真实本地聊天模型的工具、权限、计划、取消、强杀恢复全链路；
- BGE-M3 实际模型资产装配后的语义召回；
- 签名原生 Sandbox helper 下的真实 MCP STDIO 服务器；
- 真实远程 MCP OAuth 2.1/PKCE 授权、刷新与断线恢复；
- Browser 真实 HTTPS 页面、重定向、敏感输入和下载隔离验收；
- 正式签名的应用、安装器和原生 Sandbox helper；
- 干净 Windows 机器上的安装、N-1 升级、迁移失败回滚、备份降级和卸载。

## 2. P0 完成状态

### P0-01：单一 Run Aggregate 与持久执行

状态：**实现完成；自动验收完成；真实模型强杀验收未完成。**

合理之处：

- `RunAggregateRepository` 是 Run 状态的唯一写入口；
- 状态变化使用 typed command 和 `expectedAggregateVersion`；
- 非法转换和旧版本竞争写入被拒绝；
- checkpoint、in-flight effect、等待原因、child Run 和恢复状态进入同一聚合；
- 旧的任意状态更新实现已删除，没有双写层。

仍需关注：

- 真正带 Shell、网络写入或外部副作用的进程强杀只能在受控真实验收环境证明；
- 未确认副作用不会自动重放，而是进入 `recovery_required`。

关键实现：

- `runtime/src/run/RunAggregateRepository.ts`
- `runtime/src/run/RunToolCheckpointCoordinator.ts`
- `runtime/src/app/startupRecovery.ts`

自动证据：

- `runtime/tests/run-aggregate.test.ts`
- `runtime/tests/startup-recovery.test.ts`
- `runtime/tests/tool-checkpoint-integration.test.ts`

### P0-02：事务 Outbox、快照与持久游标

状态：**实现完成；自动验收完成。**

合理之处：

- 状态、checkpoint、账本和领域事件在 SQLite 事务中提交；
- `RuntimeEventEnvelope` 包含 event ID、cursor、schema version、aggregate version、correlation 和 causation；
- Renderer 从单一 revision 快照初始化，再按 event ID 与 aggregate version 幂等投影；
- `runtime.snapshot.get` 与 `events.replay` 已公开；
- 业务事件不再从 Trace 轮询推导，Trace 只保留诊断用途。

仍需关注：

- 高负载长期运行需在发布环境增加容量和磁盘故障测试；
- OTel 只能消费领域事实，不能成为恢复来源。

关键实现：

- `runtime/src/events/DomainEventJournal.ts`
- `runtime/src/events/RuntimeEventDispatcher.ts`
- `app/src/renderer/src/core/runtime/runtime-store.ts`

自动证据：

- `runtime/tests/runtime-event-dispatcher.test.ts`
- `app/tests/runtime-store-startup.test.ts`

### P0-03：唯一 ToolContract 与动作规范化

状态：**实现完成；自动验收完成；真实 Provider 验收未完成。**

合理之处：

- Runtime 统一使用 Zod 4；
- `ToolContract<I,O>` 同时定义输入、输出、权限、资源范围、副作用、风险、并发、幂等、敏感度、外发、超时、恢复和 Provider；
- Provider JSON Schema 由同一输入 Schema 派生；
- 原生 Tool Calling 和文本 fallback 都先规范化为 `AgentAction`，再进入审批与执行；
- 未知字段、无效枚举、缺失字段和输出不匹配均 fail-closed。

仍需关注：

- 不能用“OpenAI-compatible”推断模型一定支持 native tools；
- 每个 Provider/模型必须由 qualification matrix 的真实证据解锁。

关键实现：

- `runtime/src/tools/types.ts`
- `runtime/src/tools/contractProfiles.ts`
- `runtime/src/agent/AgentActionAdmission.ts`

自动证据：

- `runtime/tests/tool-contract.test.ts`
- `runtime/tests/agent-action-admission.test.ts`
- `runtime/tests/provider-qualification.test.ts`

### P0-04：有限协议修复与错误分类

状态：**实现完成；自动验收完成。**

合理之处：

- 协议修复最多两次；
- 修复轮次不执行工具；
- 只回传 Schema 错误和允许动作；
- 格式错误、未知工具、参数错误、Provider 暂时错误和不可恢复错误分开处理；
- Token、成本和时间预算继续生效。

不合理做法已移除：

- 一次解析失败直接终止 Run；
- 把整段上下文再次注入修复提示；
- 修复未成功前执行副作用。

自动证据：

- `runtime/tests/agent-action-admission.test.ts`

### P0-05：安全并发调度

状态：**实现完成；自动验收完成。**

合理之处：

- 只有 `parallel_safe` 且副作用为 `none/workspace_read` 的工具允许并发；
- 资源键冲突会强制串行；
- 默认并发上限为 4；
- Shell、Git 变更、网络写入、文件写入和未知 MCP 工具保持串行；
- 结果按原始 call 顺序归并。

自动证据：

- `runtime/tests/tool-concurrency-planner.test.ts`

### P0-06：工具账本、幂等键与恢复决策

状态：**实现完成；自动验收完成；真实副作用强杀验收未完成。**

合理之处：

- 工具意图、开始和结果分别持久化；
- 稳定 idempotency key 支持恢复；
- 未开始的安全工具可继续；
- 已开始且可验证/幂等的工具通过账本和文件哈希恢复；
- 无法确认的 Shell、网络写入或外部副作用进入 `recovery_required`。

自动证据：

- `runtime/tests/tool-checkpoint-integration.test.ts`
- `runtime/tests/startup-recovery.test.ts`

### P0-07：内容权限与数据外发

状态：**实现完成；自动验收完成。**

合理之处：

- `ContentEnvelope` 取代 `trusted` 布尔值；
- 文件、README、网页、命令输出、Diff、MCP 和 SubAgent 文本默认只能作为数据；
- 外部文本不能提升自己的指令权限；
- secret 到 network、telemetry、日志和模型外发统一经过 egress gate；
- Telemetry 属性使用固定允许列表，不导出内容或路径。

自动证据：

- `runtime/tests/content-egress.test.ts`
- `runtime/tests/prompt-builder-authority.test.ts`
- `runtime/tests/telemetry-policy.test.ts`

### P0-08：Browser capability 一致性

状态：**服务和动态能力实现完成；自动验收完成；真实网页验收未完成。**

合理之处：

- Browser Service 由 Electron Main 拥有；
- 使用隔离 `WebContentsView`，禁用 Node，启用 sandbox/contextIsolation/webSecurity；
- 默认临时 Session，拒绝未知权限、HTTP、弹窗和未批准下载；
- Runtime 只能通过 Host capability broker 调用；
- Browser 工具只有在 Main 健康检查和注册成功后才动态公开；
- 截图和下载先登记到 Resource Registry，公开层只返回 opaque ID。

仍需关注：

- 真实网站的跨域重定向、下载、复杂可访问性树和敏感输入尚未在隔离验收机确认；
- Computer Use 范围只限隔离网页，不控制 Windows 桌面。

自动证据：

- `app/tests/browser-service.test.ts`
- `runtime/tests/browser-tools.test.ts`
- `app/tests/runtime-supervisor.test.ts`

### P0-09：项目自有测试与 Eval Harness

状态：**实现完成；自动基线完成；真实模型评测未完成。**

合理之处：

- 当前测试只针对 Ariadne 当前协议和领域行为；
- 隔离临时工作区 Eval 覆盖修复、重构、新功能、只读审阅、权限、计划、取消、强杀恢复、注入、多工作区和 SubAgent 冲突；
- 结果契约包含提交、Provider、模型、配置指纹、成功率、成本、工具次数和验证器结果；
- 仓库不存在退役项目的名称、测试和兼容逻辑。

自动证据：

- `runtime/src/eval/AgentEvalHarness.ts`
- `runtime/tests/agent-eval-harness.test.ts`

## 3. P1 完成状态

### P1-01：Token 计数与 Context Packing

状态：**实现完成；自动验收完成。**

合理之处：

- 本地模型使用实际 tokenizer；
- 远程模型使用 profile 对应计数器；
- 无精确 tokenizer 时明确标记为 conservative；
- 预算预留输出和工具 Schema；
- 按价值/成本、时效、信任和任务相关度装箱；
- 单个过大 section 会跳过，不会阻断后续高价值内容。

自动证据：

- `runtime/tests/model-token-budget.test.ts`

### P1-02：本地 Embedding、摘要与长期记忆

状态：**代码和自动测试完成；真实 BGE-M3 资产验收未完成。**

合理之处：

- `node-llama-cpp` 接入本地 GGUF Embedding；
- BGE-M3 资产来源、许可证和 SHA-256 固定在发布清单，权重不提交；
- 摘要使用严格 Schema、来源消息范围、版本和 degraded 状态；
- 记忆具有 candidate/active/rejected/superseded/expired 生命周期；
- 记忆记录来源、敏感级别、保留期和作用域；
- Public API 支持 list/get/update/delete；
- 用户编辑生成新的 active 版本并保留 superseded 证据；
- secret 默认拒绝持久化。

自动证据：

- `runtime/tests/local-gguf-embedding.test.ts`
- `runtime/tests/summary-memory-governance.test.ts`

### P1-03：代码理解与 Repo Map

状态：**实现完成；自动验收完成。**

合理之处：

- LSP 3.18 客户端优先；
- Tree-sitter WASM fallback；
- 首批覆盖 TS/JS、JSON/Markdown、Python、C#；
- Repo Map 持久化文件、符号、引用、导入、诊断和变更版本；
- Context 获取按任务相关度排序的最小子图。

仍需关注：

- C#、Python 等真实大型仓库性能仍需压力验收；
- 未配置语言服务器时会显式降级，不伪装为 LSP 结果。

自动证据：

- `runtime/tests/code-intelligence-languages.test.ts`
- `runtime/tests/project-repo-map.test.ts`

### P1-04：MCP 边界

状态：**实现完成；自动验收完成；真实 MCP 服务器和授权端验收未完成。**

已完成：

- 使用官方 TypeScript SDK；
- 远程 Streamable HTTP 只允许 HTTPS；
- 旧 SSE fallback 默认关闭；
- MCP 工具全部适配为 ToolContract；
- annotations 不可信时默认危险、串行、非幂等；
- 工具变更通知和连接崩溃测试存在；
- 原生 Sandbox 协议提供可审计的长连接 process lease，STDIO 使用有界输入输出、取消、进程树回收、环境变量允许列表、网络模式和工作区读写模式；
- 远程 Streamable HTTP 由 Electron Main 托管官方 SDK，Runtime 只通过 Host capability 交换 JSON-RPC 和 opaque connection ID；
- OAuth credentialRef 不包含 token，授权码、PKCE verifier、access/refresh token 和动态客户端信息只存在于 Main 的 `safeStorage` 加密凭据库；
- `ariadne://oauth/mcp` 回调验证 state，授权拒绝不会重试请求，Runtime、Renderer、设置文件和日志均不接收 token。

仍需真实验收：

- 在签名原生 helper 下连接真实 STDIO MCP 服务器，验证双工、取消、崩溃和进程树回收；
- 对真实 OAuth 2.1/PKCE 服务验证首次授权、refresh token、撤销、断线恢复和应用重启。

自动证据：

- `runtime/tests/mcp-client-manager.test.ts`
- `runtime/tests/sandbox-mcp-transport.test.ts`
- `runtime/tests/host-mcp-transport.test.ts`
- `app/tests/mcp-remote-service.test.ts`

### P1-05：Skills、分层指令与 Hooks

状态：**实现完成；自动验收完成。**

合理之处：

- Skills 使用 built-in、用户和 workspace 三层；
- 指令优先级固定为系统 → 用户 → workspace 根 → 目标目录 → Skill；
- 外部内容不进入指令层；
- Skill 脚本仍必须通过 ToolContract、Policy 和 Sandbox；
- Hooks 支持 session/run/model/tool/subagent 的 pre/post 与 stop；
- Hook 有版本、超时、稳定 delivery ID、持久去重和 fail-open/fail-closed；
- Hook 只能拒绝 pre 操作或收紧权限/超时，不能扩权；
- 声明式 Hook 不开放任意脚本旁路。

自动证据：

- `runtime/tests/skills-instructions.test.ts`
- `runtime/tests/hooks.test.ts`

### P1-06：Resource Registry

状态：**实现完成；自动验收完成。**

合理之处：

- 内容寻址存储记录 SHA-256、所有者、生命周期、敏感级别、来源和过期时间；
- Public DTO 只暴露 opaque ID，不暴露本机绝对路径；
- list/get/update/delete 已公开；
- Browser 截图与下载统一进入 Registry。

自动证据：

- `runtime/tests/resource-registry.test.ts`

### P1-07：Headless NDJSON

状态：**实现完成；自动验收完成。**

合理之处：

- 复用同一 RuntimeFacade；
- stdin/stdout 使用严格 NDJSON；
- stdout 只输出协议，日志进入 stderr；
- 支持 hello、command、shutdown、ready、response、event、fatal；
- 支持 resumeCursor、取消、确定退出码和 `--once`；
- 不创建 HTTP Server 或监听端口。

自动证据：

- `runtime/tests/headless-runtime.integration.test.ts`

### P1-08：Compare/Restore

状态：**实现完成；自动验收完成。**

合理之处：

- 只管理该 Run 工具账本实际改变的文件；
- 恢复前校验当前哈希；
- 用户后续修改或无关文件冲突时阻塞；
- 新建文件可以安全删除并再次恢复；
- 每次恢复都会创建新的可撤销 checkpoint。

自动证据：

- `runtime/tests/task-checkpoint-restore.test.ts`

### P1-09：Provider Resilience 与 Qualification

状态：**实现完成；自动验收完成；真实 Provider 验收未完成。**

合理之处：

- 错误分类、Retry-After、指数退避、jitter、请求/Token 限流、并发上限和熔断统一；
- 首个流式 token 发出后禁止透明重试；
- qualification matrix 分别记录 native tools、fallback、stream、reasoning、取消、tokenizer 和错误行为；
- 未知能力保持 unknown，不根据兼容协议名称猜测。

自动证据：

- `runtime/tests/provider-resilience.test.ts`
- `runtime/tests/provider-qualification.test.ts`

### P1-10：OpenTelemetry

状态：**实现完成；自动验收完成；真实 OTLP 接收端验收未完成。**

合理之处：

- 只启用 Node 侧稳定 trace 和 metric；
- OTLP HTTP/protobuf 默认关闭；
- endpoint 必须精确匹配 HTTPS allowlist；
- 用户内容、提示词和路径不进入导出属性；
- 本轮不使用 OTel logs 替换本地审计。

自动证据：

- `runtime/tests/telemetry-policy.test.ts`

### P1-11：数据库迁移与 Windows 发布

状态：**工程实现和静态门禁完成；真实签名安装验收未完成。**

合理之处：

- 迁移前使用一致性备份并生成恢复 manifest；
- 完整迁移在单一事务中执行，失败原子回滚；
- 新版本数据库拒绝旧程序写入；
- 降级路径是恢复对应版本备份，不要求旧程序读取未知 Schema；
- NSIS 安装器在升级/卸载前回收应用和 Sandbox helper；
- 静默卸载默认保留用户数据；
- 交互卸载只有显式确认才删除用户数据；
- `verify:release` 按依赖、契约、Protocol、Runtime、App、独立性、真实 Electron、签名环境、安装包、原生 Sandbox、模型 Runtime 和签名产物顺序执行。

未验收：

- 正式证书和发布者标识未注入；
- 没有在干净 Windows 机器执行 N-1 → N、迁移中断、备份降级和卸载；
- 因此不能宣称“可生产发布”。

自动证据：

- `runtime/tests/sqlite-migration-safety.test.ts`
- `scripts/verify-release-contract.mjs`
- `scripts/verify-packaged-runtime-assets.mjs`
- `scripts/verify-windows-release-signatures.mjs`

### P1-12：设置契约

状态：**实现完成；自动验收完成。**

- Runtime `AppConfig` 已有 MCP、Skills、Hooks、telemetry、Provider resilience 和本地 Embedding 配置；
- Protocol 提供严格的 `RuntimePolicySnapshot`，并作为 Host bootstrap 必填字段；
- Electron `settings.toml` 使用 schema 2 持久化策略，schema 1 只执行单向迁移，不双写；
- Renderer 可读写的设置契约只包含非密钥策略和 opaque credential reference；
- Main 将 MCP、Skills、Hooks、telemetry、Provider resilience 和 Embedding 快照注入 Runtime；
- Browser policy 由 Main 直接应用，支持临时/显式 workspace 持久 Session、HTTPS origin allowlist、敏感输入开关和下载上限；
- 密钥仍由 Main 安全存储；
- Runtime 不接收 API Key、OAuth token 或证书明文。

OAuth 2.1/PKCE 的安全存储和兑换由 P1-04 的 Main Broker 完成，设置 DTO 始终只传 opaque reference。

自动证据：

- `packages/protocol/tests/protocol.test.ts`
- `app/tests/agent-settings-repository.test.ts`
- `app/tests/runtime-configuration.test.ts`
- `app/tests/browser-service.test.ts`

## 4. 模块逐项审阅

| 模块 | 合理之处 | 当前不合理或缺口 | 推荐修改 |
|---|---|---|---|
| `packages/protocol` | Public/Host/Headless 分离、2.0 严格 Schema、持久事件 envelope、版本化 runtimePolicy；MCP Host 操作只含 JSON-RPC 与 opaque ID | Host 消息受大小上限约束，大响应仍需真实压力验收 | 保持 token 字段 strict 拒绝；在真实 MCP 服务验证消息上限和断线行为 |
| `app/main` | 唯一 RuntimeSupervisor；桌面能力由 Main 拥有 | `ApplicationController` 组装职责较大 | 按 Runtime、Browser、Settings、Window 拆 composition factory，不下沉业务逻辑 |
| `app/preload` | 固定、类型化、无通用 IPC | 资源/记忆治理尚无完整 UI | 只增加 Public command facade，不暴露路径或 Host DTO |
| `app/renderer` | 单快照加持久事件投影，不接触 Node | Resource/Memory/Checkpoint 公开命令尚缺完整交互面板 | 在现有模块中增加治理视图，不建立第二套状态源 |
| `runtime/application` | RuntimeFacade 统一公开边界 | 文件仍较大，command 分发和领域投影集中 | 按 Resource、Memory、Run、Companion command handler 拆分 |
| `runtime/run` | 单一 aggregate、typed command、乐观并发 | 真实外部副作用强杀证据不足 | 在干净机用故障注入覆盖每个 checkpoint |
| `runtime/events` | Outbox、cursor、幂等 replay | 长期容量和磁盘满未验收 | 增加分页压力、归档和磁盘故障 Eval |
| `runtime/agent` | native/fallback 统一动作、有限修复、预算 | 真实弱模型协议表现未知 | 用 qualification matrix 和固定 Eval 逐模型验收 |
| `runtime/tools` | 唯一 ToolContract、输出校验、并发计划 | 未知第三方工具只能保守串行 | 保持保守默认，只有可靠 annotations 与实测才能放宽 |
| `runtime/security` | ContentEnvelope 与 egress gate | 审批 UI 对数据来源/目标展示仍可加强 | Public Permission DTO 增加脱敏 provenance/egress 摘要 |
| `runtime/context` | tokenizer、摘要、记忆、Embedding、Repo Map 齐全 | 真实 BGE-M3 和大型仓库性能未验收 | 注入固定资产后执行召回与压力基准 |
| `runtime/mcp` | 官方 SDK、HTTPS、ToolContract、危险默认；STDIO 走原生沙箱 lease，远程 JSON-RPC 走 Main Broker | 真实服务器的双工、OAuth 刷新和断线恢复未验收 | 在签名 helper 与真实 OAuth 服务上执行故障注入 |
| `runtime/skills` | 三层发现和固定优先级 | 缺少可视化来源与冲突解释 | Public diagnostics 提供只读解析结果，不暴露脚本权限 |
| `runtime/hooks` | 持久 delivery、去重、超时、拒绝/收紧 | 只支持声明式内置决策 | 若增加外部 Hook，仍必须通过 ToolContract/Sandbox，不能直接执行脚本 |
| `runtime/resources` | 内容寻址、opaque ID、生命周期 | App 尚无完整附件与治理 UI | Renderer 只持有 ResourceReference，导入由 Main broker |
| `runtime/model` | resilience、qualification、token counter | 无真实 Provider 证据 | 真实 Provider 分别验收，不按协议品牌推断 |
| `runtime/telemetry` | 默认关闭、allowlist、脱敏 | 未连接真实 OTLP collector | 在隔离环境验证导出字段和网络策略 |
| `runtime/subagent` | 权限/预算/冲突/Hook 边界 | child Run 关系仍需真实强杀验收 | 将每次派生和终态证据纳入 RunAggregate 验收报告 |
| `runtime/sandbox` | restricted 不可用时 fail-closed、helper 信任设计；协议 v5 支持认证双工 process lease | 原生受限账户下的长时间稳定性尚未在干净机验收 | 用真实 STDIO 服务验证输入分帧、断线、超时与进程树回收 |
| `runtime/transport` | Node IPC 与 Headless NDJSON 复用 Facade，无端口 | Headless 真实模型 CI 未验收 | 在注入模型的 CI 使用 cursor/reconnect/exit code 全链路 |
| `runtime/storage` | 备份、事务迁移、新 Schema 拒写 | 干净机升级/降级未验收 | 用签名 N-1/N 安装包执行破坏性故障注入 |
| `release` | 签名 fail-closed、NSIS 数据选择、资产校验 | 缺正式证书和干净机 | 安全注入后执行完整发布清单 |

## 5. 覆盖矩阵

机器可读矩阵见 [verification-matrix.json](verification-matrix.json)。

状态语义：

- `verified`：当前工作树有自动或对应环境证据；
- `partial`：只覆盖了该层的一部分；
- `not_accepted`：代码可能存在，但缺少要求的真实证据；
- `not_applicable`：该层不适用于此模块。

任何真实模型、真实窗口或真实机器列为 `not_accepted` 的条目，都不能通过增加单元测试改成“已验收”。

## 6. 后续只允许处理的 P0/P1 工作

1. 安全注入远程 Provider、本地聊天模型、BGE-M3、真实 MCP 服务、签名环境和干净 Windows 验收机。
2. 执行真实模型、MCP、Browser、安装升级/回滚/降级/卸载验收。

除此之外不扩展角色市场、团队协作、第三方 Plugin SDK、跨设备通知或媒体生成。
