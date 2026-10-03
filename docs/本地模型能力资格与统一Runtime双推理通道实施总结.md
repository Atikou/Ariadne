# Ariadne 本地模型能力资格与统一 Runtime 双推理通道实施总结

> 完成日期：2026-09-02
> 设计基线：《本地模型能力资格与统一Runtime双推理通道设计》
> 实施原则：直接替换错误协议，不保留旧资格兼容路径，不做模型切换或执行模式降级。

## 1. 实施结果

本次修改已经完成。Ariadne 现在只保留一个 Runtime 和一套 Conversation / Agent 权威状态，在模型推理边界内明确分为两条正式通道：

- Text Response Channel：只接收和返回普通文本，不提供工具，不要求模型生成内部 v3 JSON；
- Native Agent Channel：只接受 Provider 或 llama.cpp 的原生 Tool Calls，并由 Ariadne 映射为内部 Directive。

模型“当前可运行”和“具备什么能力”已经完全分离。模型文件能够加载、Provider 凭据存在，只能得到 `availability=ready`；是否可聊天、可运行 Agent、可运行 Plan，必须由当前指纹对应的资格报告决定。

## 2. 已替换的错误逻辑

以下旧逻辑已直接删除或替换：

- 删除“本地模型 ready 即 supportsAgent”的推导；
- 删除要求所有模型输出 `ariadne.agent-directive.v3` 文本 JSON 的生产路径；
- 删除旧 `AgentProtocolQualificationStore`、probation、quarantine 和 `textFallback`；
- 删除旧资格表的读取和迁移兼容，数据库 schema v46 直接删除 `model_agent_protocol_qualification`；
- 删除旧聊天、规划和 SubAgent 工厂中的模型改选循环；
- 禁止从普通文本猜测 JSON、工具名或控制动作；
- 禁止 Agent 失败后转为文本、切换模型或改变执行模式。

不符合资格的精确模型绑定会直接返回能力错误：

```text
model_text_qualification_required
model_agent_qualification_required
model_plan_qualification_required
model_vision_qualification_required
```

## 3. 当前统一 Runtime 结构

```text
Conversation / Agent Control
          |
Agent Run Admission
          |
Model Capability Registry
          |
    +-----+------------------+
    |                        |
Text Response           Native Agent
无工具、无内部 JSON       原生 Tool / Control Calls
    |                        |
    +-----------+------------+
                |
同一 Agent Run、持久化、权限、Projection
```

Text Response Channel 在 `chat` 模式且模型只有文本资格时启用。模型原始非空文本由 Runtime 映射为内部 `respond`，文本本身没有执行语义。

Native Agent Channel 用于通过 Agent/Plan 资格的模型。工具名称、参数、Scope 和 Control Calls 都通过现有固定契约验证；正文与可执行调用混合、未知工具、重复调用 ID 或非法参数会让当前 Run 直接失败。

## 4. 能力资格权威

新增 Runtime-owned `ModelCapabilityRegistry`，保存完整能力向量：

- 文本响应、流式文本、精确 Tokenizer、取消、视觉；
- 原生工具调用、参数、工具选择、工具结果续推；
- Agent 直接文本、Ariadne Control Calls、Plan Control Calls。

资格报告绑定端到端模型指纹。当前实现中：

- 本地指纹覆盖模型权重、`model.json`、Tokenizer/Chat Template 元数据、运行参数、`node-llama-cpp` 及 llama.cpp build 标识；
- 远程指纹覆盖 Provider 协议、规范化 endpoint、模型 ID、视觉声明和推理配置；
- 密钥不进入指纹、日志或公开投影；
- 指纹变化后，新指纹没有旧报告，因此能力自然回到 `unknown`，不会沿用历史资格。

资格数据库位于应用数据目录：

```text
runtime/data/model-capability/model-capability-v1.db
```

工作区不创建 `.agent`，会话、模型资格和 Runtime 数据均由软件目录下的权威存储统一管理。

## 5. 探测行为

本地模型首次发现或指纹变化后自动执行文本探测。完整 Agent/Plan 探测通过 `model.qualification.run.v3` 显式启动；设置页提供“重新检测”。远程完整探测不会在后台自动产生费用。

完整探测使用隔离的固定工具和固定输入，关键项目连续执行三次：

- 普通文本与流式输出；
- 原生工具选择和精确参数；
- 工具结果续推；
- 无工具直接回答；
- Ariadne 控制调用；
- Plan 结构化控制调用；
- 声明支持视觉的远程模型还会进行独立视觉探测。

探测不创建真实 Agent Run，不读取用户文件，不调用真实工具，也不写入工作区。

## 6. 本地 llama.cpp 修复

