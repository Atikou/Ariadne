# Ariadne 本地模型能力资格与统一 Runtime 双推理通道设计

> 状态：已按当前项目完成实现，并于 2026-09-02 通过全量测试、架构门禁、真实 Electron 冒烟和本机 Qwen 资格探测。
> 基线：2026-09-02 当前工作区。
> 来源：根据《本地模型能力探测与双运行时架构设计》重新推导；原文仅作为设计输入，不作为代码或迁移指令。
> 实施记录：见《本地模型能力资格与统一Runtime双推理通道实施总结》。

## 1. 结论

Ariadne 不应建立两套彼此独立的应用 Runtime，也不应让所有模型生成 `ariadne.agent-directive.v3` JSON。

符合当前项目的结构是：

- 只保留一个 Runtime、一个 Conversation 权威、一个 Agent Run 权威、一个权限编译器和一个 Public Projection。
- 在模型推理边界内建立两条明确通道：纯文本响应通道与原生 Agent 通道。
- 模型原始文本由应用映射为内部 `respond` Directive；内部 JSON 由 Ariadne 生成，不由纯文本模型生成。
- 只有端到端通过原生工具调用、工具结果续推和控制调用探测的模型，才允许进入 Agent/Plan 通道。
- 模型能力与运行可用性分开记录，不能再用“模型文件可加载”推导“支持 Agent”。
- 能力不匹配时直接拒绝该次执行，不自动换模型、不自动降级、不把非法输出当作普通文本补救。

因此，本文中的“双通道”是同一 Runtime 内的两个模型决策适配器，不是两个进程、两套数据库或两套会话系统。

## 2. 当前项目的真实边界

当前生产链路是：

```text
Renderer
  -> conversation.message.accept.v3
  -> Conversation Authority / Handoff Outbox
  -> Agent Run Admission
  -> Agent Run Scheduler
  -> ProductionAgentEngineAdapter
  -> Model Inference Gateway
  -> Agent Run terminal state
  -> protected assistant content
  -> Public Projection
  -> Renderer
```

这条链路已经承担以下职责，必须保留：

- Conversation、Message 和 Session 的版本权威；
- Agent Run、Turn、Attempt、Directive 和 Effect 的持久化；
- 幂等、恢复、预算、取消和截止时间；
- Tool Catalog、Capability、Scope 与 Workspace 权限绑定；
- 受保护正文与公开投影分离；
- Electron Main 到独立 Runtime 的 IPC 边界。

当前 UI 已经确定执行上下文：

- 无工作区时使用 `ariadne-personal-assistant`，执行模式为 `chat`；
- 选择工作区后执行模式为 `agent`；
- 工作区中启用计划模式后执行模式为 `plan`。

所以新设计不增加“聊天/Agent”意图分类器，也不要求用户额外选择一套 Runtime。工作区和计划开关继续决定权限与执行上下文，模型资格只决定当前模型能否承担该上下文。

## 3. 必须替换的错误前提

### 3.1 “本地模型 ready 就支持 Agent”是错误的

当前 `RuntimeKernelApplication.modelSnapshot()` 把本地模型的 `status === 'ready'` 直接投影为 `supportsAgent: true`。`ready` 只证明模型目录和推理运行时可用，不证明模型具备工具调用或 v3 控制能力。

### 3.2 本地模型声明不支持工具，却被送入严格 Agent 协议

当前 `EmbeddedModelClient.toolCallCapability` 固定为 `unsupported`，`LlamaCppRuntime.generate()` 也没有把 `request.tools` 传入 worker，但 `RuntimeKernelModelInferenceGateway` 仍把所有本地客户端作为 Agent 候选。

这使纯文本本地模型被要求输出严格 v3 JSON。模型偶尔生成正确 JSON 时 Run 成功，直接生成正常文本时则以 `agent_model_directive_invalid` 失败。

### 3.3 旧资格缓存不是当前 v3 权威

`model-router/agent-protocol-qualification.ts` 已有 `probation / qualified / quarantined` 逻辑，但它属于旧 App Model Router 路径，并未控制当前 v3 的 `RuntimeKernelModelInferenceGateway.resolveBinding()` 与 Agent Run Admission。

不能把这套旧逻辑再接一层作为补丁。它应由 Runtime 模型域内新的权威资格注册表替换，旧资格记录不迁移。

### 3.4 生产失败不能反向触发静默降级

生产 Run 失败是诊断事实，不是自动切换执行语义的依据。以下行为均禁止：

- 严格协议失败后把同一响应当作普通文本展示；
- 自动把 Agent 请求改成 Text Chat；
- 自动改选远程模型；
- 连续失败后临时修改模型能力标签；
- 解析普通文本中的 JSON、命令或工具名称并执行。

