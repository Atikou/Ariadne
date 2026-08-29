# SubAgent v3 生命周期与产品闭环

> 状态：已接入默认生产 Composition（2026-08-26）

## 产品边界

SubAgent 不是第二套 Agent Loop，也不是 `runtime/src/subagent` 中旧工作流的包装。模型返回严格的 `delegate_subagent` Directive 后，Agent Control 在一个 SQLite 事务中提交：

- 父 Run 的已完成推理结果与 `waiting_children` 状态；
- 不扩权的 Child Run binding；
- Child Budget grant、allocation 和 Delegation protected objective；
- 可由普通 v3 scheduler 执行的 Child Run 首个 Turn；
- 完整 Event、Outbox、Checkpoint 和恢复材料。

ordinary Child Run 随后复用主 Agent 的精确模型、Tool Catalog、权限、Effect、长上下文和 started-work recovery 链路。配置为 ACP 的 one-shot Child 则通过同一 Attempt/Checkpoint/UoW 权威启动独立沙箱进程，只向进程发送工作目录和委派目标，不传父对话、父工具或环境凭据。两类 Child 到达终态后都会写入 immutable child-terminal fact，父 Run 生成 `child_results` continuation Turn；下一次模型调用拿到受保护的 Child 结果并继续原任务。

```text
Parent inference
  -> delegate_subagent
  -> atomic Parent + Delegation + Budget + Child Run commit
  -> ordinary Child v3 inference/tool/recovery
     OR fresh-process ACP one-shot inference
  -> one_shot terminal OR continuable waiting_input
  -> optional active Turn interrupt -> uncertain evidence -> waiting_input
  -> direct-parent send -> ordinary inbox Turn -> explicit complete
  -> durable Child terminal observation
  -> protected child_results continuation
  -> Parent inference resumes
  -> terminal Conversation projection
```

## 权威与安全约束

- Raw child prompt/objective 只进入受保护 payload；公开 Run/Event/receipt 只保留 ID 和 digest。
- Child workspace、capabilities、Tool Catalog、model、policy、deadline 和 Budget 不得扩大 Parent 权限。
- Child 首轮不再由 Conversation execution-intent owner 处理，而由 dedicated delegated-inference owner 调度；重启后已开始但未落终态的 Provider 调用进入 uncertain recovery，绝不盲重放。
- Parent 只在 durable child-terminal fact 完整后恢复；Child 输出通过 protected terminal-content resolver 回灌。
- Public Projection 暴露 `parentRunId`、`delegationId`、`subagentMode` 和 `subagentProviderId`，Renderer 把 Child 及其真实执行 Provider 显示在 Parent 的 SubAgent 状态区，并避免把 Child 误选为 Chat 主 Run。
- `one_shot` Child 的 `respond` 仍是终态；`continuable` Child 的 `respond` 进入持久化 `waiting_input`。只有显式 `complete`、`fail`、取消或预算/期限终结才结束 Child 生命周期。
- `agent.subagent.send.v3` 只接受同会话的 direct parent、`waiting_children` Parent 和 `continuable` Child；普通 `agent.inbox.enqueue.v3` 不允许绕过这条父子权限边界。
- `agent.subagent.interrupt.v3` 只中断 work scheduler 当前持有的 Child inference。Abort 后仍按 Provider outcome unknown 写入 uncertain Attempt，再以精确 `interrupt_turn` recovery decision 回到 `waiting_input`；它不会把 Child 改成 `cancelled`，也不会重新排队已经被旧 Turn claim 的输入。
- 中断后的下一 Turn 使用 `interrupted_inference` cause 绑定原 Turn/Attempt/recovery decision，并在受保护模型输入中插入明确的系统中断事实。中断期间尚未 claim 的 inbox 输入保持原 FIFO 顺序，后续 direct-parent send 唤醒同一个 Child Run。
- `waiting_input`、interrupted-inference continuation 与 execution Provider 身份/隔离能力/配置摘要已进入 Agent Control schema v7 / ledger revision 55、active recovery scan 和 Public Projection，因此进程重启后仍能恢复同一个 Child Run 并回到同一执行 Provider。
- Runtime 仅在 Agent admission authority 启用时宣告 `agent.subagents`。
- Provider Catalog 不只冻结 `providerId`：`executionProfile.subagentProviders` 同时冻结支持模式、进程形态、父上下文/父工具继承能力和无凭据配置摘要。重启时当前配置摘要不一致会使 authority verifier fail closed，不会让旧 Child 静默改用另一条命令。
- ACP 配置通过 Settings schema v5 进入 Main → 私有 bootstrap → Runtime；命令必须是绝对路径。进程复用统一 `AgentProcessSandbox` lease，默认拒绝 `session/request_permission`。即使设置为 allow，`ask` Child 仍拒绝；只有 `trusted` 且冻结 capability、workspace access 与 network authority 覆盖相应 ToolKind 时才放行。结果只接受有界 assistant text，stderr、权限标题和原始协议错误不会回灌 Parent。stdin EOF 宽限后由统一进程树取消/回收证明 quiescence。

