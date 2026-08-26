# Ariadne 文档索引

> 核对日期：2026-08-26

文档中的“有源码”“有 schema”“有单元测试”和“已进入产品路径”是四种不同状态。当前事实按以下优先级判断：

1. 生产入口、Composition 和 Public command/projection；
2. 当前可重复的自动、真实进程和真实窗口证据；
3. 当前实现文档；
4. ADR 中的长期不变量；
5. 带固定日期的审计快照。

当文档与生产代码冲突时，以代码和重新执行的门禁为准，并在同一变更中修正文档。

## 当前文档

| 文档 | 用途 |
|---|---|
| [源码快照复现契约](source-reproducibility.md) | 固定工具链、lockfile、干净检出和 CI 复现边界 |
| [当前实现架构](architecture.md) | 生产进程、命令、持久化、能力接线和未验收边界 |
| [目标架构](architecture-v3.md) | 长期依赖方向、Owner、事务和安全不变量 |
| [项目结构](project-structure.md) | 当前目录、依赖方向和数据目录 |
| [验证说明](verification.md) | 当前门禁、Electron smoke 的准确边界和发布验收 |
| [Agent inbox 与运行中交互](agent-inbox.md) | 同一 Run 的 next-turn/next-step、持久领取、投影和恢复语义 |
| [v3 长上下文生命周期](long-context-v3.md) | Conversation 历史、精确容量、压力压缩、Tool result pruning 与溢出恢复边界 |
| [SubAgent v3 产品闭环](subagent-v3.md) | one-shot ordinary Child 的 Directive、原子委派、调度、结果回灌、投影与剩余边界 |
| [机器可读验收矩阵](verification-matrix.json) | 发布脚本消费的逐模块证据状态 |
| [Renderer UI 架构](ui-architecture.md) | Feature Store、Public Projection 和桌面能力边界 |
| [Provider 与模型配置](Provider协议与模型推理配置.md) | 稳定 Provider/Protocol/Profile 规则 |
| [Runtime 独立性审计](Runtime独立性审计.md) | 仓库与入站网络边界 |
| [Companion 能力请求协议](agent-proposal-protocol.md) | Companion 意图解释到 v3 Decision 的边界 |

## 审计快照

[Ariadne 与 deepseek-harness 对比审计](deepseek-harness-comparison-audit-2026-08-26.md) 固定了 Ariadne 当前工作树和 deepseek-harness 指定 commit，用于记录差距、优先级和验收条件。它是日期化审计，不替代当前实现架构。

## 架构决策

决策记录见 [ADR 索引](adr/README.md)。ADR 保存设计原因和不变量；其中标为 historical snapshot 的实施状态不应被当作当前生产状态。

## 维护规则

- 不再维护按日期累积的 TODO、成熟度清单和修复报告；未完成项统一进入当前审计或验收矩阵。
- 不在 README 固定测试总数；日期化验证文档可保存当次证据。
- 不把已删除文件、legacy command 或旧 Facade 写成当前入口。
- 第三方 Provider 的易变模型表不作为仓库权威；只记录稳定抽象和官方核对要求。
- 被新架构完整替代的草案直接删除，不保留“Superseded 但仍像入口文档”的副本。
