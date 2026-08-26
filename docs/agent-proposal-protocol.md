# Companion 能力请求协议

> 核对日期：2026-08-26
> 这是 Companion 对用户意图的内部解释协议，不是 Public v3 的独立 Proposal 命令面。

## 边界

Companion 只能提出非执行性的能力请求。真实 Session、Workspace、Model、Tool Catalog、Capability Grant、Decision 和 Run 身份由 Runtime 绑定；模型输出不能创建授权或执行句柄。

```text
Companion output
  -> transport parse
  -> strict schema validation
  -> business/risk validation
  -> Runtime authority narrowing
  -> Conversation Handoff
  -> v3 Run / Decision Projection
```

任何阶段失败都不能越过后续边界，也不能扩大 Main 注入的 Workspace 或 permission ceiling。

## 模型传输

支持结构化工具调用的 Companion 模型使用：

```text
request_agent_capabilities
```

参数只包含：

- `reason`；
- `interpretedTask`；
- `requestedCapabilities`；
- `risk`。

明确不支持 Tool Calling 的模型可使用版本化文本信封：

```text
<ariadne-agent-proposal protocol="1">
{"reason":"...","interpretedTask":"...","requestedCapabilities":["file-read"],"risk":"read-only"}
</ariadne-agent-proposal>
```

原生 Tool Calling 模型不能静默降级到文本信封。结构化调用出现时，其参数是唯一提案载荷；同一响应中的普通说明文字不参与授权。

## 重试与幂等

协议修复只能发生在尚未产生现实副作用时，并且必须满足：

- 输入有稳定的已持久化消息身份；
- 错误属于可修复的 transport/schema 阶段；
- 尚未创建 Handoff/Decision/Run 权威事实；
- 本轮修复次数有界。

业务语义失败、权限收窄失败、Handoff 结果未知或任何跨过外部 I/O 的操作都不能透明重试。

## Public v3 映射

Public 协议不暴露旧的 `agent.proposals` 写流程。需要用户确认的权限、计划或恢复动作进入 sanitized Decision Projection；Renderer 只使用 `agent.decision.resolve.v3` 和 opaque action token。

诊断事件必须脱敏。当前 v3 没有完整生产 Diagnostics publisher，因此不能宣称 proposal 解析日志会自动进入持久、可重放的公共日志流。
