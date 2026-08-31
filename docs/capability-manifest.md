# Runtime Capability Manifest

## 1. 修复的问题

旧生产路径存在四份能力真相：`DefaultAgentControlRuntimeFactory` 创建 Tool Catalog，`ProductionAgentControlExecutionPipelineFactory` 消费 Catalog，`RuntimeKernelApplication.status()` 再按配置手写公开能力，文档和验收矩阵另行维护接线状态。增加、删除或禁用能力时，这些清单可能漂移，源码存在也可能被错误宣告为产品能力。

现在 Runtime bootstrap 只编译一次 `RuntimeCapabilityManifest`。同一个冻结快照同时交给 Runtime Kernel 和 Agent Control：

```text
static Provider definitions
  -> Provider ordering (`dependsOn`) + service graph (`consumes` / `provides`)
  -> Provider start with declared-only service scope
  -> required output validation + atomic service publication
  -> Tool contribution compilation
  -> frozen Capability Manifest
       |-> Runtime status
       |-> Agent immutable Tool Catalog
       |-> public-safe diagnostic snapshot
       `-> prepareShutdown / close (reverse provider order)
```

这借鉴了 deepseek-harness 的 capability seam、Provider/Consumer 分离和服务图思想，但 Ariadne 不从任意磁盘路径加载 JavaScript、不热重载，也不允许 Renderer 注册 Runtime Provider。

参考：

- [deepseek-harness Capability Seams](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/capability-seams.md)
- [deepseek-harness SubAgent Capability Family](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/subagent/README.md)

## 2. 契约

每个静态 Provider 必须声明：

- 稳定 capability id 与 contract version；
- 纯启动顺序所需的 Provider id（`dependsOn`）；
- 实际消费的必需/可选 service id（`consumes`）；
- 唯一提供的必需/可选 service id（`provides`）；
- 可能公开宣告的 Public Capability；
- `start` 返回的实际公开能力、Tool contribution 和生命周期 handle。

编译器在任何业务 Store 打开前完成以下 fail-closed 校验：

- capability、service 和 Public Capability 所有权不可重复；
- Provider 与 service 依赖必须存在且组合图必须无环；
- required consumer 不得绑定 optional owner；Provider 不得消费自己的输出；
- `start` 只能读取显式声明的依赖，未声明读取和错误的 required/optional API 会拒绝；
- 必需 service 必须实际输出；未声明、`undefined` 或重复输出会拒绝，发布对单个 Provider 保持原子；
- Provider 实际输出只能是其声明的公开能力子集；
- Tool name 不可重复，并必须重新经过可信 Catalog compiler；
- Catalog revision、digest 和稳定 Tool name 集合必须与 Host authority 契约完全一致。

任一 Provider 启动或 Manifest 编译失败时，已启动 Provider 按逆序回滚。正常关闭先执行业务 producer/store 的 barrier，再按逆序执行 Manifest `prepareShutdown` 与 `close`。

## 3. 单一消费路径

- `ComposedRuntimeIngress` 是唯一生产编译点，并将同一个 Manifest 实例注入 Kernel 与 Agent Control。
- `RuntimeKernelApplication.status()` 不再读取 workspace、permission、MCP、Skills 或 Hook 配置自行猜测能力，只返回 Manifest 的已启动 Provider 结果。
- Agent Tool Catalog 不再由 `DefaultAgentControlRuntimeFactory` 组合；Workspace、Browser 和 MCP Provider 各自贡献 Tool registrations，包括合同固定的 model description/guidance 与可公开静态 kind/label，Manifest 统一编译并冻结。
- Workspace instruction、Skill catalog 与 execution-mode policy 分别由静态 contributor Provider 提供；`agent.instructions.assembly` 只消费这些显式 service，并生成带 subject/scope/revision 的完整准入快照。
- `agent.control.runtime-services` 是终端 consumer Provider：它消费 instruction assembly、Hook service、live-work 和可选 Telemetry，输出冻结的 `AgentControlRuntimeServices` bundle。
- `DefaultAgentControlRuntimeFactory` 不再拥有 MCP 过滤、Sandbox 绑定、Tool family 清单或扩展 service id；它消费可信 Catalog snapshot 与类型化 Runtime service bundle。

## 4. Provider service dependency resolver

定义图先被冻结和校验。compiler 将显式 `dependsOn` 与每个 consumed service 的 owner 合并成拓扑边；Provider 只有在其依赖全部启动并发布 service 后才会启动。

每个 Provider 收到独立的 `RuntimeCapabilityServiceScope`。`required(id)` 与 `optional(id)` 只能读取该定义中以相同可选性声明的 service；scope 不暴露全局 Map，也不能枚举其他 Provider 输出。启动返回后，compiler 先验证全部输出，再一次性发布给后继 Provider。这样 service locator 被限制在 bootstrap 根：根只取一次类型化 `AgentControlRuntimeServices` bundle，Factory 内部不再出现 `manifest.service(...)`。

该 resolver 只装配受审计的进程内生产 Provider，不是动态插件容器。Instruction contributor 具有稳定 id/version/order/mode/scope、取消和大小预算，任一失败会拒绝整个 admission，而不是回退到部分 prompt。Skill service 在这组静态 Provider 后按 Workspace 生成 complete/incomplete snapshot，并由 Manifest 关闭信号终止发现；package 资源通过同一静态 service 的精确 revision Tool 读取，不允许任意 JavaScript 注册。`hooks.lifecycle` 提供 required service，Store 建立后才绑定 delivery sink，Manifest 反向关闭 handler set 与静态 Provider；外部动态 Hook discovery 仍有意不开放，不应通过放宽 service scope 实现。

## 5. 可审计状态

`diagnosticSnapshot()` 只输出 definition、`started` 状态、公开能力和 Tool names，不包含端点、凭据、绝对路径或 Tool payload。`unwiredPublicCapabilities` 自动列出 Protocol 已定义、但没有任何生产 Provider 声明所有权的能力；旧 Proposal、Resource 和 Memory 公共面仍未接线。Scheduler 已由 v3 productivity public command owner 接管；旧 Trace 与 Background Task 公共枚举已删除，不能继续作为幽灵能力出现在文档中。

配置关闭与未接线是两个不同状态：已启动 Provider 可以因权限或配置不满足而输出空的公开能力；缺少 Provider 则不会出现在诊断快照，也不会出现在 Runtime status。

## 6. 删除和扩展规则

删除能力时移除其 Provider，并处理依赖它的 Provider、协议/持久数据迁移和消费者；不得在 `status()`、Factory 或 Catalog 中保留兼容分支。新增能力必须通过静态 Provider seam 注册并具备直接测试，不得修改 Agent Core 来完成 Runtime 装配，也不得建立第二个动态插件加载器。除 bootstrap 根解析类型化终端 bundle 外，不得增加新的 `manifest.service(...)` lookup。

第一阶段不支持热重载。Provider 集合只来自受审计的生产 Composition；外部/用户代码不能向 Manifest 注入可执行实现。
