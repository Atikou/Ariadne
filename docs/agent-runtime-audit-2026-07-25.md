# Ariadne Agent Runtime 全链路审计与修复报告

日期：2026-07-25

范围：Ariadne 自身 `runtime/src/agent`、Runtime 编排、策略、持久化、IPC/Public Protocol 与 Renderer。
边界：Ariadne Agent 已是独立实现，本报告不再以 AgentRelay 的源码或行为作为验收依据。

## 1. 结论

本轮不是单点弹窗修复，而是对一条分布式状态机做了边界重整：

`模型工具调用 → 工具准入 → 权限请求 → 暂停快照 → Run 等待态 → 用户批准 → 快照认领 → 原工具续跑 → 工具账本 → Provider 继续对话 → UI 完成/恢复`

共确认并修复 9 类问题：

1. 权限请求在 Run 仍为 `running` 时就能从公共接口看到，用户立即批准会被事务层拒绝。
2. 权限请求创建后缺少可靠的 Runtime 事件发布与 Renderer 补偿拉取，导致偶发无弹窗。
3. 暂停快照在恢复开始时被直接删除，恢复异常会永久丢失唯一续跑位置。
4. 已批准后的失败被重新伪装成“等待权限”，造成重复弹窗、错误文案和批准/Run 状态不一致。
5. Runtime 后台恢复异常曾被吞掉，Renderer 只能看到长期等待，无法知道需要恢复。
6. 批准后生成了新的工具调用 ID，可能破坏 OpenAI/DeepSeek 的 `assistant.tool_calls → tool_call_id` 协议配对。
7. 多工具结果之间插入 system 消息，以及历史孤立 tool 消息，可能触发远程 Provider 400。
8. 工具恢复没有完整使用持久化账本，存在重复执行副作用或无法恢复已开始幂等工具的风险。
9. Windows 8.3 路径、规范长路径和精确授权作用域混用，导致批准后仍被判越界，或把文件自身错误当成执行根目录 `"."`。

修复后的受控真实 DeepSeek 验收结果：

- Provider：DeepSeek（项目现有配置，未输出 API Key）
- 模型：项目配置的 `deepseek-v4-flash`
- 权限请求：已生成，且批准前 Run 为 `waiting_confirmation`
- 越权执行检查：批准前目标文件不存在
- 批准后续跑：同一 Run 到达 `completed`
- 自动读回：目标内容与期望完全一致
- 恢复态：0 次
- 遗留权限请求：0 个

## 2. 模块审计

