# ADR-0031: Manifest-owned trusted Hook Provider lifecycle

- Status: Accepted
- Date: 2026-08-29

## Context

`hooks.lifecycle` 曾是一个只宣告 Public Capability 的空 Provider。真正的 `ConfiguredAgentLifecycleHooks` 由 `ProductionAgentControlExecutionPipelineFactory` 直接读取 `runtimePolicy.hooks` 并构造，因此 Manifest 不拥有 handler、缺 Provider 仍可能由 Pipeline 自行补出行为，初始化失败也没有统一的 handler 关闭路径。这延续了已经从 Skills、Telemetry 和 live-work 中删除的中央 Factory 硬编码。

Hook delivery sink 只有在 Agent Control 的 Public Projection Store 打开后才存在，所以也不能在 Manifest 编译时提前绑定并把 Store 反向注入 Provider。

## Decision

- `hooks.lifecycle` 必须提供 `agent.hooks.lifecycle` service；终端 `agent.control.runtime-services` 将它作为 required dependency 组装进唯一类型化 bundle。缺少 Hook Provider 时 Manifest 编译 fail closed。
- service 只接受静态、受审计且 providerId 唯一的 `AgentLifecycleHookProvider`。生产默认贡献 declarative configured Provider，不扫描磁盘、不加载 Skill script，也没有运行期 register/unregister API。
- Provider 在 Manifest start 时注册；Agent Control Store 建立后，Pipeline 只调用 service `bind(deliverySink)` 获得一个 handler set，不再读取 Hook 配置或实例化具体类。
- admission handler 依次执行，最终结果仍由既有 attenuation validator 证明没有扩权；inference/tool pre handler 异常 fail closed；post observer 异常按 Provider 隔离并 fail open。
- handler 只看到 typed event、稳定 event id、时间，以及 admission 边界已有的 immutable binding；不获得 Prompt、Tool 输入输出、路径、credential 或 Store 对象。
- Manifest 关闭时先按反向绑定顺序关闭所有 handler set，再按反向 Provider 顺序关闭 Provider。关闭幂等；关闭后的 bind/pre 操作 fail closed，post observation 被忽略。

## Consequences

- `hooks.lifecycle` 不再是假状态，Factory 中也没有 Hook service id 或配置拼装。
- 初始化中途失败、正常 shutdown 和测试 composition 共用同一关闭所有权。
- 当前不提供外部动态 Hook 包发现、签名验证或热重载；若未来需要，只能在静态生产 composition 中增加受信任 Provider，不能通过 Skill 目录或任意 JavaScript 注册绕过 admission/Effect 权威。
