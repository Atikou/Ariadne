# ADR-0032: Durable Agent user-question control plane

- Status: Accepted
- Date: 2026-08-29

## Context

运行中 inbox 已允许用户向同一 `AgentRun` 追加 follow-up/steer，但 Agent 主动提问仍不能由 transient Renderer callback、Provider Promise、普通外部 Tool 或旧 SubAgent 路由枚举拥有。这些边界无法给出 durable waiting state、精确回答回执、命令重放和重启恢复。

公共投影还禁止 `prompt`、原始模型输入和其他私有字段，因此受保护问题不能直接复制到 Renderer DTO。

## Decision

- `ask_user` 是第一类 Agent Directive。问题正文和可选的 2–8 个选项进入受保护 `ariadne.user-question` Directive payload；committed Directive 只保存稳定 decision ID、question ref 和 digest。
- 成功 Attempt 将 Run 转为 `waiting/user_question`，Decision 绑定 Run checkpoint、question ref/digest 和 requested time。
- Public Projection 从精确 succeeded Attempt 读取并校验受保护 payload，脱敏后以公开字段 `question` 和 options 发布；它只暴露 opaque `answer` action token，不发布受保护 `prompt`。
- Renderer 的选择和自由文本都通过 `agent.decision.resolve.v3` 提交。Runtime 将 command ID、Run、Decision 和回答正文稳定绑定为 answer input/message ID 与 digest。
- `decision.resolved`、answer receipt 和带 `source.kind=user_question_answer` 的 `next_step` inbox 输入在一个 Agent Control transaction 中提交。同一命令精确重放；token、question、checkpoint 或回答正文漂移 fail closed。
- scheduler 复用既有 inbox continuation。只有后续 Turn 原子 claim 回答后，受保护历史才出现 assistant question → user answer；Public Projection transcript 使用同一因果边界。
- Agent Control schema v7 / ledger revision 55 仅扩大受保护 Directive payload kind。v6→v7 通过显式、有 owner lease 和 durable backup 的离线迁移完成；Runtime startup 不自动迁移。

## Consequences

- Agent 与用户的双向运行中交互共用一个 Run、Decision authority、command journal、checkpoint、inbox 和 Public Projection，不新增第二套会话或回调状态。
- 公共防泄漏规则保持不变；公开 DTO 使用 `question`，受保护 payload 才使用 `prompt`。
- 当前自动证据覆盖 Core、协议、SQLite authority/replay、public projection、scheduler、interaction transcript、migration 和 Renderer command。进程外确定性 HTTPS Provider 驱动的真实 Electron 窗口还覆盖了问题卡片、选项回答、`waiting/user_question` 强杀恢复、answer inbox claim 与同 Run terminal continuation。真实商业 Provider、自由文本窗口场景和取消等待问题的产品语义仍是验收缺口。