llama.cpp 适配器现在把工具契约作为原生 functions 传给 `node-llama-cpp`，并把原生函数调用及工具结果历史映射回统一模型边界。

真实本机探测还发现并修复了一个独立生命周期问题：`LlamaChat` 释放 sequence 后，`node-llama-cpp` 会异步归还 sequence ID；紧接着的下一次推理会在归还完成前收到 `No sequences left`。worker 现在等待 sequence 租约真正可用后再开始下一次推理。它没有重新执行请求、改换模型或降级通道。

本机模型实测结果：

| 模型 | 文本 | 流式 | 精确 Tokenizer | Agent | Plan | 结论 |
|---|---:|---:|---:|---:|---:|---|
| `qwen3.5-9b-uncensored-aggressive-q4km` | 通过 | 通过 | 通过 | 未通过完整探测 | 未通过 | 仅文本 |

这解释了此前“有一次成功，但多数时候 The Agent run failed”的现象：偶然生成一次可接受内容不代表能连续完成工具选择、工具结果续推和控制调用。现在它会稳定进入 Text Response Channel，而不是被误标为 Agent 模型。

## 7. Provider 凭据边界修复

Electron Main 会主动从 Runtime 子进程环境中移除 Provider 密钥。旧模型目录却只检查 `process.env`，导致安全存储中已有密钥的 Provider 被误判为不可用。

现在 Runtime 通过 Host Credential Capability 查询凭据是否已配置，并在实际请求时按精确 `credentialRef` 解析密钥；公开模型目录只得到 `checking / ready / unavailable / error`，不会接触密钥内容。

## 8. 产品行为

- 默认无工作区进入个人助手 `chat`，仅文本模型可以正常对话；
- Agent 合格模型在个人助手模式下只能获得全电脑只读工具；
- 选择工作区后进入 `agent`，只有 Agent 合格模型可发送，写入和命令能力仍限制在授权工作区；
- `plan` 只接受 Plan 合格模型，并保持只读权限衰减；
- 模型选择器显示“仅文本 / Agent / Plan / 检测中 / 未通过”；
- 能力不匹配时，Renderer 发送前阻止，Runtime 再做一次权威校验；
- 默认终端使用 App 终端上下文和应用数据目录，不依赖当前 Agent 工作区；显式恢复不会自动重放旧命令。

## 9. 关键实现位置

- `runtime/src/model/capability/`：能力向量、指纹、SQLite 注册表和探测器；
- `runtime/src/application/RuntimeKernelApplication.ts`：模型发现、自动文本探测、显式完整探测和凭据可用性；
- `runtime/src/application/RuntimeKernelModelInferenceGateway.ts`：精确模型绑定、能力 Admission 和本地/远程统一推理边界；
- `runtime/src/adapters/model/ProductionAgentEngineAdapter.ts`：Text Response 与 Native Agent 双通道；
- `runtime/src/model/local/`：llama.cpp 原生函数调用与 sequence 生命周期；
- `packages/protocol/src/public.ts`：资格命令、结果和公开模型字段；
- `app/src/renderer/src/modules/chat/`：按 chat/agent/plan 过滤模型；
- `app/src/renderer/src/modules/settings/SettingsPanel.tsx`：资格状态展示和显式重新检测。

## 10. 验证结果

最终验证均在当前工作区执行：

- `npm.cmd test`：258 个测试文件、1,369 个测试通过；
- `npm.cmd run check:architecture`：0 SCC、0 循环边、0 依赖规则违规；
- `npm.cmd run test:electron`：通过；
- `git diff --check`：通过，仅有 Git 的 LF/CRLF 提示；
- 真实本机 Qwen 隔离资格探测：文本、流式、精确 Tokenizer 通过，Agent/Plan 未通过；
- Electron 真实窗口覆盖显式资格检测、纯文本回复、原生工具调用、工具结果续推、用户询问、权限允许/拒绝、取消、五个 Runtime 崩溃边界、Main 重启和终端恢复。

## 11. 当前边界

- 本机 Qwen 只能聊天，不能进入 Agent/Plan；这不是降级结果，而是当前资格事实；
- 本地模型未声明视觉输入，因此 `supportsVision=false`；
- `cancellation` 能力字段已保留，生产 Run 取消链路和 Electron 取消恢复已验证，但当前隔离资格探测尚不把它派生为 Agent/Plan 准入条件；
- Provider 的同一精确绑定仍可执行传输层限次韧性策略，但不会改选模型、Provider 或执行通道。

## 12. 最终状态

当前实现满足以下关系：

```text
工作区决定权限；
资格决定通道；
模型产生原生文本或原生调用；
Ariadne 产生内部 Directive；
失败只说明失败，不触发另一条执行路径。
```
