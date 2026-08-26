# ADR-0007：Runtime 不确定命令只允许凭领域 Receipt 协调

- 状态：Accepted
- 日期：2026-07-31

## 背景

Runtime Command Store 在业务执行前提交 `executing`。进程可能在领域事务提交后、Ingress 写入最终响应前退出；重启时该记录只能恢复为 `uncertain`。如果把 `uncertain` 当成普通重试，会重复创建 Run、调用模型或派发工具；如果永久拒绝重试，又会让已经成功提交的命令无法返回确定结果。

Ingress journal 不拥有 Run、Conversation、Effect 等业务事实，不能自行猜测命令是否提交。Trace、日志、Renderer 状态和进程内 Promise 都不是恢复证据。

## 决策

`RuntimeCommandJournal.reconcileUncertain()` 只接受命令归属 Control 提供的两种持久化证明：

1. `committed`：所有相关领域 Owner 的稳定 receipt 证明该命令已提交。Control 从 receipt 重建允许持久化的有界公共结果，journal 原子地将 `uncertain` 改为 `completed` 并返回 replay。
2. `not_committed`：该命令可能写入的每一个领域 Owner 都证明没有提交任何事实。journal 才能原子地把同一 `commandId + digest` 重新打开为 `executing`。

协调规则：

- 命令 kind 必须由 Composition 的静态路由表唯一归属，不能先尝试新 Control 再 fallback 到旧 Facade。
- receipt 必须验证稳定内部 command ID、外部 command digest、Run/Session 身份和结果版本。
- 任一 Owner 无法给出证明、存在部分 Saga 提交、digest 不同或结果不可安全重建时，命令保持 `uncertain`。
- `executing` 记录不能被第二个调用者接管。
- Runtime Command Store 只保留明确 allowlist 的小型公共响应；原始消息、错误详情、授权内容、Provider/Tool 输入和凭据不得进入该库。
- 该 API 不对旧 Facade 命令开放；旧路径没有完整 receipt 协议，因此不能借此获得重试资格。

## 后果

- Agent admission 已提交但 Runtime 响应丢失时，可以从 Agent receipt 确定恢复 `companion.chat.accepted`。
- Agent admission 未提交时，可以安全重开同一逻辑命令，而不更换 `commandId`。
- Conversation Handoff Saga 接入后，`not_committed` 必须同时核对 Conversation 与 Agent receipt；只检查 Agent Store 不足以证明安全。
- journal 的 `uncertain` tombstone 仍是默认终态，协调是受领域证据约束的窄路径。

## 验证

必须覆盖：

1. 进程遗留的 `executing` 在重启后变为 `uncertain`，无证明时保持不可执行。
2. `not_committed` 证明只允许一个调用者重开；第二个并发调用看到执行中。
3. `committed` receipt 重建的公共结果可重复 replay，且不同 digest 冲突。
4. 不在 allowlist 的结果协调失败，journal 不保存正文或错误详情。
5. Saga 任一 Owner 的 receipt 缺失时不得重开。
6. 强杀点覆盖领域提交前后及 Runtime journal 完成前后，模型与工具调用次数不增加。
