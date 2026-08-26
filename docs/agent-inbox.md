# Agent inbox 与运行中交互

> 当前状态：已进入 v3 生产链路；核对日期：2026-08-26。

Agent inbox 是同一 `AgentRun` 上唯一的运行中输入权威。它不取消当前 Run，也不创建“后继 Run”模拟续写。输入先作为可编辑的持久队列项提交；只有新的 Turn 在同一 command transaction 中登记成功时，输入才从 `queued` 变为 `claimed` 并进入精确模型历史。

## 语义

| 交付方式 | UI | 领取边界 | 单次领取规则 |
|---|---|---|---|
| `next_turn` | Enter | `respond` / `complete` 后的响应边界 | 最早的一条 |
| `next_step` | Ctrl/⌘+Enter | Tool result 后的下一模型 Step；若当前响应先结束，则在该响应边界领取 | 所有已排队项 |

当一个响应边界同时存在两类输入时，系统领取全部 `next_step` 和最早一条 `next_turn`，同时保持被选输入在原始队列中的顺序。其余 `next_turn` 留待后续响应边界。

排队项支持：

- `enqueue`：以 `inputId/messageId`、交付方式、内容摘要和 Run 版本持久化；
- `replace`：只允许修改 `queued` 项，并比较 `expectedInputVersion`；
- `remove`：只允许移除 `queued` 项，并比较 `expectedInputVersion`；
- `claim`：只能由 `run.register_turn` 原子执行，领取后不可再编辑或移除。

Run 已终止、模型 Turn 预算已耗尽或 deadline 已到时，拒绝新输入。只读模型请求准备和 Provider inference 运行期间都允许 inbox 增删改；准备后的 `inference_started` 与结果提交都会重新读取最新 Run，只在 inbox 是唯一并发变更时重基，Turn、Attempt、Effect、Binding 或执行状态漂移时仍 fail closed。

如果输入在 deadline 前已被接受，但当前 Provider 响应到达时 deadline 或模型 Turn 上限已经耗尽，调度器不会尝试非法 continuation，也不会进入不健康状态；它在该响应边界以稳定 `run.fail` command 和 `inbox_inputs_terminalized` checkpoint 确定性收敛，保留未领取输入作为审计事实。

## 权威链路

```text
Renderer composer
  -> agent.inbox.enqueue/replace/remove.v3
  -> Electron Main -> Node IPC -> Runtime public command router
  -> AgentRun command + receipt + outbox (single SQLite transaction)
  -> AgentRunWorkClassifier
       effect boundary: all queued next_step
       response boundary: all queued next_step + first queued next_turn
  -> continuation planner
  -> run.register_turn + inbox.inputs_claimed + protected Turn input
     (single SQLite transaction)
  -> existing follow-up inference owner
  -> Public Projection
  -> projection.changed wake hint -> Renderer replays durable Projection tail
  -> Renderer queue + in-Run transcript
```

Inbox-only mutations复用现有推理 checkpoint，不伪造新的 engine checkpoint；任何 Turn、Effect 或状态变化仍必须提交精确的新 checkpoint。旧持久化 Run 没有 `inbox` 字段时只规范化为 `inbox: []`，因此升级不会使当前快照不可读。

## 投影与 UI

`PublicRunProjectionV3` 发布两个不同集合：

- `inbox`：排队和已领取的输入状态，用于队列编辑、移除和审计；
- `interactionMessages`：只包含已由后续 Turn 因果确认的中间 assistant 响应和已领取 user 输入。

最终 assistant message 仍由 Conversation authority 在 Run 终止时提交。Renderer 按持久时间合并 Conversation message 与 `interactionMessages`，并按 `messageId` 去重；它不从临时状态猜测最终文本。

Agent、Conversation 与 Model publisher 共用同一个 Projection commit/wake 边界：必须先完成权威 Projection commit，再发送按 `sourceId + feature` 稳定派生的非权威 wake hint。Renderer 收到 hint 后只重放 durable Projection tail；wake 不携带业务真相，也不允许用轮询或本地猜测替代。这样 terminal message 会及时清除 pending overlay，后续运行中输入不会被过期 UI 状态阻塞。

## 重启与幂等

- 每个公开 mutation 使用 command receipt 重放；同一 command ID 不重复修改队列。
- continuation 的 command、Turn、Attempt 和 Provider idempotency key 由 source Attempt、directive digest、input ID 和内容摘要稳定派生。
- `inbox.inputs_claimed` 与新 Turn 在一个 Run commit 内产生，不存在“已出队但 Turn 未建立”的崩溃窗口。
- Provider 正在执行时加入的输入不会使 Provider 结果因普通 Run version conflict 丢失；结果在最新 inbox 版本上提交。
- protected Turn input 保存完整累计模型历史，重启后的 follow-up 不重新领取输入，也不重复调用已越过边界的 Provider。

## 参考与差异

实现借鉴 deepseek-harness 的 unified inbox、`next_turn` / `next_step` 和持久 claim 思路：

- [Agent lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/agent-lifecycle.md)
- [Inbox implementation](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent/src/inbox.ts)
- [Steering E2E](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/apps/web/tests/steering.e2e.ts)

Ariadne 没有复制进程内 Agent handle。这里的权威仍是 `AgentRun`、protected Turn input、command receipt、outbox 和单一 Public Projection；Renderer 不直连 Agent，也不拥有队列状态。

## 当前不属于本能力的范围

- token/reasoning streaming 及 chunk replay；
- 不唤醒模型的独立 context injection；
- spill 与可按引用恢复的完整大 Tool result；Context compaction 和有界 Tool-result pruning 已进入 v3；
- Child Run/外部 Agent 的跨 Run inbox。

这些能力不得因为 inbox 已接通而标记为完成。
