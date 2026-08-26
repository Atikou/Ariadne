# Ariadne ADR 索引

ADR 记录长期决策和历史原因，不承担当前能力清单。当前生产接线以 [当前实现架构](../architecture.md) 和 [验收矩阵](../verification-matrix.json) 为准。

| ADR | 状态 | 主题 |
|---|---|---|
| [0001](0001-ariadne-agent-core-ownership.md) | Accepted | 独立 Agent Core 所有权 |
| [0002](0002-single-agent-run-owner.md) | Accepted | Agent Run 单一状态所有者 |
| [0003](0003-dependency-direction-and-baseline.md) | Accepted | 依赖方向与架构门禁 |
| [0004](0004-agent-v2-recovery-ledger.md) | Superseded | Agent v2 recovery ledger；仅保留历史不变量 |
| [0005](0005-isolated-control-stores-and-recovery-encryption.md) | Accepted | 控制库隔离与恢复载荷加密 |
| [0006](0006-durable-inference-attempts.md) | Accepted | 持久 Inference Attempt |
| [0007](0007-runtime-command-reconciliation.md) | Accepted | 不确定命令的 receipt 协调 |
| [0008](0008-conversation-authority-and-agent-handoff.md) | Accepted | Conversation Authority 与 Handoff |
| [0009](0009-plan-budget-and-child-runs.md) | Accepted | Plan、Budget 与 Child Run |
| [0010](0010-pinned-tool-admission-and-exact-execution.md) | Accepted | Pinned Tool 准入与执行 |
| [0011](0011-single-public-projection-stream.md) | Accepted | 单一 Public Projection Stream |
| [0012](0012-sanitized-decision-presentation.md) | Accepted | 脱敏 Decision Presentation |
| [0013](0013-protected-turn-input-execution-snapshot.md) | Accepted | 受保护 Turn 输入快照 |
| [0014](0014-causal-effect-result-continuation.md) | Accepted | Effect Result 因果续接 |
| [0015](0015-pure-v3-text-effect-result-protocol.md) | Accepted | v3 文本 Effect Result 协议 |
| [0016](0016-agent-run-work-scheduler-and-recovery.md) | Accepted | Run Work Scheduler 与恢复 |
| [0017](0017-exact-follow-up-inference-ownership.md) | Accepted | Follow-up Inference 所有权 |
| [0018](0018-bootstrap-frozen-capability-manifest.md) | Accepted | Bootstrap 冻结的 Capability Manifest |

ADR 的日期不表示内容过期；它表示决策发生时间。若实现状态已变化，正文必须把旧状态标为历史快照，并链接当前实现文档。
