# ADR-0006：模型推理使用持久 Turn Attempt

- 状态：Accepted
- 日期：2026-07-31

## 当前实施状态（2026-08-26）

Schema v5 的 Turn/Attempt ledger、exact Provider adapter、execution-intent
scheduler、Effect scheduler、因果 continuation、follow-up inference 和
started-work recovery gate 已由默认生产 Composition 接通。SQLite 与受控
Provider fixture 的完整闭环测试通过；真实 Provider、真实 Electron Agent 和
进程强杀验收仍未完成。

## 背景

模型推理发生在数据库事务之外。如果 Runtime 在 Provider 已接收请求、但
`AgentDirective` 尚未提交时退出，仅凭 `run.begin` 或进程内 Promise 无法判断模型是否
已被调用。命令重放若直接再次调用 Engine，会产生重复费用、不同 Directive，以及无法
解释的 Run/Effect 分叉。

Tool Effect 的 intention/start/result 协议不能只保护工具；模型推理同样是一个必须显式
记录确定性的外部 I/O 边界。

## 决策

每次推理创建一个持久 `AgentTurnAttempt`，由 Agent Control Store 唯一拥有：

```text
intended -> started
  -> succeeded | failed | uncertain | cancelled
```

Attempt 必须绑定精确的 `runId`、Run/Checkpoint 版本、Objective 引用、Model/Policy/Tool
Catalog revision/digest、输入摘要和稳定 provider idempotency key。成功结果只保存经过
Schema、Tool Catalog 与 Policy 边界校验的 `AgentDirective` 及摘要，不保存 Provider 原始
响应、请求头、凭据或完整日志。

固定协议为：

1. `AgentRunCommandService` 原子提交 Turn Intention、Run/Checkpoint 与 Outbox。
2. Inference Dispatcher 原子提交 `started`。
3. Dispatcher 在事务外调用 `AgentEngine` Port。
4. 已知结果原子提交 Attempt Result、Directive、Run 转移、Effect Intention 与 Outbox。
5. Provider 抛错或进程在 `started` 后退出且无法证明结果时，Attempt 进入
   `uncertain`；命令、Transport 和启动恢复均不得盲目重放。

支持幂等键或结果查询的 Provider 可以使用同一 key 对账。无法对账时，重新推理必须由
显式 Recovery Decision 授权，并创建新的 Attempt 身份；旧 Attempt 保持不可变。

公共 v3 入口 `conversation.message.accept.v3` 只持久化 Conversation
Message/Handoff 并返回 accepted。Handoff 后台 admission 再提交 Run、Turn 与
execution intent；长时间模型调用由后台 Dispatcher 推进，结果通过权威
Projection 发布，不占用桌面 IPC 请求生命周期。

## 后果

- 同一逻辑 start 命令不会重复读取 Objective、Tool Catalog 或调用模型。
- Runtime 强杀后不会把“Provider 是否执行未知”误报为“尚未执行”。
- 模型重试成为可审计的领域决议，不再是 Transport/Fallback 的隐式行为。
- Agent Control Store 需要 Turn/Attempt 表、命令、事件、Checkpoint 与恢复查询；现有
  `AgentRunControlService.start()` 的同步 Engine 调用只属于待替换实现，不能成为公共生产
  入口。

## 验证

必须覆盖：

1. 同一 `commandId + digest` 并发和重放只产生一个 Attempt，Engine 最多调用一次。
2. 同一 `commandId` 不同 payload 在 Engine 前返回冲突且数据库零变化。
3. 在 intention 前后、started 后、Provider 返回后和 result/outbox 提交前后强杀进程。
4. 重开 `started` Attempt 时，非可对账 Provider 进入 `uncertain` 且 Engine 零调用。
5. 显式 retry 创建新 Attempt，并保留旧 Attempt 与因果关系。
6. 数据库、日志与公共事件不包含 Provider 原始响应、凭据或授权文本。
