# Runtime Capability Manifest

## 1. 修复的问题

旧生产路径存在四份能力真相：`DefaultAgentControlRuntimeFactory` 创建 Tool Catalog，`ProductionAgentControlExecutionPipelineFactory` 消费 Catalog，`RuntimeKernelApplication.status()` 再按配置手写公开能力，文档和验收矩阵另行维护接线状态。增加、删除或禁用能力时，这些清单可能漂移，源码存在也可能被错误宣告为产品能力。

现在 Runtime bootstrap 只编译一次 `RuntimeCapabilityManifest`。同一个冻结快照同时交给 Runtime Kernel 和 Agent Control：

```text
static Provider definitions
  -> dependency/service validation
  -> Provider start
  -> Tool contribution compilation
  -> frozen Capability Manifest
       |-> Runtime status
       |-> Agent immutable Tool Catalog
       |-> public-safe diagnostic snapshot
       `-> prepareShutdown / close (reverse provider order)
```

这借鉴了 deepseek-harness 的 capability seam、Provider/Consumer 分离和服务图思想，但 Ariadne 不从任意磁盘路径加载 JavaScript、不热重载，也不允许 Renderer 注册 Runtime Provider。

参考：

- [deepseek-harness Capability Seams](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/capability-seams.md)
- [deepseek-harness SubAgent Capability Family](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/README.md)

## 2. 契约

每个静态 Provider 必须声明：

- 稳定 capability id 与 contract version；
- 依赖的 capability id；
- 唯一提供的 service id；
- 可能公开宣告的 Public Capability；
- `start` 返回的实际公开能力、Tool contribution 和生命周期 handle。

编译器在任何业务 Store 打开前完成以下 fail-closed 校验：

- capability、service 和 Public Capability 所有权不可重复；
- 依赖必须存在且图必须无环；
- Provider 实际输出只能是其声明的公开能力子集；
- Tool name 不可重复，并必须重新经过可信 Catalog compiler；
- Catalog revision、digest 和稳定 Tool name 集合必须与 Host authority 契约完全一致。

任一 Provider 启动或 Manifest 编译失败时，已启动 Provider 按逆序回滚。正常关闭先执行业务 producer/store 的 barrier，再按逆序执行 Manifest `prepareShutdown` 与 `close`。

## 3. 单一消费路径

- `ComposedRuntimeIngress` 是唯一生产编译点，并将同一个 Manifest 实例注入 Kernel 与 Agent Control。
- `RuntimeKernelApplication.status()` 不再读取 workspace、permission、MCP、Skills 或 Hook 配置自行猜测能力，只返回 Manifest 的已启动 Provider 结果。
- Agent Tool Catalog 不再由 `DefaultAgentControlRuntimeFactory` 组合；Workspace、Browser 和 MCP Provider 各自贡献 Tool registrations，Manifest 统一编译并冻结。
- `DefaultAgentControlRuntimeFactory` 只消费 Manifest 中的可信 Catalog snapshot，不再拥有 MCP 过滤、Sandbox 绑定或 Tool family 清单。

## 4. 可审计状态

`diagnosticSnapshot()` 只输出 definition、`started` 状态、公开能力和 Tool names，不包含端点、凭据、绝对路径或 Tool payload。`unwiredPublicCapabilities` 自动列出 Protocol 已定义、但没有任何生产 Provider 声明所有权的能力；当前包括旧 Proposal、Trace、Background Task、Scheduler、Resource 和 Memory 公共面。

配置关闭与未接线是两个不同状态：已启动 Provider 可以因权限或配置不满足而输出空的公开能力；缺少 Provider 则不会出现在诊断快照，也不会出现在 Runtime status。

## 5. 删除和扩展规则

删除能力时移除其 Provider，并处理依赖它的 Provider、协议/持久数据迁移和消费者；不得在 `status()`、Factory 或 Catalog 中保留兼容分支。新增能力必须通过静态 Provider seam 注册并具备直接测试，不得修改 Agent Core 来完成 Runtime 装配，也不得建立第二个动态插件加载器。

第一阶段不支持热重载。Provider 集合只来自受审计的生产 Composition；外部/用户代码不能向 Manifest 注入可执行实现。