| 模块 | 当前判定 | 通过理由 | 已发现并修复的问题 |
|---|---|---|---|
| 模型选择与 Provider 绑定 | 通过 | Agent Proposal 的手动模型绑定会传到该 Run 的 `makeChatForRun`；真实 DeepSeek 已完成权限续跑 | 续跑必须保持原 Run 的 Provider 绑定，禁止恢复时重新走不确定路由 |
| Agent 提示与动作协议 | 通过 | 提示明确要求需要工具时直接发起工具调用；写入、Shell、网络、高风险动作不能混入批处理 | 原提示允许副作用工具批量调用，无法给每个动作建立独立权限和检查点 |
| 模型动作准入 | 通过 | 所有工具名和参数先经 Registry 校验；批量动作仅接受可并发、无副作用、工作区内只读观察 | 原批处理只看 `parallel_safe`，没有阻止副作用或可能中途触发跨工作区权限的调用 |
| 权限风险识别 | 通过 | 文件、命令和网络目标按权限类型分别投影 | 原代码把任意 `target` 同时投影成 network 权限，写文件弹窗会多出无关网络项 |
| 路径策略 | 通过 | 授权边界与工具执行根目录分离；Windows 短/长路径先统一身份再求相对路径 | 短路径相对长路径产生虚假 `../../..`；精确文件授权又被误当作执行根，写入和读回都落到 `"."` |
| 权限请求事务 | 通过 | 权限决定、Grant、Run 校验和拒绝取消共用同一 SQLite 事务；公共列表只显示已经进入等待态的请求 | 请求记录先于 Run 等待态可见，造成“弹窗已出现但批准报状态错误”的竞态 |
| 暂停快照 | 通过 | 使用 `paused → resuming` 原子认领；成功后条件消费，失败释放；新暂停快照不会被旧恢复删除 | 原 `take()` 在恢复开始即删除快照，进程退出或 Provider 错误后无法续跑 |
| 权限续跑 | 通过 | 新快照保存原 provider tool call ID；批准后直接执行被阻塞工具，再继续模型循环 | 原实现可能生成新 ID，Provider 收到无法与原 assistant tool call 配对的 tool result |
| Run 生命周期 | 通过 | 初次权限暂停进入 `waiting_confirmation`；已批准后的错误进入 `recovery_required`，不再伪装成未批准 | 原实现把批准后的恢复失败重新写回等待权限，状态含义错误并诱发重复弹窗 |
| 工具检查点与幂等 | 通过 | `intended/started/succeeded/failed` 持久化；成功/失败可重放；支持恢复的 started 工具可重新武装 | 原续跑总是重新建立执行，不能可靠区分已完成、可重试和副作用不确定 |
| 多工具 Provider 协议 | 通过 | 同一 assistant 批次的所有 tool 结果连续写入，之后才追加 workflow/system follow-up | 原实现逐个工具追加 system 消息，破坏 OpenAI-compatible 连续 tool result 约束 |
| 历史会话上下文 | 通过 | 历史模型 tool action 不再直接当可信协议消息；账本支持的结果作为中性数据发送 | 孤立、交错或跨 Run 的 tool 消息可能使远程 Provider 拒绝整次请求 |
| 启动恢复 | 通过 | 启动时恢复遗留的 `resuming` 认领；若快照与 pending 权限/计划都完整，重建真实等待态 | 原逻辑会把“请求已落库但 Run 状态迁移前进程退出”统一当成普通中断恢复 |
| RuntimeFacade/IPC | 通过 | 权限/计划等待态发布专用事件；缺失时写错误 Trace；后台恢复异常会归一化为恢复态 | 原事件发布依赖单一路径，且后台 Promise 异常被吞掉 |
| Renderer RuntimeStore | 通过 | 收到等待态 Run 但没有对应决定时，只发起一次补偿列表请求并校验一致性 | 原 Renderer 完全依赖事件，事件窗口丢失后不会主动补齐弹窗 |
| ApprovalCenter | 通过 | 只显示真正 `pending` 的 Proposal、Permission、Plan | 原 UI 把“已批准但恢复失败”重新塞进批准中心，造成看起来一直弹权限窗口 |
| AgentStatusPanel | 通过 | `recovery_required` 显示为独立恢复处理，可恢复时续跑；有不确定副作用时只能取消/标记失败 | 原 UI 没有恢复态的明确归属，用户只能看到失败或继续等待 |
| Ariadne Runtime 独立性 | 通过 | 独立性审计未发现外部 file 依赖、外部根脚本路径或 Runtime HTTP Server/Public 目录 | 本轮不再维护或验证 AgentRelay 等价性 |

## 3. 三个直接导致本次现场故障的根因

### 3.1 权限请求与 Run 状态不是同时对用户可见

内部正确顺序是：

1. 保存暂停快照；
2. 创建权限请求；
3. Agent Loop 返回 `awaiting_permission`；
4. Run 迁移到 `waiting_confirmation`；
5. 向 Renderer 发布权限请求。

原公共 `permissions.list` 在第 2 步后就能返回请求。此时用户若立即点击批准，`PermissionRequestDecisionService` 会发现 Run 仍是 `running`，整笔事务回滚并报告状态不一致。

修复后，非临时 Run 的权限请求只有在 Run 已经进入 `waiting_confirmation` 后才对公共接口可见。批准事务的前置条件与 UI 可见条件现在一致。

### 3.2 Windows 路径身份与执行根目录混为一谈

真实 DeepSeek 首次复现中，模型请求写入的是 Windows 8.3 短路径：

`%USERPROFILE%\...\workspace\agent-e2e-proof.txt`

策略匹配到的作用域已被系统规范成：

`%USERPROFILE%\...\workspace\agent-e2e-proof.txt`

原代码直接对两种拼写求 `path.relative`，得到虚假的多层 `../../..`，所以用户批准后仍被工具沙箱拒绝。进一步修正短/长路径后，又暴露出精确一次性授权比 primary workspace 更具体，系统把“文件自身”当成工具执行根，导致工具输入变成 `"."`。

现在分别处理：

- 路径身份：使用 real/canonical target 参与相对路径计算；
- 授权边界：仍可精确到单个文件；
- 执行根：工作区内始终使用 primary workspace；工作区外精确文件使用其父目录；
- 工具输入：相对执行根生成，不会虚假越界，也不会把文件变成 `"."`。

### 3.3 批准和恢复被错误建模成同一个 UI 状态

批准是用户决策；恢复是系统在已持久化决策基础上的执行。二者不能都显示在 ApprovalCenter。

原设计在恢复失败后保留 `waiting_confirmation`，并把 `approved` 权限再次投影成“恢复弹窗”。因此用户看到的是重复批准界面，而不是明确的恢复错误。

