# ADR-0002：AgentRun 使用单一状态所有者

- 状态：Accepted
- 日期：2026-07-31

## 背景

决策时，同一个 Run 同时出现在聚合仓库、运行状态、暂停状态、权限、计划、活动记录和进程内 Registry 中。失败恢复需要推断哪一份状态更新得更晚，Renderer 也会从消息合成缺失的 Run 信息。

## 决策

每个 Run 只有一个 `AgentRun` 聚合和一个命令写入口。一次领域提交在同一事务中写入：

- 聚合版本与状态；
- Plan/Decision/Effect/Checkpoint；
- Command Journal；
- Domain Outbox。

外部副作用在事务外执行，但必须先提交 Effect Intention。结果未知时进入显式 `recovering/uncertain`，不能自动重复非幂等操作。

Conversation、工具目录、Trace 和 Renderer Projection 不拥有 Run 状态。
Conversation 继续独占消息正文；Run 只保存结构化 `objectiveRef`，不得在聚合、
事件或 Outbox 中复制原始目标文本。跨数据库交接使用持久化 Saga。

## 后果

- 恢复逻辑只读取聚合、Checkpoint 和 Effect Ledger。
- Trace、Activity 和 Renderer 可以被删除后重建。
- 迁移期间按 `executionVersion` 分流，新旧执行器不能同时写同一个 Run。
- 旧的重复 Store 在对应垂直切片迁移后立即停止写入并删除。
