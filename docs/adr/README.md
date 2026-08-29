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
| [0015](0015-pure-v3-text-effect-result-protocol.md) | Superseded | 历史 v3 文本 Effect Result 协议；由 ADR-0021/0022 取代 |
| [0016](0016-agent-run-work-scheduler-and-recovery.md) | Accepted | Run Work Scheduler 与恢复 |
| [0017](0017-exact-follow-up-inference-ownership.md) | Accepted | Follow-up Inference 所有权 |
| [0018](0018-bootstrap-frozen-capability-manifest.md) | Accepted | Bootstrap 冻结的 Capability Manifest |
| [0019](0019-progressive-skills-typed-hooks-observability.md) | Accepted | Progressive Skills、typed Hooks 与隔离可观测性 |
| [0020](0020-v3-inference-stream-authority.md) | Accepted | v3 inference stream 权威与重放 |
| [0021](0021-exact-agent-provider-content-blocks.md) | Accepted | exact Provider 响应内容块、原生 Tool 与 usage |
| [0022](0022-exact-agent-provider-request-content-blocks.md) | Accepted | exact Provider 请求内容块与原生 Tool 历史 |
| [0023](0023-durable-conversation-image-attachments.md) | Accepted | Conversation 图片附件所有权与 exact Provider 请求 |
| [0024](0024-durable-conversation-session-lifecycle.md) | Accepted | Conversation 标题与归档生命周期权威 |
| [0025](0025-versioned-atomic-workspace-files.md) | Accepted | 版本化观察与原子 Workspace 文件写入 |
| [0026](0026-build-verified-tool-implementation-artifacts.md) | Accepted | 构建验证的第一方 Tool 实现工件 |
| [0027](0027-durable-retirement-of-unavailable-tool-catalog-runs.md) | Accepted | 不可用历史 Tool Catalog Run 的持久退休 |
| [0028](0028-manifest-owned-agent-instruction-assembly.md) | Accepted | Manifest 管理的 Agent 指令装配 |
| [0029](0029-cancellable-scoped-skill-catalog-snapshots.md) | Accepted | 可取消、按 Workspace 分层的 Skill catalog 快照 |
| [0030](0030-pinned-skill-package-resources-and-invocation-policy.md) | Accepted | 固定 Skill 包资源与 model/user invocation policy |
| [0031](0031-manifest-owned-trusted-hook-provider-lifecycle.md) | Accepted | Manifest 管理的可信 Hook Provider 生命周期 |
| [0032](0032-durable-agent-user-question-control-plane.md) | Accepted | Agent 主动提问的持久控制面 |
| [0033](0033-contract-pinned-tool-semantics-and-public-presentation.md) | Accepted | Tool 模型语义与公开静态展示的合同固定 |

ADR 的日期不表示内容过期；它表示决策发生时间。若实现状态已变化，正文必须把旧状态标为历史快照，并链接当前实现文档。
