# ADR-0028: Manifest-owned Agent instruction assembly

- Status: Accepted
- Date: 2026-08-29

## Context

Agent 准入曾有两个互不受约束的指令真相源：execution pipeline Factory 直接读取 Workspace instruction 并拼接 Skill catalog，admission reader 再按 execution mode 写死 plan/chat 系统提示。Capability Manifest 无法证明最终 Turn 输入来自哪些已启动能力，新增 contributor 也只能继续修改 Factory 或 reader。

## Decision

生产 Manifest 用独立 Provider 暴露 Workspace、Skill catalog 和 execution-mode policy 三个类型化 contributor，再由终端 `agent.instructions.assembly` Provider 组合为唯一 `AgentInstructionAssemblyService`。Factory 和 admission reader 不再读取文件、Skill service 或模式文案。

每个 contributor 声明稳定 id、version、order 和适用 mode，并只返回带 Workspace、Run 或 mode scope 的 typed block。Assembly 接收精确 Run/Session/Workspace/mode subject 与 `AbortSignal`，按稳定顺序生成 `complete: true` 的不可变快照；重复 id/order、矛盾 scope、无效 digest、超出单块/总量/数量预算或任一 contributor 失败都会使整次准入失败，不发布半份结果。

最终每个 system block 都携带 contributor、version、block、order、scope 和 SHA-256 revision 标记，并作为受保护 Turn input 的一部分进入既有持久快照与摘要链。运行中的 Run 不重新解析 contributor。

## Consequences

- Capability Provider 图、Agent Control service bundle 与实际 system input 使用同一装配权威。
- plan/chat 安全策略仍是静态受审计代码，但不再散落在 admission reader。
- Workspace 与 Skill contributor 只适用于 agent/plan；chat 只接收 mode policy，不意外继承项目指令。
- 这不是动态插件系统；Skill contributor 已按 ADR-0029 消费可取消 scoped snapshot 和 last-good，任意代码注册、资源包与 invocation policy 仍是后续能力。
- Provider 接线和快照编译器分文件维护，避免把 Factory 缩减出的复杂度转移到新的巨型入口。
