# v3 长上下文生命周期

- 状态：已接入生产 v3 推理链
- 核对日期：2026-08-30
- 范围：Conversation 历史、同一 Run 的因果历史、Context pressure compaction、Tool result spill、Provider overflow recovery

## 结论

长上下文不再经过旧 `AgentLoop` 或 `prepareChatRequestForModel`。旧实现按启发式价值静默挑选消息，既不属于 v3 权威链，也无法证明 Tool 调用与结果的因果配对，因此不能作为生产修复基础。

当前生产链为：

```text
Conversation immutable history through objective
  -> protected Agent Turn input
  -> AgentEngine.prepare (no Provider I/O)
  -> exact route capacity + per-binding local tokenizer count
  -> deterministic context plan
  -> primary/recovery projection re-count + hard admission
  -> deterministic causal semantic projection for the compacted prefix
  -> inference_started checkpoint with request digests
  -> exact Provider request
  -> one prepared overflow-recovery projection when explicitly rejected
  -> owner-scoped protected Effect result retrieval when a spill locator is used
```

## 权威与恢复边界

1. Conversation Store 按 Session version 顺序读取截至当前 objective 的不可变 user/assistant 历史；并发产生的后续消息不会混入旧 Handoff。
2. 完整累计历史仍保存在受保护 Turn input 中。Context compaction 只改变模型投影，不改写 Conversation、Run、Turn 或 Tool result 权威。完整 Tool result 已由 Agent UoW 作为受保护 Effect payload 持久化；它同时是 spill object，禁止另建第二套文件或对象存储。
3. `AgentEngine.prepare` 只能读取 immutable Tool contract、渲染协议并生成上下文投影，禁止 Provider I/O。
4. 完整投影、压力压缩投影和更小的 overflow recovery 投影都由相同输入确定性派生。被省略前缀由纯函数 `DeterministicSemanticContextCompactor` 投影为普通 `user` 历史检查点，不执行隐藏 Provider I/O，也不把用户正文抬升为 system 权限。准备完成后会重新读取 Run 权威：若期间只有 inbox 发生并发变化，`inference_started` 在最新 inbox 版本上重基；其他漂移 fail closed。source/request digest、容量、估算 token、遗漏、semantic source/summary digest 和 pruning 计数写入 checkpoint 后，Provider 才能被调用。
5. `ariadne.tool-result-spill.v1` manifest 只发布当前 Run/Workspace 可使用的 `workspace.effect_result_read` locator。读取端按 `runId + workspaceId + effectId` 重新校验 owner、终态和 payload reference，并用 UTF-8 byte cursor 返回有界 JSON；不暴露绝对路径，也不复制完整内容到 Public Projection。
6. Spill 的加密、retention、重启读取和删除都继承 Agent UoW 的 Effect payload 生命周期，不产生双写或独立清理器。
7. 每个精确 provider/model/settings binding 都必须实现 `countRequestTokens`。嵌入式本地模型直接调用它实际使用的 llama.cpp/Transformers chat-template tokenizer，并标记 `exact: true`；OpenAI 路由使用本地 cl100k/o200k BPE 对冻结请求做保守 wire 计数，其他远程协议明确标记为 route-local conservative，禁止伪称精确。source、primary 和 recovery 都按同一路由重新计数；最终 primary 超过 `contextWindowTokens - maxOutputTokens` 时只能提升一个实测可容纳的 recovery，否则 Provider I/O 前确定性失败。tokenizer profile、exact 标记、两个投影计数和 hard limit 进入受保护 `modelContext`。
8. OpenAI-compatible Provider 只有在静态 Provider descriptor 声明 `openai-stream-options` 时才请求 usage；Anthropic 使用其原生 stream usage event。Runtime 对非缓存 input、cache read、cache write 和 output 做有界、互斥计量；OpenAI 聚合 `prompt_tokens` 会扣除 `cached_tokens`，cache 大于聚合输入会 fail closed。usage 与实际发送 JSON body 的 SHA-256、provider/model/settings revision、request-header digest 和当次 metered price 一起提交到 succeeded Attempt。
9. 下一 Turn 只复用相同 provider/model/settings 与 request-header 的最近 anchor。非精确计量采用 `metered + max(0, providerContextInput - anchoredMetered)`；精确本地 tokenizer 不叠加旧 usage correction。Provider usage 只会提高非精确路由的容量压力，不会把估算下调为更乐观的数；header 不匹配时完全忽略。
10. Runtime 在 `started` 后崩溃时沿用既有 uncertain/recovery 规则，不盲重放 Provider 请求。
11. 历史 Tool exchange 不是 JSON 文本。Engine 在 checkpoint 前从受保护 Effect payload 恢复与 committed `inputDigest` 完全匹配的原始输入，生成 Provider-neutral `tool_call`/`tool_result` blocks；OpenAI-compatible、Anthropic 与嵌入式本地模型只做各自原生序列化。缺失或不匹配的输入在 Provider I/O 前确定性失败。

## 容量与压缩策略