## 4. 目标架构

```text
                         一个 Ariadne Runtime
                                  |
                    Conversation / Agent Control
                                  |
                        Agent Run Admission
                                  |
                  Model Capability Authority
                                  |
                    Inference Boundary Selector
                         /                  \
                        /                    \
          Text Response Channel       Native Agent Channel
          - 不发送 Tools              - 原生 Tool Calls
          - 不发送 v3 JSON 提示        - Tool Result 续推
          - 原始文本流                 - Ariadne Control Calls
          - 系统映射 respond           - 系统映射内部 Directive
                        \                    /
                         \                  /
                      同一个 Agent Run 状态机
                                  |
                   Protected Content / Projection
                                  |
                           同一个会话界面
```

### 4.1 Text Response Channel

适用于通过文本能力探测、但未通过 Agent 能力探测的模型。

规则：

- 只允许用于 `execution.mode === 'chat'`；
- 不发送工具定义；
- 不发送 `ariadne.agent-directive.v3` 提示；
- 不要求 JSON Schema、内部 Tag、计划或工具选择；
- 模型返回的非空文本是模型正文；
- Ariadne 将正文写入受保护的 `response_content`，并生成内部 `respond` Directive；
- 文本中出现命令、JSON 或工具名不会触发任何操作；
- 仍使用现有 Run、Attempt、预算、取消、持久化和 Projection 链路。

这不是失败后的 fallback，而是模型资格确定后选定的正式执行通道。

### 4.2 Native Agent Channel

适用于通过完整 Agent 能力探测的模型。

模型边界只接受两类原生结果：

```ts
type NativeModelDecision =
  | { kind: 'text'; content: string }
  | { kind: 'tool_calls'; calls: NativeToolCall[] };
```

应用映射规则：

- 原生文本映射为内部 `respond`；
- 业务工具调用映射为内部 `invoke_tools`；
- 工具结果按 Provider 原生协议回传，再进入下一次推理；
- Ariadne 控制动作通过保留的原生 Control Calls 表达，再映射为 `ask_user`、`propose_plan`、`checkpoint`、`complete`、`fail` 或 SubAgent Directive；
- 不允许同时混合正文与可执行调用；
- 不允许从普通文本猜测工具或控制动作。

`AgentDirective` 仍是 Agent Control 的内部权威结构，但不再要求纯文本模型手工生成整个 v3 Envelope。

## 5. 能力模型

能力不能压缩成一个容易误判的 `supportsAgent` 布尔值。Runtime 内部使用能力向量：

```ts
interface ModelCapabilityQualification {
  fingerprint: string;
  adapterProtocolVersion: number;

  textResponse: QualificationState;
  streamingText: QualificationState;
  exactTokenizer: QualificationState;
  cancellation: QualificationState;
  visionInput: QualificationState;

  nativeToolCalls: QualificationState;
  validToolArguments: QualificationState;
  toolSelection: QualificationState;
  toolResultContinuation: QualificationState;
  directTextInAgent: QualificationState;
  ariadneControlCalls: QualificationState;
  planControlCalls: QualificationState;

  testedAt?: string;
  evidenceDigest?: string;
  failureCode?: string;
}

type QualificationState =
  | 'unknown'
  | 'testing'
  | 'qualified'
  | 'rejected';
```

派生能力：

```ts
supportsTextChat = textResponse === 'qualified';

supportsAgent =
  nativeToolCalls === 'qualified'
  && validToolArguments === 'qualified'
  && toolSelection === 'qualified'
  && toolResultContinuation === 'qualified'
  && directTextInAgent === 'qualified'
  && ariadneControlCalls === 'qualified';

supportsPlan =
  supportsAgent
  && planControlCalls === 'qualified';
```

Availability 与 Qualification 必须独立：

- `availability=ready`：传输或本地推理进程当前可用；
- `supportsTextChat=true`：端到端文本探测通过；
- `supportsAgent=true`：完整 Agent 探测通过；
- `supportsPlan=true`：计划控制探测通过。

## 6. 模型指纹

资格记录必须绑定实际端到端链路，而不是只绑定模型名称。

本地模型指纹至少包含：

- 模型权重内容摘要；
- `model.json` 内容摘要；
- Tokenizer 与 Chat Template 摘要；
- `node-llama-cpp` 版本；
- llama.cpp backend/build 标识；
- 本地模型适配器协议版本；
- 影响模板或函数调用的运行参数。

远程模型指纹至少包含：

- Provider ID 与协议类型；
- 规范化 endpoint；
- 模型 ID；
- Provider 适配器版本；
- 工具/结构化输出配置摘要。

凭据不得进入指纹或能力报告。指纹发生变化后，旧资格直接失效为 `unknown`，不能继续沿用。