## 当前范围

当前闭环实现同进程 ordinary Child Run 的 `one_shot` 与 `continuable` 两种模式，以及 fresh-process ACP 的 `one_shot` 模式。ordinary 可续模式复用统一 inbox、同一 Child Run、冻结的 Tool Catalog、原预算/期限和普通 scheduler；ACP 由外部 Agent 自己拥有模型和工具，不继承这些 Parent 输入。状态面板提供 Child list/status、运行中“中断本轮”和 ordinary follow-up 入口。这与 deepseek-harness 的 ordinary child session、ACP fresh-process 和 durable ownership 思路一致，但保留 Ariadne 的单一 Agent Control/UoW 权威。

执行后端已经收口到冻结的 Provider seam：启动时 Catalog 校验唯一 ID、配置摘要、支持模式与隔离能力；每个 Run/Turn 固定同一 Catalog 快照，模型只看到该快照；Core 在提交 Directive 前选择 Provider，并把其 ID 写入 objective、Directive、Child binding 和 protected Turn authority。Work scheduler 按 durable Child 身份区分普通 Run follow-up 与 SubAgent follow-up，Router 在外部 I/O 前复核精确 Turn/Attempt/配置摘要所有权，并在返回后重新读取 UoW，拒绝没有对应持久 Attempt 的伪造回执。内置 `ariadne.in_process` 只是该 seam 的一个 Provider，不能被外部配置替换。

参考边界：

- [deepseek-harness Subagent subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/subagent.zh.md)
- [deepseek-harness SubAgent capability family](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/subagent/README.zh.md)
- [deepseek-harness capability seams](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/capability-seams.zh.md)
- [deepseek-harness ACP Provider](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/subagent/subagent-acp/README.zh.md)

尚未宣告完成：多 Child 批量 Directive、fork/Codex/Claude adapter、外部 continuable/reconnect、显式凭据转交、structured report，以及真实商业 Agent 和真实 Electron SubAgent 场景。ACP 有意不转发 Runtime ambient credential；当前只支持已经能通过自身安全存储完成认证的 ACP executable。`send/list/status/interrupt` 已进入公开产品链；`agent.run.cancel.v3` 仍保留终结整个 Run 的独立语义。旧 `runtime/src/subagent` 仍不是生产入口，应在其引用清零后独立删除，不得作为 fallback。

## 验证

自动化验收覆盖：

- 模型 Directive 到 Parent/Child 原子提交；
- ordinary Child Run 的生产模型执行；
- continuable Child 第一次 `respond` 后持久等待、公开 direct-parent send、同 Run 第二 Turn 与显式 `complete`；
- active follow-up/delegated inference Abort、uncertain evidence、`interrupt_turn` recovery、保留 inbox 和同 Child 恢复；
- schema v7 保留的 `waiting_input` SQL 约束、恢复索引和重启读取；
- durable terminal observation 与 Budget release；
- `child_results` protected continuation 和 Parent 最终响应；
- Delegation first-Turn work ownership 与重启 uncertain recovery；
- Public Projection 父子身份。
- Public Projection 模式/status 与 Renderer follow-up 控制。
- strict public interrupt protocol、direct-parent/one-shot policy 与 Renderer interrupt 控制。
- 启动时 Provider Catalog、模式选择、模型可见描述、durable Provider 路由、缺失 Provider fail-closed 与外部回执持久化复核。
- ACP 真实子进程 initialize/new-session/prompt、仅委派目标传输、默认 permission reject、allow 不得越过冻结 Child authority、配置摘要漂移拒绝和进程树有界回收。

运行完整门禁：

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run check:architecture
npm.cmd run audit:runtime-independence
npm.cmd run test:electron
```
