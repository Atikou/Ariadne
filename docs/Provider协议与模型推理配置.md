# Provider 协议与模型推理配置

> 核对日期：2026-08-26
> 本文只记录 Ariadne 的稳定接入规则，不维护容易过期的第三方模型能力表。

## 分层

```text
Conversation message execution
  -> immutable model binding
  -> RuntimeKernelModelInferenceGateway
       |-> embedded local model
       `-> remote Provider adapter
             -> protocol transport
```

- Provider 是服务商和凭据槽位的身份。
- Protocol 是请求/响应格式；多个 Provider 可以复用 compatible transport，但能力不能由“兼容”标签推断。
- Model profile 描述具体模型允许的 reasoning mode/effort。
- Model binding 在 admission 时固定；恢复和 follow-up inference 必须使用同一权威绑定。
- 每个精确 Provider/model/settings revision 同时固定 `contextWindowTokens` 和 `maxOutputTokens`，供 v3 Context lifecycle 计算输入压力；不得使用跨模型全局窗口。
- Renderer 只发送通用模型选择和推理选项，不发送厂商私有字段。

## 当前生产边界

- 远程 Provider 配置由 Main 从 `settings.toml` 读取并转换为 Host bootstrap；
- API Key 由 Main 使用系统安全存储保护，Renderer 只看到状态，Runtime 通过受控环境槽位读取；
- 本地模型由 Runtime 扫描授权的只读模型目录并通过 embedded runtime 加载，不依赖外部常驻 HTTP 服务；
- `RuntimeKernelModelInferenceGateway` 根据持久模型绑定选择本地或远程实现；
- `ProductionExactAgentModelInferenceGateway` 校验 Provider、模型、容量、推理选项和稳定幂等身份，并把有界的 context-overflow 响应规范化为一次显式恢复证据；
- 找不到已绑定模型或凭据时 fail closed，不静默切换其他 Provider。

当前真实 Electron smoke 会通过设置接口启用进程外 HTTPS OpenAI-compatible fixture，并经生产 Provider adapter 执行推理、Tool continuation 和请求取消。它不是真实远程或本地模型；stream、reasoning、费用以及各 Live Provider 的错误行为仍需单独验收。

## Public 选项

Public 协议使用统一选项：

```ts
type ReasoningMode = 'off' | 'on' | 'auto' | 'pro';
type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

interface ModelInferenceOptions {
  reasoningMode?: ReasoningMode;
  reasoningEffort?: ReasoningEffort;
}
```

`conversation.message.accept.v3` 的 `execution` 可携带 `modelId`、`inference` 和 `routingStrategy`。Runtime 必须再次验证选项是否属于当前模型 profile；Renderer 不能仅根据模型名称猜测能力。

## 设置与凭据

- 默认模板：`app/config/settings.default.toml`；
- 实际文件：Electron `userData/settings.toml`；
- 设置仓库：`app/src/main/persistence/agent-settings-repository.ts`；
- Host bootstrap 映射：`app/src/main/runtime/runtime-configuration.ts`；
- Runtime policy 契约：`packages/protocol/src/settings.ts`。

仓库模板只提供初始默认值，不是第三方 Provider 能力的权威资料。修改模型时必须同步核对并显式保存上下文窗口和最大输出；升级默认模型、endpoint、容量或 reasoning profile 前，必须核对对应 Provider 的官方文档并增加请求映射测试。

## 新增或修改 Provider

1. 在 Provider catalog 中登记稳定 ID、协议、默认 endpoint、模型、上下文窗口、最大输出和独立凭据槽位。
2. 明确该模型 profile；未知能力保持未声明，不能猜测最高 reasoning effort。
3. 若 compatible transport 足够，只增加窄参数映射；需要厂商语义时新增原生 adapter。
4. 保证 admission snapshot、恢复和 follow-up inference 使用同一模型绑定。
5. 增加请求体、响应解析、错误分类、取消、idempotency 和敏感信息测试。
6. 在受控环境完成至少一次真实模型 direct answer 和 Tool call 验收。
7. 更新 [验收矩阵](verification-matrix.json)，未完成的 realModel/realWindow 维度保持 `not_accepted`。

Provider Resilience 的冻结 policy 由 bootstrap 直接装配进 exact v3 transport。共享协调器按精确 Provider/model/settings 路由拥有并发、每分钟请求/预留 token、熔断和退避状态；只有 429、可重试 5xx、timeout/临时网络错误且尚未出现 text、reasoning 或 native Tool-call 输出时才透明重试。`Retry-After` 受本地 `maxBackoffMs` 上限约束，用户取消保留原始 Abort 原因，context overflow 仍交给既有有界压缩恢复。上层不得叠加第二套透明重试。