现在：

- `pending` 才属于 ApprovalCenter；
- `approved` 后开始续跑；
- 续跑失败进入 `recovery_required`；
- 可安全重试由 AgentStatusPanel 提供“从检查点继续”；
- 存在不确定非幂等副作用时禁止自动续跑，只允许用户结束该 Run。

## 4. 状态机约束

### 权限暂停

`running → waiting_confirmation → running → completed`

异常分支：

- 用户拒绝：`waiting_confirmation → cancelled`
- 批准后安全失败：`running → recovery_required(recoverable)`
- 批准后存在不确定非幂等副作用：`running → recovery_required(decision_required)`
- 恢复中再次产生新的权限请求：旧快照不删除新快照，新请求进入新的 `waiting_confirmation`

### 快照所有权

- `save`：写入 `paused`
- `claim`：原子迁移到 `resuming`
- `releaseClaim`：恢复失败时回到 `paused`
- `completeClaim`：仅删除仍是当前认领的旧快照
- 进程重启：遗留 `resuming` 统一恢复为 `paused`

这个设计避免了两个危险结果：

1. 同一快照并发续跑两次；
2. 旧恢复完成时误删恢复途中生成的新暂停点。

## 5. 验证证据

### 自动回归

- Protocol：18/18
- Runtime：202/202
- App：166/166
- 合计：386/386
- TypeScript/Build：通过
- `git diff --check`：通过

新增的关键回归覆盖：

- 暂停快照单认领、失败释放、重启恢复和不删除替代快照；
- provider tool call ID 在批准前后保持一致；
- 多 tool result 连续性；
- 历史孤立/交错 tool protocol 安全降级；
- 恢复失败进入 `recovery_required`；
- started 可恢复工具重新武装，已完成工具结果重放；
- 启动时从快照 + pending decision 重建等待态；
- RuntimeFacade 发布权限事件、补偿缺失决定、阻止并发恢复；
- Renderer 收到等待态但缺权限事件时主动补拉；
- Windows 短/长路径、精确一次性授权与外部精确文件执行根。

### Electron

`npm run test:electron` 通过，产物位于 `artifacts/electron-runtime-smoke`。验证覆盖构建后的 Electron Main、preload、Renderer、Runtime 子进程启动与 Runtime IPC 冒烟链路。

### Runtime 独立性

`npm run audit:runtime-independence`：

- production files：691
- Runtime server 目录：不存在
- Runtime public 目录：不存在
- inbound HTTP indicators：0
- external file dependencies：0
- external root script paths：0

### 真实 DeepSeek

受控脚本只进行一次写文件 Agent 任务并自动批准一次：

- 观察到权限请求；
- 批准前未执行；
- 批准后完成原工具调用；
- 自动读回成功；
- Run 完成；
- 无恢复事件；
- 无遗留权限请求。

## 6. 仍需保留的限制和后续验收

以下不是本轮已确认的代码故障，但不应宣称已被当前证据完全覆盖：

1. 真实 DeepSeek 只验证了单文件写入和读回，没有实际计费测试 Shell、网络、删除和跨工作区持久授权。
2. Electron 冒烟验证了进程和 IPC；真实 DeepSeek 脚本通过 RuntimeFacade 验证权限链路，没有用鼠标点击 Renderer 弹窗。发布前仍建议做一次人工 UI 点击验收。
3. 计划交接使用自动测试覆盖，尚未用真实 DeepSeek 跑完整 `plan → approve → implement`。
4. 非幂等 Shell 在进程被强杀后的正确行为是要求用户处置，而不是自动重试；这属于安全约束，不应改成“总能续跑”。
5. 多工具批处理现在故意限制为工作区内纯只读。若未来希望支持并发网络或写入，需要先设计批次级权限事务、逐项检查点和 Provider 部分结果恢复协议，不能只放宽白名单。

## 7. 发布前人工验收清单

1. 在 Chat 选择 DeepSeek 和“请求批准”。
2. 发出一个需要写文件的明确任务。
3. 确认只出现一个权限弹窗，且权限项只包含实际文件操作。
4. 弹窗出现前确认目标文件未创建。
5. 点击“仅本次批准”，确认弹窗立即消失且 Agent 自动继续，不要求再次发送消息。
6. 确认工具输出出现写入和读回，最终回复为完成。
7. 关闭并重启应用，验证没有旧批准弹窗或虚假等待态。
8. 在批准后、工具执行前强制结束 Runtime，重启后应显示“可从检查点继续”，而不是再次请求同一权限。
9. 对非幂等 Shell 执行中强制结束 Runtime，重启后应要求取消/标记失败，不能自动重复执行。
