# Provider 协议与模型推理配置

## 设计结论

Ariadne 将远程模型接入拆成四层，避免把 Provider、协议和模型能力混为一体：

```text
Chat / Agent
  └─ ModelClient（统一请求）
       ├─ Embedded local model（Runtime 直接发现、加载和启动）
       └─ Remote API
            ├─ Model profile（该模型支持的模式与强度）
            ├─ Provider adapter（厂商参数映射）
            └─ Protocol transport（openai-compatible / anthropic-messages）
```

- 本地模型不使用 HTTP，不连接 Ollama、LM Studio、vLLM，也不要求这些外部应用常驻；其推理由 Ariadne Runtime 内嵌模型运行时执行。
- Provider 是服务商身份，例如 OpenAI、DeepSeek、Kimi、Anthropic。
- Protocol 是远程 API 的传输格式。多个 Provider 可以共享 `openai-compatible`，但仍保留各自的参数映射。
- Model profile 描述某个已配置模型实际支持的推理模式和强度。Chat 只显示 profile 声明的选项。
- API Key 按 Provider ID 独立加密保存，不属于 protocol，也不会返回 Renderer 明文。

## 常用 API 的当前差异

| Provider / 模型 | API 格式 | 推理模式 | 推理强度 | Ariadne 当前策略 |
| --- | --- | --- | --- | --- |
| OpenAI GPT-4o mini | OpenAI Chat Completions | 无可调推理模式 | 无 | 默认 profile 为空，不显示推理按钮 |
| OpenAI GPT-5.x / GPT-5.6 | OpenAI Chat Completions / Responses | 普通推理；`pro` 属于 Responses 能力 | 模型相关，常见为 `none/low/medium/high/xhigh/max` 的子集 | Chat Completions transport 映射 `reasoning_effort`；当前不启用 `pro` |
| DeepSeek V4 | OpenAI-compatible，也提供 Anthropic-compatible 入口 | `thinking.type=enabled/disabled` | `high/max` | `openai-compatible` transport + DeepSeek adapter；思考开启时不发送 `temperature` |
| Kimi K3 | OpenAI-compatible | 固定开启 | `low/high/max`，默认 `max` | Kimi adapter 只发送 `reasoning_effort`，不发送 `thinking` 和 `temperature` |
| Kimi K2.6 | OpenAI-compatible | `thinking.type=enabled/disabled` | 不支持 | profile 可声明开关，不显示强度 |
| Kimi K2.7 Code | OpenAI-compatible | 固定开启 | 不支持 | profile 只声明固定开启 |
| Anthropic Claude | 原生 Messages API；另有 OpenAI compatibility layer | 模型相关 | 原生能力与 OpenAI 字段不完全等价 | 默认使用 `anthropic-messages` 原生 adapter，不用兼容层替代生产能力 |
| Google Gemini | 原生 Gemini API；提供 OpenAI compatibility endpoint | 模型相关 | 模型相关 | 尚未内置；通用能力可先接兼容端点，高级能力应增加原生 adapter |

官方依据：

- [OpenAI Model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)
- [Kimi Model Parameter Reference](https://platform.kimi.ai/docs/api/models-overview)
- [Kimi Thinking Mode](https://platform.kimi.ai/docs/guide/use-kimi-k2-thinking-model)
- [Claude OpenAI SDK compatibility](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)
- [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)

结论是：主流远程厂商大多提供 OpenAI-compatible 入口，但它通常只是兼容核心 Chat Completions，不代表 Tool Call、Structured Outputs、图片、推理上下文和厂商高级能力完全等价。该结论不改变本地模型的 embedded runtime 路线。

## 通用接口

公开协议只使用统一枚举，不把厂商字段泄漏给 Chat：

```ts
type ReasoningMode = 'off' | 'on' | 'auto' | 'pro';
type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

interface ModelInferenceProfile {
  reasoning?: {
    modes: ReasoningMode[];
    defaultMode: ReasoningMode;
    efforts: ReasoningEffort[];
    defaultEffort?: ReasoningEffort;
  };
}

interface ModelInferenceOptions {
  reasoningMode?: ReasoningMode;
  reasoningEffort?: ReasoningEffort;
}
```

`ModelInferenceProfile` 是能力声明；`ModelInferenceOptions` 是一次 Chat 请求的实际选择。Runtime 会验证请求值是否属于当前模型 profile，不能由 Renderer 任意发送厂商参数。

## Settings JSON

每个 Provider 当前配置一个模型，并把 profile 与模型放在一起：

```json
{
  "providers": {
    "deepseek": {
      "model": "deepseek-v4-flash",
      "inference": {
        "reasoning": {
          "modes": ["off", "on"],
          "defaultMode": "on",
          "efforts": ["high", "max"],
          "defaultEffort": "high"
        }
      }
    },
    "kimi": {
      "model": "kimi-k3",
      "inference": {
        "reasoning": {
          "modes": ["on"],
          "defaultMode": "on",
          "efforts": ["low", "high", "max"],
          "defaultEffort": "max"
        }
      }
    }
  }
}
```

真实文件位于 Electron `userData/settings.toml`。仓库中的 `app/config/settings.default.toml` 是默认模板。API Key 在真实文件中只保存系统安全存储生成的密文；旧 `agent-settings.json` 只作为一次性迁移来源。

如果用户将模型名改成未知模型，设置界面会清空旧 profile，避免把上一个模型的参数错误套到新模型。用户可以在 JSON 中按新模型官方文档明确声明 profile。

## Chat 行为

1. Runtime 返回模型目录时附带该模型的 `inference` profile。
2. Chat 切换模型后读取对应 profile。
3. 只有多个模式时才显示模式切换按钮；只有多个强度时才显示强度切换按钮。
4. 用户选择随 `companion.chat.start` 发送，不修改全局默认值。
5. Runtime 再次校验选项，并由 Provider adapter 映射：
   - OpenAI：`reasoning_effort`
   - DeepSeek：`thinking.type` + `reasoning_effort`
   - Kimi K3：`reasoning_effort`
   - Kimi K2.6：`thinking.type`
6. Provider 返回的 `reasoning_content` 不展示为公开回答；仅在该 Provider 要求的后续轮次或工具调用中私下回传。

## 新增 Provider

新增远程 API 时应完成以下最小步骤：

1. 在 Provider catalog 登记 ID、显示名称、protocol、默认地址、默认模型和独立凭据槽位。
2. 若现有 protocol 足够，复用 transport，只新增 Provider 参数映射。
3. 若兼容层无法覆盖所需能力，新增原生 protocol adapter。
4. 为默认模型声明 profile，并用官方文档确认模式、强度和不兼容参数。
5. 增加请求体映射测试、流式响应测试、Runtime profile 校验测试和 Chat 控件验收。

不允许仅凭模型名称猜测并发送最高推理强度；更高强度通常意味着更高延迟和成本，必须由 profile 明确声明并让用户选择。