## 7. 端到端能力探测

### 7.1 探测所有权

能力探测由 Runtime 模型域拥有，使用隔离的 Probe Tool Catalog 和 Probe Control Catalog。它不创建真实工作区工具，不读取用户文件，不访问系统设置，也不写入 Conversation 或 Agent Run。

资格数据统一保存在应用数据目录下的 Runtime 受保护存储中，例如：

```text
%APPDATA%/Ariadne/runtime/data/model-capability/model-capability-v1.db
```

工作区内不创建 `.agent` 或任何能力缓存目录。

### 7.2 探测阶段

1. Availability：模型能加载或 Provider 可连接。
2. Text：能够返回非空文本，流式和取消行为符合适配器声明。
3. Native Tool Call：产生真正的 Provider/llama.cpp 函数调用对象。
4. Arguments：名称、必填字段、类型、枚举和值全部正确。
5. Selection：多个虚拟工具中选择正确目标。
6. Continuation：接收虚拟工具结果后生成正确后续响应。
7. Direct Text：无需工具时直接返回自然语言正文。
8. Control Calls：正确产生 Ariadne 内部控制调用。
9. Plan：正确产生结构化计划控制调用。

探测工具只使用固定数据：

```text
probe.echo
probe.calculate
probe.lookup_fixture
```

关键 Agent 用例使用 `temperature=0`，每项重复三次，全部通过才标记为 `qualified`。在普通文本中打印函数 JSON 视为失败。

### 7.3 探测时机

- 本地模型首次发现或指纹变化后自动进行文本探测；
- Agent/Plan 资格由完整探测产生；
- 远程模型的完整探测由用户明确启动，避免隐性费用；
- 用户可以显式重新检测；
- 生产 Run 不更新资格，不触发自动降级。

## 8. 执行选择规则

| 执行上下文 | 模型资格 | 推理通道 | 权限与工具 |
|---|---|---|---|
| 个人助手 `chat` | 仅 Text 合格 | Text Response | 不发送工具；只能对话 |
| 个人助手 `chat` | Agent 合格 | Native Agent | 只提供 `computer.*` 全电脑只读工具 |
| 工作区 `agent` | Agent 合格 | Native Agent | 全电脑只读；工作区内按授权写入和执行 |
| 工作区 `plan` | Plan 合格 | Native Agent | 保持现有只读衰减权限 |
| `agent/plan` | 资格不满足 | 不执行 | 返回明确的能力不匹配错误 |

补充规则：

- UI 选择具体模型后，不静默改选其他模型；
- 自动路由只从满足当前执行上下文的候选集中选择；
- 个人助手的权限上限仍是全电脑只读，但 Text-only 模型没有调用工具的能力，UI 必须显示“仅文本，不能读取本机”；
- 选择工作区不会提升 Text-only 模型能力，因此必须在发送前标明不兼容，并由 Runtime 再次权威校验。

## 9. 与当前代码的替换关系

### 9.1 保留

- `LocalModelService` 的模型目录发现、加载、卸载和运行时生命周期；
- Conversation v3、Agent Control、Run/Turn/Attempt/Effect 状态机；
- `compileEffectiveAgentExecutionAuthority()` 的 chat/agent/plan 权限衰减；
- Tool Catalog 固定身份、Scope 校验和权限执行；
- Protected Payload、Public Projection、恢复与幂等；
- 精确模型绑定、Token 计数和 Long Context 规划。

### 9.2 替换

- 用 Runtime-owned `ModelCapabilityRegistry` 替换旧 `AgentProtocolQualificationStore`；
- 用能力报告替换 `supportsAgent: model.status === 'ready'`；
- 扩展 `RuntimeModelCatalogEntry` 和 Public Model Projection，公开 `supportsTextChat / supportsAgent / supportsPlan / qualificationState`；
- 让 `resolveBinding()` 接收明确的执行能力要求，不再把所有本地模型加入所有模式候选；
- 将 `ProductionAgentEngineAdapter` 拆成 Text Response 与 Native Agent 两个决策适配器；
- 删除普通响应必须解析 `ariadne.agent-directive.v3` Envelope 的要求；
- 为 llama.cpp 实现真实函数调用传输后，才允许其通过 Agent 探测；
- 删除旧的 probation、quarantine、`textFallback` 和运行失败自动改路逻辑；
- 失败投影显示安全、明确的错误码，不再只显示 `The Agent run failed.`。

### 9.3 不保留兼容分支

旧资格表和旧 `supportsAgent` 推导属于错误协议，不做双写、不做读取 fallback、不做历史记录转换。新 schema 启用时清除旧资格数据，并按新模型指纹重新探测。

## 10. 当前 Qwen 本地模型在新设计中的结果

