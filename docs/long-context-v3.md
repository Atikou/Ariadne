# v3 长上下文生命周期

- 状态：已接入生产 v3 推理链
- 核对日期：2026-08-26
- 范围：Conversation 历史、同一 Run 的因果历史、Context pressure compaction、Tool result pruning、Provider overflow recovery

## 结论

长上下文不再经过旧 `AgentLoop` 或 `prepareChatRequestForModel`。旧实现按启发式价值静默挑选消息，既不属于 v3 权威链，也无法证明 Tool 调用与结果的因果配对，因此不能作为生产修复基础。

当前生产链为：

```text
Conversation immutable history through objective
  -> protected Agent Turn input
  -> AgentEngine.prepare (no Provider I/O)
  -> exact model capacity + deterministic context plan
  -> inference_started checkpoint with request digests
  -> exact Provider request
  -> one prepared overflow-recovery projection when explicitly rejected
```

## 权威与恢复边界

1. Conversation Store 按 Session version 顺序读取截至当前 objective 的不可变 user/assistant 历史；并发产生的后续消息不会混入旧 Handoff。
2. 完整累计历史仍保存在受保护 Turn input 中。Context compaction 只改变模型投影，不改写 Conversation、Run、Turn 或 Tool result 权威。
3. `AgentEngine.prepare` 只能读取 immutable Tool contract、渲染协议并生成上下文投影，禁止 Provider I/O。
4. 完整投影、压力压缩投影和更小的 overflow recovery 投影都由相同输入确定性派生。准备完成后会重新读取 Run 权威：若期间只有 inbox 发生并发变化，`inference_started` 在最新 inbox 版本上重基；其他漂移 fail closed。source/request digest、容量、估算 token、遗漏和 pruning 计数写入 checkpoint 后，Provider 才能被调用。
5. Runtime 在 `started` 后崩溃时沿用既有 uncertain/recovery 规则，不盲重放 Provider 请求。

## 容量与压缩策略

- Main 设置为每个精确 Provider/model/settings revision 提供 `contextWindowTokens` 与 `maxOutputTokens`；Runtime 不使用全局窗口猜测。
- 输出预算先保留；输入达到窗口的 80% 时触发 pressure compaction。
- 最近因果组按窗口约 16% 保留。Tool Directive 与对应 Tool result 始终作为一个组保留或压缩，禁止拆对。
- 被压缩的前缀形成 `ariadne.context-compaction.v1` manifest，保存总数、字符数、总体 digest、每条 source digest 和有界样本，不静默删除。
- 当最新 Tool result 本身无法装入窗口时，产生 `ariadne.tool-result-pruning.v1` 引用，保留角色、字符数、digest 和有界首尾片段；当前用户 objective 不能被这种 pruning 替换，过大时 fail closed。
- Provider 只有返回已规范化的 context-overflow 证据时，Runtime 才使用 checkpoint 前已准备的更小投影重试一次；第二次仍溢出则以 `agent_model_context_exhausted` 确定性失败。

## 明确未完成

- 尚无 spill 文件/对象存储，因此 pruning manifest 不能按引用取回完整大结果。
- 尚未接入 Memory/Embedding/RAG；这些能力不能因为 Context lifecycle 已接通而标记完成。
- 当前 token meter 是保守的 UTF-8 envelope 估算；精确 Provider tokenizer 尚未接入。Provider overflow recovery 是这一误差的有界兜底，不是无限重试。
- Live Provider 与真实本地模型的长上下文验收仍未完成；当前自动测试和 Electron gate 使用确定性 HTTPS Provider fixture。

## 验收证据

- Admission 测试证明旧 user/assistant 历史按 objective 边界进入受保护输入。
- Engine 测试使用超过单次 Provider 1,024-message 限制的历史，证明压缩后保留最新 objective，并记录 context lifecycle 摘要。
- Gateway 测试证明精确容量绑定以及 context-overflow 响应的脱敏规范化。
- Pipeline/Agent Core 测试证明 `prepare` 位于 durable `inference_started` 之前，而 Provider I/O 位于其后；准备期间加入的 inbox 输入不会被旧 Run 快照覆盖，既有 Tool continuation、取消和恢复不变量继续通过。

设计参考 deepseek-harness 的 capability seam、pre-step compaction、精确 route capacity 和 bounded overflow retry，但保留 Ariadne 的 protected Turn input、Run checkpoint 和 fail-closed recovery 权威：

- [Compaction subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/subsystems/compaction.md)
- [Basic compaction implementation](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/compaction/compaction-basic/src/index.ts)
- [Routed model context policy](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/.agents/notes/implemented/architecture/2026-07-20-routed-model-context-and-compaction-policy.md)
