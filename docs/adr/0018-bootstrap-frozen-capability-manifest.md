# ADR-0018: Bootstrap-frozen Capability Manifest

- Status: Accepted
- Date: 2026-08-26

## Context

Runtime status、first-party Tool Catalog、Agent Factory 和权限过滤分别维护能力清单。它们可以独立漂移，因此“代码存在”“Tool 已注册”和“Runtime 对外宣告”不是同一个事实。

## Decision

生产 Runtime 在 bootstrap、打开业务 Store 之前启动一组静态 Capability Provider，并编译一个不可追加的 Manifest。Provider 声明 identity、contract、dependency、service ownership 和 Public Capability ownership；Handle 贡献实际公开能力、Tool registrations 与关机生命周期。

Ingress 把同一个 Manifest 交给 Runtime Kernel 和 Agent Control。Kernel status 只读取 Manifest；Agent Control 只消费 Manifest 编译的可信 Tool Catalog。Provider 图、公开所有权、实际输出、Catalog digest 和依赖在启动时 fail closed，启动失败和正常关机都按 Provider 逆序释放。

生产 Composition 不支持从任意磁盘加载 JavaScript、运行时注册或热重载。协议枚举中没有 Provider owner 的条目由 `unwiredPublicCapabilities` 自动报告，不得出现在 Runtime status。

## Consequences

- Factory、Catalog 和 status 不再各自拥有能力真相。
- 移除 Provider 会同时移除其公开宣告和 Tool contribution；配置仍存在也不能伪造接线。
- Capability Provider 仍是受审计的静态 Composition，不是通用插件系统。
- 新 Provider 必须声明依赖、服务、公开面、生命周期和直接验证证据。

当前实现与删除规则见 [Runtime Capability Manifest](../capability-manifest.md)。