- Main 设置为每个精确 Provider/model/settings revision 提供 `contextWindowTokens` 与 `maxOutputTokens`；Runtime 不使用全局窗口猜测。
- 输出预算先保留；输入达到窗口的 80% 时触发 pressure compaction。
- 最近因果组按窗口约 16% 保留。Tool Directive 与对应 Tool result 始终作为一个组保留或压缩，禁止拆对。
- 被压缩的前缀形成 `ariadne.semantic-context-compaction.v1`：按原因果顺序区分 `user_intent`、`assistant_outcome`、`image_reference` 和 `tool_exchange`，优先保留最早用户意图与最近事实，并在容量内提取有界首尾语义。Tool 项保留名称、输入/结果 digest、有界 synopsis、状态、effectId 和同 owner 的结果读取 locator；完整输入与结果仍只存在于受保护权威。
- 语义投影保存完整 source digest、选中 items 的 summary digest、源/选中/省略计数与字符数；相同输入与预算逐字节确定，输入或选中输出漂移都会改变证据。摘要预算从 primary 到 overflow recovery 单调减小，只有请求内容确实不同才允许第二次 Provider 调用。
- 当最新 Tool result 本身无法装入窗口时，在原 `tool_result` block 内产生 `ariadne.tool-result-spill.v1` output manifest；Assistant Tool-call 和 user Tool-result 的请求本地 identity 保持配对。manifest 保留 Effect identity、状态、完整 JSON 的 byte length/digest 和有界样本；只有拥有持久 result payload 的 `succeeded`/`failed` Effect 才携带 `workspace.effect_result_read` locator，`cancelled` 明确标记 `retrievable: false`。当前用户 objective 不能被这种替换，过大时 fail closed。
- Provider 只有返回已规范化的 context-overflow 证据时，Runtime 才使用 checkpoint 前已准备的更小投影重试一次；第二次仍溢出则以 `agent_model_context_exhausted` 确定性失败。

## 明确未完成

- 尚未接入 Memory/Embedding/RAG；这些能力不能因为 Context lifecycle 已接通而标记完成。
- 远程专有 chat-template 无法仅靠公开 BPE 得到 billing-grade 精确值，因此仍明确使用逐 binding 的本地保守 tokenizer；Provider overflow recovery 仍是这一误差的有界兜底，不是无限重试。
- 当前语义压缩是确定性的因果抽取，不是额外 LLM 生成的抽象摘要。若未来引入模型摘要，必须成为有独立 Attempt/取消/usage/崩溃恢复身份的持久工作，禁止塞进 `prepare` 形成未记录 Provider 调用。
- 真实本地 llama.cpp 模型的长上下文跨进程重启验收已完成；真实远程 Provider 因本机未配置任何 Provider credential 尚未执行。`accept:model-restart:remote` 缺模型选择、credential 或连通性时非零退出，禁止静默 skip。

## 验收证据

- Admission 测试证明旧 user/assistant 历史按 objective 边界进入受保护输入。
- Engine 测试使用超过单次 Provider 1,024-message 限制的历史，证明压缩后保留最新 objective，并记录 context lifecycle 摘要；独立 compactor 测试证明早期用户意图、assistant 结果、Tool 输入/结果证据与 Unicode 边界在预算内确定性保留，完整 Tool 输出不会复制进摘要。
- SQLite reopen 测试证明 semantic source/summary digest 与计数随 `inference_started` checkpoint 精确恢复；旧测试中靠“空 manifest”制造第二请求的伪 recovery 已删除，overflow 用例现在必须证明 recovery 请求实际更小。
- Spill 测试证明 manifest 指向既有受保护 Effect payload，读取严格校验 Run/Workspace owner，并能用 UTF-8 byte cursor 无损拼回完整 JSON；Tool execution service 只在执行时注入 immutable catalog。
- Tool history 测试证明 committed input digest 与受保护 Effect payload 不匹配时 Provider I/O 为零；OpenAI、Anthropic 和嵌入式本地模型使用各自原生 Tool history，compaction 不拆散 typed call/result。
- Stream/Gateway 测试覆盖 OpenAI 与 Anthropic usage event、显式 usage capability、精确 request-envelope digest 和冲突值 fail closed；Agent Core 测试证明 anchor 随 succeeded Attempt/checkpoint 原子提交；Context 测试证明相同输入在 usage correction 后会从 full 切换为 compacted，错误 header 被拒绝。
- Gateway 测试证明精确容量绑定以及 context-overflow 响应的脱敏规范化。
- `npm run accept:model-restart:local --workspace @ariadne/runtime` 使用两个独立 Node 进程重新加载同一 Qwen 3.5 GGUF：llama.cpp tokenizer 对 6,819-token 源上下文计数，v3 产生 1,562-token compacted primary，第二进程恢复第一进程响应后完成真实推理。输出只保留模型/tokenizer 身份、计数和响应 digest，不保留正文。
- `npm run accept:model-restart:remote --workspace @ariadne/runtime` 是严格 live gate；2026-08-30 本机以 `cloud-openai` 验证缺 `OPENAI_API_KEY` 时明确失败，因此不能把远程实测标成通过。
- Pipeline/Agent Core 测试证明 `prepare` 位于 durable `inference_started` 之前，而 Provider I/O 位于其后；准备期间加入的 inbox 输入不会被旧 Run 快照覆盖，既有 Tool continuation、取消和恢复不变量继续通过。

设计参考 deepseek-harness 的 capability seam、pre-step compaction、精确 route capacity 和 bounded overflow retry，但保留 Ariadne 的 protected Turn input、Run checkpoint 和 fail-closed recovery 权威：

- [Compaction subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/compaction.md)
- [Basic compaction implementation](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/compaction/compaction-basic/src/index.ts)
- [Routed model context policy](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/.agents/notes/implemented/architecture/2026-07-20-routed-model-context-and-compaction-policy.md)
