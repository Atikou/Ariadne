# Agent 提案协议与诊断日志

## 设计边界

Companion 只负责把用户请求解释为非执行性的 Agent 能力提案。真实身份、工作区、作用域、授权和执行句柄只由 Runtime 绑定，模型输出不能携带这些字段。

提案按固定顺序经过：

1. `transport_selection`：根据模型声明选择传输。
2. `protocol_parse`：解析原生工具调用或版本化文本信封。
3. `schema_validation`：校验字段、类型、枚举、长度和额外字段。
4. `business_validation`：校验风险与能力组合等业务语义。
5. `permission_validation`：由 Runtime 按用户、工作区和宿主能力边界裁剪并校验。
6. `proposal_delivery`：通过持久化 Outbox 幂等投递授权提案。

任何阶段失败都不能越过后续边界，也不能创建宽于用户权限的授权请求。

## 传输协议

支持原生结构化工具调用的模型必须调用：

```text
request_agent_capabilities
```

工具参数严格包含：

- `reason`
- `interpretedTask`
- `requestedCapabilities`
- `risk`

明确声明 `toolCallCapability: "unsupported"` 的本地模型不接收工具 Schema，改用版本化兼容信封：

```text
<ariadne-agent-proposal protocol="1">
{"reason":"...","interpretedTask":"...","requestedCapabilities":["file-read"],"risk":"read-only"}
</ariadne-agent-proposal>
```

原生工具模型不能静默降级到文本信封；未版本化信封也不属于有效协议。

原生响应中的结构化工具调用是提案载荷的唯一权威来源。模型若在同一次响应中附带普通说明文字，Runtime 丢弃该文字、记录 `discarded_text_with_tool_call` 警告，并继续对工具参数执行 Schema、业务语义和权限校验；这不是自动重试条件。

## 重试规则

协议错误必须显式声明 `retryable`。自动重试还必须同时满足：

- 尚未创建 Outbox 或产生任何现实副作用；
- 当前请求具有持久化用户消息提供的幂等身份；
- 错误发生在可修复的传输、协议或 Schema 阶段；
- 本轮尚未自动重试。

业务语义失败、权限校验失败、提案投递结果未知以及任何非幂等写操作都不自动补救。

## 日志契约

Runtime 日志统一包含显式 `level`、`category`、`message` 和可选 `metadata`。Agent 提案失败日志至少包含：

- 生命周期阶段和稳定错误分类；
- 标准化字段路径；
- 模型名称和协议版本；
- 响应 SHA-256；
- 响应长度、工具名称及脱敏截断片段；
- `retryable` 和是否具有幂等保障。

输入日志只保存长度及脱敏、截断后的预览。密钥、令牌和认证字段由 Trace 写入边界统一脱敏。日志面板默认显示时间、级别、分类和消息，结构化元数据通过“结构化详情”展开查看。

Trace 成功写入后，同一份已脱敏事件会发布到 Runtime 可重放事件流，并实时投影为 `trace.appended`。日志面板的初始 `trace.list` 与实时事件按 `traceId` 合并，启动刷新期间产生的日志不会被快照覆盖。