当前 `qwen3.5-9b-uncensored-aggressive-q4km` 已通过真实本机资格探测，证明：

- GGUF、llama.cpp、Tokenizer 和普通文本生成可用；
- 文本响应、文本流和精确 Tokenizer 均合格；
- 当前本地适配器已经提供 llama.cpp 原生函数调用传输；
- 模型未能连续通过完整 Agent 探测，因此一次偶然工具/JSON 成功不构成 Agent 资格。

因此它应被登记为：

```text
supportsTextChat = true
supportsAgent = false
supportsPlan = false
```

它在默认个人助手会话中走 Text Response Channel，正常显示原始回复；选择工作区执行 Agent/Plan 时直接提示模型能力不匹配。不能再因为一次偶然成功而将其视为 Agent 模型。

## 11. 错误语义

建议采用明确错误码：

```text
model_text_qualification_required
model_agent_qualification_required
model_plan_qualification_required
model_capability_fingerprint_changed
model_native_tool_contract_invalid
model_control_call_invalid
model_response_empty
model_runtime_unavailable
```

错误处理原则：

- 资格不满足：在 Admission 前拒绝；
- 运行时不可用：当前 Run 失败并显示真实安全原因；
- Native Agent 返回非法结构：当前 Run 失败，不转 Text；
- Text Response 返回空正文：当前 Run 失败，不生成虚假消息；
- 任何失败都不改变权限、不更换模型、不重放为另一种执行模式。

## 12. 实施顺序

1. 定义能力报告、指纹、存储和公开投影协议。
2. 建立 Runtime-owned `ModelCapabilityRegistry` 与隔离 Probe Harness。
3. 修改模型目录与 Provider catalog，分离 availability 和 qualification。
4. 实现 Text Response Channel，并让 Text-only 模型只在 chat Admission 中可用。
5. 实现 Native Agent Channel 的原生工具与 Control Calls 映射。
6. 修改 `resolveBinding()`、Admission 和 UI 候选过滤。
7. 删除严格文本 Envelope、旧资格缓存、quarantine 和 fallback 逻辑。
8. 清理旧资格数据，以新指纹重新探测。
9. 完成真实 Electron、Runtime、数据库恢复和权限边界验证。

每一步都应直接替换对应错误所有者，不能在旧路径外再包一层兼容适配器。

## 13. 验收标准

### 13.1 Text-only 本地模型

- 模型不再收到 Tool Schema 或 v3 Directive 提示；
- 连续多轮普通对话均以内部 `respond` 完成；
- 原始文本可以流式显示；
- 文本中的 JSON、命令或工具名称不会被执行；
- 在工作区 Agent/Plan 模式下发送前提示不兼容，Runtime 同样拒绝；
- 不再出现由普通文本触发的 `agent_model_directive_invalid`。

### 13.2 Agent 模型

- 所有关键探测用例连续三次通过；
- 原生工具名称、参数和 Scope 均通过现有固定 Tool Catalog 校验；
- 能接收工具结果并继续推理；
- 无需工具时能返回原始最终文本；
- chat 模式只能访问全电脑只读工具；
- agent 模式只能在授权工作区内写入或执行；
- plan 模式保持只读。

### 13.3 系统

- 只有一个 Runtime 和一套 Conversation/Agent 权威数据；
- `supportsAgent` 不再由模型文件 ready 状态推导；
- 不存在生产失败自动降级、自动换模型或文本猜工具逻辑；
- 模型选择器清楚展示“仅文本 / Agent / Plan”资格；
- 能力指纹变化会使旧资格失效；
- 能力数据库位于应用数据目录，工作区内不产生 `.agent`；
- 真实 Electron 窗口验证 Text、Agent、Plan、失败提示和重启恢复。

## 14. 最终原则

```text
工作区决定权限边界；
用户选择模型或路由策略；
模型资格决定可进入的推理通道；
Ariadne 生成内部控制结构；
模型只生成它被证明能够稳定生成的内容。
```

纯文本聊天不是 Agent 失败后的退路，而是一等执行能力；Agent 也不是“模型能加载”后的默认身份。两者共用 Ariadne 的权威 Runtime，但必须在模型边界上严格分开。

## 15. 2026-09-02 实施验证

- 全仓测试：258 个测试文件、1,369 个测试通过；
- 架构门禁：0 个循环依赖、0 个依赖规则违规；
- Electron 冒烟：显式资格检测、Text/Agent 通道、五次 Runtime 边界终止恢复、Main 重启恢复及终端显式重启均通过；
- 本机 Qwen：`supportsTextChat=true`、`supportsAgent=false`、`supportsPlan=false`；
- 工作区内不创建 `.agent`，能力数据与会话数据继续由应用目录中的 Runtime 权威存储管理。
