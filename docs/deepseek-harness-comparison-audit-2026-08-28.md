# Ariadne 与 deepseek-harness 当前差距审计

> 状态：当前有效审计，替代本文旧版内容
> 初版日期：2026-08-28；最近复核：2026-08-29
> Ariadne：`main`，已提交基线 `195562e8cb105fe9a20d58ff5327e2f340dafff3`，并包含本轮尚未提交的工作树
> deepseek-harness：审阅时 `master` HEAD [`cd5ef8148158c3a752a658978873241fdf8e2bbc`](https://github.com/deepseek-ai/deepseek-harness/tree/cd5ef8148158c3a752a658978873241fdf8e2bbc)

## 1. 结论

Ariadne 已经不是“只有领域模型、没有产品链路”的半成品。它目前的强项是桌面进程隔离、SQLite 控制权威、精确 Run/Turn/Attempt 身份、权限与副作用恢复，以及可重放 Public Projection。对比 deepseek-harness 后，先前列出的以下问题已经完成或形成了可信的生产基线：

- 工作区会话存储可复现且惰性创建；
- 巨型入口已拆出路由、能力 Provider、Tool family、outbox 与 projection 边界，并有热点门禁；
- 同一 Run 的 durable inbox、follow-up/steer、replace/remove 和恢复已进入 v3；
- 运行中输入已有稳定 commandId 回执，Renderer 可展示 `pending/accepted/failed/reconcile` 并用同一命令对账；未结算 enqueue 先进入 Main-only 系统加密 sender outbox，可跨 Renderer reload 和完整桌面进程重启恢复为 `reconcile`，但不会自动重放；Public Projection 中的唯一 inbox input 是强于传输结果的结算证据；
- Renderer 对活动 Run 低频追随权威 Projection commit 流，wake 只负责降低延迟；丢失 wake 不再使 Decision 卡片或 Run 终态长期停留；
- v3 token/reasoning 已按精确 Attempt 持久化、重放、重启收敛并进入 Renderer；
- exact Provider 已通过单一有界 assembler 输出 `text/reasoning/tool_call` 内容块；OpenAI/Anthropic 原生 Tool-call 可严格组装并映射到冻结 Tool identity，finish、内容摘要、脱敏 Provider response identity 与互斥 cache usage 随 succeeded Attempt 原子提交；
- Provider Resilience 冻结 policy 已进入 exact v3 transport；并发、速率、429/5xx/timeout、有界 Retry-After、首语义输出前重试、熔断和脱敏 Telemetry 共用一个协调器；
- Tool Catalog、公开能力、Provider service 依赖和关机顺序已由冻结 Manifest 统一；默认 Factory 不再按字符串定位 Skills、Telemetry 或 live-work；
- Workspace、Skill catalog 与 agent/plan/chat 模式策略已由 Manifest-owned instruction contributors 全有或全无地装配；最终 Turn input 固定 contributor/version/order/scope/revision 证据，Factory/admission reader 不再各自拼接 prompt；
- Skill catalog 已从 bootstrap 同步目录冻结改为静态 Provider + 每 Workspace 可取消 snapshot；完整观察更新 last-good，瞬时不完整复用 last-good，权威缺失清除它；package revision 覆盖正文与资源，`skill.load`/`skill.resource.read` 只接受 admission pin，model/user policy 已进入 invocation-neutral snapshot；
- one-shot/continuable ordinary Child SubAgent 已完成创建、持久等待、direct-parent send、运行中非终态 interrupt、执行、结果回灌与父子投影；
- fresh-process ACP one-shot/resume、Codex app-server 与 Claude Code one-shot 已进入 Settings、私有 bootstrap、冻结 Provider Catalog、统一沙箱进程租约与原有 Attempt/Checkpoint/UoW 提交链；
- Skills 按需加载、typed Hooks、Manifest-owned 静态可信 Hook Provider 生命周期、脱敏 Diagnostics 与 Telemetry Provider 已接入；
- Agent 已拥有 owner-scoped 持久 pipe process 与沙箱内 PTY，而不再只有一次性命令；
- Process、Agent PTY 与 Electron PTY 已共用 `@ariadne/live-work` 的 owner、状态机、UTF-8 游标、截断、互斥输入、resize/signal、取消/join 和完成通知语义；Agent 侧由 `job_*` 提供通用控制面，终态会先写入带系统来源的 durable inbox 再唤醒消费者。
- Settings assistant profile 的默认值已由 Desktop/Public contract 安全导出，Renderer 不再直连内部 protocol settings；所有 node-test fixture 已同步 revision 6，根级 typecheck 与架构门禁恢复通过。
- `workspace.read_file/write_file` v2 已由唯一文件 service 管理 opaque version、陈旧拒绝与原子发布，不再允许批准后的盲覆盖；文件 Tool family 已独立装配，未把复杂度重新塞回 Workspace 入口。
- `workspace.search_text/glob/apply_text_edits` 已复用同一稳定读取与版本权威：搜索有明确扫描/字节/结果上限并返回文件 version，Unicode 行列编辑只接受观察过的 opaque version，在同一目标锁内拒绝陈旧、越界和重叠修改。
- Tool 合同 V2 已把中立 model description/guidance 和可公开的静态 presentation kind/label 纳入同一 complete pin；Provider request 不再从名称/版本临时合成描述，Public Projection 只发布 kind/label，Renderer 不再按 toolName 猜测标题，受保护 input/result 不会越界。
- 第一方 Tool pin 已从 name/version 合成标记替换为实际构建 JS 模块闭包；Runtime、独立 CLI 和打包门禁都会复核文件长度、SHA-256 与闭包 digest，纯实现漂移不再依赖开发者自觉升版。
- 历史 Catalog pin 已有明确升级语义：不静默重绑新代码，而是在 fresh Provider/Tool I/O 前先收敛 started work，再按 Child-before-Parent 持久退休旧 Run；canonical Child terminal observer 会释放委派预算并推进 Parent，单条旧 pin 不再拖垮无关 Run。
- 超大 Tool result 不再只剩摘要：compaction manifest 会指向既有受保护 Effect payload，Agent 可通过 owner-scoped、UTF-8 cursor 的只读 Tool 按需取回；没有引入第二套 spill 存储或清理权威。
- digest-only 历史 omission manifest 已替换为确定性因果语义投影：早期用户意图、assistant 结果、图片引用和 Tool 输入/结果证据在有界预算内保留，source/summary digest 随推理 checkpoint 持久化；摘要是普通 user 历史而非 system 提权，也没有未记录的摘要 Provider 调用。
- v3 图片附件已形成产品闭环：Renderer 有界选择与预览、Conversation 内容寻址引用与消息摘要、Public Projection 安全元数据、精确 Message owner 复核、视觉模型准入，以及 OpenAI/Anthropic 原生图片请求共用同一条生产链；本地文本模型不会静默丢图。

当前仍不能把 Ariadne 描述为完整 Agent Harness。最关键的剩余差距不是再增加一批零散 Tool，而是把“长期存在、可继续、可恢复、可组合”的能力统一成稳定服务边界。

## 2. 审计边界与证据

deepseek-harness 当前仍明确处于 developer preview，并允许破坏性变更。因此它只作为能力分层和产品闭环参照，不是 Ariadne 的安全或发布成熟度基准。主要参照边界：

- [Core 与统一 Agent handle/inbox](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/core.md)
- [LLM streaming 与 durable chunk](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/llm-streaming.md)
- [Content-addressed attachment seam](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/attachment.md)
- [Session lifecycle、fork 与 durable event log](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/session.md)
- [Session query、lineage 与 bounded event reads](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/session-query.md)
- [Durable session title](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/session-title.md)
- [Credential provider 与 authorization flow](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/credentials.md)
- [Same-session goal](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/goal.md)、[durable todo](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/todo.md) 与 [workflow engine](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/workflow.md)
- [Capability seams](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/capability-seams.md)
- [Persistent PTY sessions](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/terminal.md)
- [Background jobs](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/jobs.md)
- [SubAgent providers 与 continuable children](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/subagent.md)
- [Compaction](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/compaction.md)
- [Token meter](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/token-meter.md)
- [Skills provider registry](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/skills.md)
- [Scoped system-prompt assembly](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/system-prompt.md)
- [Tool runtime 与结构化展示](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/tools.md)
- [Filesystem freshness 与 atomic mutation](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/filesystem.md)
- [Session-local durable schedule](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/schedule.md)
- [LSP capability seam](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/lsp.md)
- [File 与 cross-session reference](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/session-reference.md)
- [Provider-neutral user question](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/user-questions.md)

本轮对 Ariadne 当前工作树的验证结果：

| 门禁 | 结果 | 当前证据 |
| --- | --- | --- |
| `corepack.cmd npm run typecheck` | PASS | Protocol、Agent Core、Live Work、Runtime 与 App 均通过；assistant-profile node-test fixture 已同步，Renderer 从 Desktop/Public contract 获取默认 profile，不再直连内部 settings 模块 |
| `corepack.cmd npm test` | **FAIL** | Protocol 48、Agent Core 106、Live Work 5、Runtime 834 均通过；App 全量为 296/297，唯一失败是 `global-radius-contract` 拒绝并发 UI 改动中的 10 处 `4px/6px` 非 token 圆角 |
| `corepack.cmd npm run check:architecture` | PASS | 936 个 TS/TSX 文件、3,718 条内部边、2,061 个 type import；0 SCC、0 cyclic edge、0 violation。Hotspot 同时通过：Browser Tool family 472/500、Workspace Tool 入口 203/330、Factory 820/850、公共命令路由 588/750、Agent UoW 5,005/5,200、Conversation UoW 2,092/2,100 |
| `corepack.cmd npm run audit:runtime-independence` | PASS | 953 个生产文件；无 Runtime 入站 HTTP 和仓库外依赖 |
| `corepack.cmd npm run verify:tool-artifacts` | PASS | Catalog revision 18 的 11 个生产 Tool 模块根通过逐文件与整体 digest 复核；36 个 Tool 的 V2 contract 与实现共同冻结为 `5df0cf…` |
| `npm.cmd run verify:release-contract` | PASS | 安装器、迁移、模型资产和验收矩阵静态契约通过 |
| `npm.cmd run test:electron` | PASS | 完整命令通过前置构建与 App typecheck；真实 Electron 窗口完成会话重命名、归档、设置页恢复与重新选择，以及运行中流、2 个持久分块、图片、inbox delivery receipt/权威对账、ask-user 卡片回答/同 Run 续跑、Tool、Decision、取消和五处强杀恢复。Provider trace 为 18 请求、16 响应、2 取消；随后同一隔离 userData 依次执行 Renderer reload 与全新桌面进程启动，恢复相同 commandId/inputId 的 `reconcile` 回执，确认输入未进入 Projection、未自动重放，再显式结算并清空加密 outbox |
| `corepack.cmd npm run verify:source-snapshot` | **FAIL** | 已使用仓库固定 npm 11.13.0；唯一失败是 Git 工作树不干净 |

注意：本轮审计包含未提交工作树，所以这些结果还不构成可检出的发布基线。Tool 合同相关的 Runtime 全量测试、typecheck、Hotspot、架构与 Runtime 独立性门禁通过；仓库全量测试只剩审阅期间并发写入的 UI `4px/6px` 非 token 圆角失败。该样式改动不属于本轮 Tool contract/presentation 边界，未被覆盖或擅自改写。发布或交接前仍必须按问题拆分提交，在干净检出上重跑 `verify:reproducible`。

Electron ask-user smoke 首次暴露了默认生产工厂漏接 protected Directive payload reader，修正后又暴露 Core Turn 守卫没有把 `ask_user` 视为可 continuation 的 succeeded boundary；两处修正并增加 Core 回归后，真实窗口完整通过。随后新增的提交后丢响应边界继续暴露并修正了三个权威缺陷：inbox-only version advance 与 Decision checkpoint 的兼容、跨 inbox mutation 的 Decision Projection 持续性，以及 Renderer 将可丢 wake 错当成唯一活性来源。现在 Renderer 用稳定 commandId 保留原命令，权威 inbox input 可直接结算 accepted，不确定时才要求同 ID 对账；活动 Run 还会低频追随同一 Projection commit 流。未结算 enqueue 会在调用 Runtime 前写入 Main-only 加密 outbox；页面或桌面重启后只恢复为同 ID `reconcile`，不自动发出业务命令。五次 Runtime 强杀、Renderer reload、完整桌面重启与 18/16/2 Provider trace 已通过真实窗口门禁。失败时仍只导出脱敏阶段/计数/截图，默认不复制含受保护数据的控制数据库；诊断时可显式保留隔离目录，但它不属于发布 artifact。

## 3. 当前主要差距

| 优先级 | 差距 | 当前表现 | 完成标准 |
| --- | --- | --- | --- |
| P1 | 长上下文逐 binding 计量与本地真实验收已完成，远程 live 仍受 credential 阻塞 | 完整 Tool result 复用受保护 Effect payload；确定性因果摘要有 source/summary digest、角色与 Tool locator；本地 llama.cpp/Transformers 使用实际 chat-template tokenizer，远程路由明确区分 BPE/conservative；source/primary/recovery 均重新计数并硬准入；真实本地模型已跨两个进程恢复历史、压缩并推理 | 配置 credential 后执行严格远程跨进程 gate；若未来增加模型摘要，须用独立 durable Attempt |
| P1 | SubAgent 批量、ACP reconnect 与产品 Provider 已接入 | 单个/2–16 项批量 Directive 以一次事务提交 Parent、预算、Delegation 和全部 Child；ordinary one-shot/continuable、ACP 加密 resume/load、Codex app-server 与 Claude Code one-shot 共用 Agent Control 权威和沙箱。配置漂移、缺失 Provider 和伪造回执均 fail closed | structured report；真实 Electron 场景；Claude 商业登录态 live gate；显式 credential seam |
| P1 | v3 LLM 请求/响应与图片合同已同构，私有 replay state 和附件回收仍缺 | exact 请求使用 `text/image/tool_call/tool_result`；图片先进入 Conversation 内容寻址存储，再按精确 Message owner 复核并临时序列化为 OpenAI/Anthropic 原生块；历史 Tool 输入按 committed digest 从受保护 Effect payload 恢复；输出使用 `text/reasoning/tool_call`，finish、脱敏 replay evidence 与互斥 cache usage 随精确 Attempt 提交 | 可用的 adapter-private replay state；引用感知附件 GC；真实远程 Provider 图片验收；若提供缩略图字节，必须保持 owner-scoped |
| 已关闭 | Conversation fork、lineage、Session query 与稳定引用 | schema v4 用不可变 lineage 绑定 source Session version 和已结算 Message digest；fork 不复制祖先消息，历史按 lineage 递归读取。Session query 直接扫描权威表，不建立第二权威；稳定引用跨 Runtime 重启按 `session/message/version/digest` 精确解析。Public Projection、RuntimeStore、侧栏正文检索和消息“从此分叉”已接入 | 未来大历史量再引入可丢弃索引，但索引必须保留 observed authority version；多窗口压力与分页 event read 可继续扩充，不再属于基础能力缺失 |
| 已关闭 | Tool 结果呈现、LSP 与文件生命周期 | `workspace.search_text/glob/apply_text_edits/move_file/delete_file/code_intelligence` 共用 workspace containment 与 opaque version；move 不覆盖目标，delete 只删除精确观察版本。bundled TypeScript LSP 作为沙箱内持久进程提供 definition/reference/hover/document symbols。终态只公开 `detailAvailable`，正文按 Run/Workspace/effect 从受保护结果分页读取，Renderer 有 read/search/diff/terminal 专用卡 | 真实 Electron 搜索→编辑→详情可继续作为深度验收；其他语言 LSP 和语义索引按真实需求增加，不再属于本轮基础缺口 |
| 已关闭 | 人类 Skill consumer | Renderer 命令面板通过公共命令读取与模型完全相同的 invocation-neutral snapshot，只过滤 `userInvocable`，按精确 revision 加载正文/资源且不启动 Agent | 外部 Hook 包签名/发现仍属有意不开放的独立扩展需求，不能从 Skill 目录自动加载代码 |
| P2 | Agent 主动提问的 durable 链与等待恢复已接入，产品交互仍不完整 | `ask_user` 是第一类 Directive；问题/选项进入受保护 payload，Run 持久等待精确 Decision，Public Projection 只发布脱敏 `question`，回答 action 与 `user_question_answer` next-step inbox receipt 原子提交，scheduler/历史重建/Renderer 已接通；真实窗口既覆盖正常选项回答，也覆盖 `waiting/user_question` 时强杀 Runtime、恢复同一 Decision 与同 Run 续跑 | 真实窗口自由文本；真实商业 Provider 生成问题；取消等待问题的产品语义 |
| P2 | 缺独立 context injection | follow-up/steer 会进入下一 step，但没有“不唤醒模型、只改变后续上下文”的 durable receipt | injection 有独立命令、版本、claim/receipt、重启语义和 UI 状态；不伪装成用户消息 |
| 已关闭 | Scheduler v3 迁移 | Schedule 是 productivity SQLite 的版本化记录；稳定 occurrence/command/message ID 向原 Session 投递普通 v3 Turn并跨重启重试。生产 composition 不再构造旧 JSONL Scheduler，离线只读 decoder 仅供 `scheduler:migrate:v3` 显式导入 | 事件型旧 trigger 因不能安全映射而显式跳过；迁移源保留用于人工审计 |
| 已关闭 | 统一 Credential authority | Main Credential Authority 提供 `resolve/describe/update`；模型 bootstrap 只带 `model:<provider>` ref，每次推理解析一次并支持无重启轮换；MCP OAuth 经同一 authority 代理；ACP 仅描述为 external provider 且不继承 secret | 未来显式 ACP credential forwarding 仍必须新增独立 capability grant |
| 已关闭 | same-session Goal、durable Todo 与受限 Workflow | productivity authority 持有 Goal CAS/phase/round cap、完整 Todo snapshot revision 和严格 command replay；Workflow 限定既有 Todo 子任务，具有并发、转换预算、deadline、取消后 quiescence 与结构化结果，不执行任意宿主代码；Renderer 提供完整操作入口 | 若未来让 Workflow 直接调度 SubAgent Provider，必须复用父 Run capability/budget，而不能在此 authority 新建 Agent loop |
| 已关闭 | 事务 owner 热点第一阶段 | SQLite 串行化、事务、deadline 和 process lease 已从两个 UoW 抽为共享 owner；执行装配从 Factory 拆出。实测约为 Agent UoW 4961、Conversation UoW 2000、Factory 820 行，门禁收紧为 5000/2025/830 | row mapper/projector/compiler 的后续拆分仍可继续，但本轮不再处于旧上限边缘 |
| P2 | 旧实现仍增加认知负担 | `runtime/src/agent`、`runtime/src/subagent`、旧 model/context/scheduler 中仍有非 v3 实现 | 逐项证明无生产引用后删除；文档只描述唯一生产路径；架构门禁禁止重新引用 |
| P2 | 产品矩阵仍缺真实 Provider/安装包证据 | 确定性 Electron fixture 很强，但不是 Live Provider、本地模型、真实 Browser/MCP/SubAgent 或签名安装包 | 分层 gate：确定性必跑、Live Provider 可选、发布签名/干净机安装 fail-closed |

## 4. 差距详解

### 4.1 统一 live-work 服务，而不是再加一套后台 Tool

当前工作树已建立纯 TypeScript `@ariadne/live-work` 内核。它统一负责 service-minted identity、精确 owner tuple、并发上限、`running/stopping/completed/killed/failed/interrupted` 状态、UTF-8 安全 byte cursor、bounded retention、exclusive input、wait、first-wins settlement、完成提交后通知，以及 owner/service 关闭时 cancel + bounded join。Runtime process 和 Electron Main PTY 只是 producer，不再各自持有第二套状态表或输出缓冲。

Agent Tool 契约也已拆清：`workspace.process_start` 与 `workspace.terminal_start` 只创建 producer；`workspace.job_list/output/write/resize/signal/wait/kill` 是唯一 live-work 控制面。旧 `process_write/list/read/stop` 已从 catalog revision 11 删除；revision 12 增加结果读取，revision 13 固化版本化原子文件 read/write v2，revision 14 把实际构建工件纳入 pin，revision 15 增加固定 Skill package 资源读取，revision 16 增加 bounded search/glob 和版本化 text edits，revision 17 固定模型语义与公开静态展示元数据，当前 revision 18 增加受保护详情读取、LSP 与版本化 move/delete。Agent PTY 不是 Runtime 直接启动的高权限 native handle：`node-pty` worker 由原 `AgentProcessSandbox` lease 启动，因此仍受同一受限令牌、文件/网络策略和 Windows Job 约束。Main → Preload → Renderer 的 terminal output/exit 事件直接携带同一 `LiveWorkSnapshot` 和 cursor chunk。

`AgentLiveWorkService.onDone()` 现在绑定到 `AgentLiveWorkCompletionInboxBridge`：终态被编码为 `source.kind=live_work` 的系统输入，先由 Agent UoW 提交，再唤醒 work scheduler 和 projection；投递成功后才把 registry notification 标为 reported，避免 `job_list` 重复提醒。关机由独立 completion lifecycle 执行 close/join → sink drain → unbind，之后才允许 Store freeze。系统通知在模型上下文和公开交互记录中保持 `system` 角色，不能被用户编辑/删除。

因此“三套生命周期”“Agent 只能一次性 pipe 调用”和“完成后无法自动继续”的根因已被替换。Windows Sandbox runner 的协议现在正式包含 `interrupt/terminate/kill`；Runner smoke 不只验证帧，还真实终止一个长运行 PowerShell Job。Main Terminal 使用 Main-only 原子 JSON journal，只保存 session 元数据，不保存命令/输出；前一 Main 的 `running` 在新进程初始化时收敛为 `interrupted/main_process_lost`。真实 Electron 强杀/重启场景验证了恢复提示、禁止自动重放、显式 restart 和 `restartOf` lineage。

deepseek-harness 值得参考的是 backend/service/consumer 分离、精确 owner、exclusive send、bounded scrollback，以及 Job registry 先提交终态再发完成通知；Ariadne 没有引入 Cordis，也没有把不可恢复的 OS handle 伪装成可跨重启恢复。

验收条件：

- Main Terminal 与 Agent Tool 使用同一协议词汇和状态机；
- 一个 owner 同时只能有有界数量的 live work，关闭 owner 会 await quiescence；
- `read` 使用稳定 consuming cursor，截断有显式证据；
- 完成事件先持久提交为系统 inbox，再唤醒 scheduler/projection，且关机先排空通知再冻结 Store；
- `signal` 只作用于 owner 校验通过且声明 signal capability 的 Job；native runner 的 signal frame 与真实终止效果均有 smoke 证据；
- Runtime 强杀后的 Agent process/terminal 由 durable system inbox/Public Projection 显示 interrupted；Main PTY 强杀则由 Main journal/真实窗口显示 `main_process_lost`，二者都不伪装为 OS handle 可恢复；
- `BackgroundTaskManager/background_shell_start` 与 `background_completed` 已删除，后台触发不再拥有第二套进程表或幽灵事件契约。

### 4.2 Capability Manifest service dependency resolver 已完成

本轮已把 Provider 顺序与 service 依赖分开：`dependsOn` 只表示 Provider 顺序，`consumes`/`provides` 表示实际 service 图。compiler 在启动每个 Provider 前构造只含已声明、已启动依赖的 `RuntimeCapabilityServiceScope`；缺失 owner、环、required consumer 绑定 optional owner、自消费、未声明读取、必需输出缺失和未声明输出都会在业务 Store 打开前 fail closed。

Instruction assembly、Hook service、live-work 与可选 Telemetry 现在由终端 `agent.control.runtime-services` Provider 消费并组装成冻结的 `AgentControlRuntimeServices`。Skill catalog 只由 instruction contributor 和 Skill Tool owner 消费；bootstrap 根只解析一个类型化 bundle，`DefaultAgentControlRuntimeFactory` 不再持有 Manifest，也不知道扩展 service id。

实现同时把 414 行 compiler 拆成 definition graph、service resolver 和 164 行 orchestration；175 行生产 Provider 入口拆为 38 行聚合器与独立第一方/终端 Provider，架构门禁没有抬高阈值。这里借鉴 deepseek-harness 的 Provider/Consumer 服务图，但继续保持静态、可审计、无任意代码热加载的边界。Skills 的 scoped lifecycle 与 Hooks 的 bind/close lifecycle 均已进入 Manifest；外部动态 discovery 不是当前生产回退路径。

### 4.3 长上下文需要“可恢复信息”，不只是“可控丢弃”

当前 v3 已经保住了重要安全不变量：完整 Conversation/Turn input 不被 compaction 改写，Tool call/result 不拆对，Provider 只有明确 context overflow 时才使用预先准备的更小投影重试一次。超大 result 现在生成 `ariadne.tool-result-spill.v1` manifest：其中的 locator 调用 `workspace.effect_result_read`，读取既有受保护 Effect payload，并按当前 Run/Workspace/effect owner、终态和 payload reference fail closed。返回使用 UTF-8 byte cursor，可无损拼回完整 JSON；绝对路径和完整结果都不会进入 Public Projection。

这里没有另建 spill 文件：Agent UoW 已经是完整 Effect result 的加密持久权威，也是唯一 retention/cleanup owner。这样避免 result 与 spill 的双写、漂移和独立删除失败。该实现已拆成独立 Tool family，Workspace Tool 文件从 331 行回落到 258 行，架构门禁仍为 0 环、0 规则违规。

Provider token authority 也已进入同一权威链。OpenAI-compatible 的 usage 请求由静态 Provider descriptor 显式声明，Anthropic 解析原生 usage event；非缓存 input、cache read、cache write 与 output 均做有界、互斥计量，实际发送 request body digest、provider/model/settings、request-header digest 和当次 heuristic price 会随 succeeded Attempt 原子提交。下一 Turn 只选择同 route/header 的最近 anchor，并用 `heuristic + max(0, providerContextInput - anchoredHeuristic)` 参与容量判断，其中 `providerContextInput = input + cacheRead + cacheWrite`；因此 usage 只能提高压力、不能乐观下调。OpenAI 聚合 `prompt_tokens` 会先扣除 cache hit，异常的 cache 大于总输入会 fail closed。错误 header fail closed，缺 usage 时回到保守估算。

digest-only omission manifest 已被替换。当前 `ariadne.semantic-context-compaction.v1` 以纯函数读取被压缩的结构化消息，按原因果顺序生成普通 `user` 历史检查点：区分 user intent、assistant outcome、image reference 与 Tool exchange；Tool 项保留输入/结果 digest、有界 synopsis、状态、effectId 和原 payload locator。完整 source digest、选中输出 digest、源/选中/省略计数与字符数进入 `inference_started` modelContext，并已验证 SQLite reopen。相同输入与预算逐字节相同，内容漂移改变 digest；primary/recovery 预算单调缩小，旧测试中靠空 manifest 制造的伪 recovery 已删除。

这里没有照搬隐藏的摘要模型调用。`AgentEngine.prepare` 仍禁止 Provider inference；route tokenizer 只做本地、无生成的确定性计数。嵌入式模型复用实际 llama.cpp/Transformers tokenizer；OpenAI 路由使用模型族对应的本地 BPE 但因 wire template 仍标为 conservative，其他专有协议也不伪称精确。source 规划后，primary/recovery 再由同一路由计数并对硬输入上限准入。真实本地 Qwen 3.5 已在两个独立 Node 进程中完成 6,819-token 源上下文、压缩和第二次推理；远程 live gate 因本机无 Provider credential 明确失败，仍未验收。未来若需要模型生成的抽象摘要，必须先建立独立持久工作边界，而不是在 prepare 内补调用。

真实 Provider 尚未验收是否稳定返回声明格式的 usage，因此这一项只能称为生产接线完成，不能称为 Live Provider 验收完成。

### 4.4 v3 LLM 请求/响应内容块与图片附件已同构，私有 replay state 尚未完成

当前 exact Provider adapter 已完成响应侧边界：OpenAI-compatible 与 Anthropic SSE 都先解码为 Provider-neutral delta，再由唯一的 `ExactAgentInferenceContentAssembler` 有界组装 `text`、`reasoning` 和 `tool_call`。原生调用的 Provider id 会哈希为稳定私有 identity，参数只能组装为完整 JSON object；未知 Tool 名、id/name 冲突、重复 identity、截断/歧义 JSON、混合 Tool/text finish 或不匹配的 finish reason 均 fail closed。Tool schema 由冻结 Catalog 投影到 Provider request，模型不能通过 Provider 名称绕过 immutable Tool identity、scope、Policy、Effect Ledger 或恢复链。

成功响应会把规范化 finish reason、request/body digest、content-block digest/type sequence、adapter 类型和可选 Provider response id digest 与 succeeded Attempt 原子提交；Provider 原始 request id、Tool 参数和 reasoning 不进入 Public Projection。OpenAI/Anthropic cache 维度也按互斥计数写入同一 usage anchor。公共运行中 stream 仍有意只发布安全的 reasoning 和严格解析后的 `respond.content`，不是第二份执行权威。

请求侧也已完成同构。Engine 先验证 source Turn/Attempt/Directive/Effect 的完整因果链，再从受保护 Effect payload 读取 raw input；Run、Effect 或 committed `inputDigest` 任一不匹配都会在 Provider I/O 前确定性失败。内部 Tool-call id 会转换为稳定的 request-safe hash，Tool identity、capability 与 scope 必须匹配冻结 Catalog。OpenAI-compatible 序列化为 Assistant `tool_calls` + `tool` messages，Anthropic 序列化为 `tool_use` + `tool_result` blocks，嵌入式本地模型复用同一结构化 Chat boundary。长上下文 pruning 直接替换 typed Tool-result 的 output 为 spill manifest，不再解析或生成 `ariadne.agent-effect-results.v3` 文本。

因此原审计中的“原生 Tool-call 只计数并拒绝”“finish/replay/cache usage 未持久化”“历史 Tool exchange 仍用 Ariadne 文本协议”均已过时并删除。图片附件也已进入同一块边界：Runtime 会完整解码并验证 PNG/JPEG/WebP，按尺寸、像素、单件/整批字节上限规范化，再以 SHA-256 对象原子提交；Conversation Message 只持有有序不可变引用，消息 digest 覆盖正文与引用。Public Projection 只发布脱敏文件名、媒体类型、字节数与尺寸，不含路径、URL 或 base64。

Run admission 把每张图片绑定到精确 `session/workspace/message/version`。Provider 请求前会重新读取该不可变 Message、验证它确实拥有完整 ref，再复核对象 digest 与解码元数据；复制 ref 到另一条 Message 不会获得读取权。OpenAI-compatible 使用临时 data URL，Anthropic 使用原生 base64 image source；base64 不进入 Conversation、Turn、Projection 或持久 request envelope。本地文本模型明确返回 binding unavailable。自动路由和显式选模都要求 bootstrap 声明视觉能力，图片和 caption 作为一个 long-context group 估算。

尚未完成的是：

- 当前 replay envelope 是脱敏一致性证据，不是可交回原 adapter 的完整 private replay state；切换或复用 Provider 时仍只能依赖中立正文；
- 内容寻址对象允许 Message CAS 失败后留下不可达对象；引用感知 GC 尚未实现，未来必须扫描 Conversation 权威，不能因删除单个 Session 就删除共享对象；
- 重启后的 Renderer 当前显示持久附件元数据而非真实缩略图。未来若增加缩略图读取，仍必须经过精确 owner 校验，且不得把 base64 写入公共命令 journal。

deepseek-harness 可继续参考“adapter 私有 replay 只交回同一 owner”的边界。Ariadne 已保留 exact Run/Turn/Attempt、受保护正文和 Public Projection 脱敏权威。

剩余验收条件：adapter-private replay state 与存储内容对齐、不可用时安全退化；附件引用感知 GC 和真实远程 Provider 图片请求；重启后缩略图如需读取必须保持 owner-scoped，不能形成第二条公开字节通道。确定性 Electron 图片选择、发送、视觉请求、重启投影元数据和附件卡片已经进入必跑 smoke。

### 4.5 SubAgent 安全 interrupt 与 ACP Provider 已建立

当前 ordinary Child 已支持 `one_shot` 与 `continuable`。可续 Child 在一次 `respond` 后进入持久 `waiting_input`，公开 Projection 提供 list/status，`agent.subagent.send.v3` 与 Agent 状态面板提供 direct-parent follow-up；第二 Turn 仍复用统一 inbox、预算、权限、Tool Catalog 和 scheduler。已经不再存在“只能完成一次任务后终结”的旧结论。

当前运行中 interrupt 由 work scheduler 的 active inference owner 执行。请求只命中精确 Child/Turn/Attempt，Abort 后必须先得到 uncertain Attempt 与 recovery decision，再提交 `run.interrupt_continuable_turn`；Run 回到持久 `waiting_input`，未 claim inbox 保持 FIFO，下一条 direct-parent input 以 `interrupted_inference` cause 创建新 Turn。`agent.run.cancel.v3` 继续表示终结整个 Run，两者不再混用。

Provider seam 现在还冻结 `configurationDigest`、`inheritsParentContext` 和 `usesParentTools`。Settings schema v5 可声明 ACP executable/args/权限/网络/超时；Main 不把凭据写进 bootstrap，Runtime 通过共享 `AgentProcessSandbox` lease 完成 initialize/new-session/prompt 与 EOF→cancel 的有界回收。外部进程只得到工作目录和委派 prompt；父 system context、父 Tool Catalog、stderr、权限标题和原始异常不会进入结果。ACP permission 默认拒绝；配置为 allow 时，`ask` Child 仍拒绝，只有 `trusted` 且冻结 capability/workspace/network authority 覆盖相应 ToolKind 才可选择 allow。成功 assistant text 仍通过精确 Child Attempt 提交，启动前拒绝形成脱敏 deterministic failure，越过 prompt 后的不明结果进入 uncertain recovery。

新增闭环包括：

- `delegate_subagents` 的 2–16 Child 原子创建、预算切分、全部终态后一次结果聚合；
- ACP `session/resume`/`session/load` 的全新进程 reconnect，远端 session ID 仅存加密 provider-private store；
- Codex app-server 与 Claude Code 的独立产品 adapter、Settings 配置、统一进程沙箱和严格结果解析；Codex 已通过本机真实登录态 acceptance。

剩余问题是 fork、structured report、显式 credential seam、真实 Electron 场景和 Claude 商业登录态 live gate。
- 获取强类型 structured report。

ACP 当前有意不接收 ambient credential，适用于已由自身安全存储认证的 executable；若以后允许显式 credential forwarding，必须在沙箱 broker 上形成独立授权字段，不能扩大全局环境 allowlist。其他外部 Provider 仍必须经相同 capability descriptor、配置摘要和父子权限约束接入，不能回退到旧 `runtime/src/subagent` 工作流。

### 4.6 Provider Resilience 已进入 exact transport 边界

旧 `ResilientModelClient` 不再被误当成 v3 生产证据。现在 legacy client 与 `ProductionExactAgentModelInferenceGateway` 复用同一个 transport adapter 协调器；bootstrap 冻结 policy 直接进入 Runtime model domain。协调器按精确 Provider/model/settings 路由拥有并发槽、每分钟请求/预留 token、连续失败与熔断状态，成功后清零失败计数。

自动 retry 只接受 rate-limit、临时网络、timeout 和可重试 5xx；Provider `Retry-After` 会与本地退避合并但不得超过 `maxBackoffMs`。text、reasoning 或 native Tool-call 任一语义输出出现后立即越过不可重试边界；observer/persistence 随后的失败也不会重新调用 Provider。用户 Abort 保留原始原因，context overflow 仍返回既有规范化状态，由长上下文层最多执行一次压缩恢复。Telemetry 只记录 allowlist 中的 Provider/model、类别、状态码、耗时和 retry count，不携带请求、正文、凭据或远端错误体。

这一项已有 exact HTTP/SSE、首输出、熔断、并发/速率和 telemetry 确定性测试；真实商业 Provider 的限流与长时间运行仍属于产品验收矩阵，而不是实现缺口。

### 4.7 Skills、Hooks、Agent 提问和 Tool UI 的剩余产品层

Ariadne 当前 Skills 的安全边界比动态插件更严格：Manifest 只装配静态 Provider，正文只经 `skill.load` 进入受保护 continuation，脚本不会自动执行。这个边界应保留。

当前实现已补齐目录与 package 生命周期：built-in/user/workspace Provider 按固定优先级进行 Workspace scope overlay；每次 admission 生成可取消的 complete/incomplete snapshot，完整观察原子替换 last-good，瞬时错误复用 last-good，完整观察确认缺失则清除它。资源路径、媒体类型、大小和字节 digest 进入 package revision，`skill.resource.read` 只读取 admission pin 下由 `skill.load` 返回的精确相对路径；资源漂移、越界、symlink 或超限均 fail closed，脚本永远只是数据。`disable-model-invocation`/`user-invocable` 已规范化进入 invocation-neutral snapshot，模型 catalog 与 loader 双重过滤。仍缺不激活 Agent 的人类命令目录与主动变更事件。

Hook 的假 Provider 也已删除：`hooks.lifecycle` 现在提供 required `agent.hooks.lifecycle` service；静态可信 Provider 在 Manifest start 注册，Public Projection sink 建立后才 bind handler set。Admission handler 的最终输出继续经过 attenuation validator，inference/tool pre 异常 fail closed，post observer 异常逐 Provider fail open；Manifest 先反向关闭 handler set，再反向关闭 Provider。Pipeline 不再读取 `runtimePolicy.hooks` 或构造具体 Hook 类。外部动态 Hook 包发现仍有意不开放，不能通过任意 JavaScript 热加载补齐。

Tool 侧已不再由 Renderer 猜测展示语义。V2 contract document 要求每个家族在注册处声明有界 model description/guidance 与静态 presentation kind/label，两者与 schema、permission、lifecycle 和 implementation artifacts 一起进入 contract digest。Inference descriptor V2 只向 Provider 携带这份受信语义；immutable Catalog/Registry 只按 complete Tool pin 解析展示元数据；Public Projection 再裁剪为 kind/label，不携带 `resultVisibility`、Tool input 或 result。Renderer 使用投影 label/kind，名称只是历史 pin 缺失时的安全降级。

结果产品化已经接入同一权威：Public Projection 只发布终态 `detailAvailable` 和 contract-pinned kind/label；Renderer 点击后通过只读公共命令按 Run/Workspace/effect 读取受保护结果，UTF-8 cursor、digest 与 presentation pin 在分页间保持一致。read/search/diff/terminal 使用专用卡，正文不进入 Projection。文件边界由独立 `WorkspaceFileService` 持有：稳定读取返回 opaque version，写入没有 blind-overwrite 分支，只允许 create-if-absent、replace-if-version、同 version text edits、目标不存在的 move 和精确版本 delete。写入与编辑结果生成有界 diff；move/delete 的锁和发布仍由同一个文件 owner 持有。

revision 14 已替换这层错误的“不可变”语义：构建器从明确的生产模块根递归收集 emitted relative ESM closure，用路径、长度和实际 JS 字节生成规范工件；`FirstPartyToolArtifactAuthority` 在注册前逐文件复核，独立 CLI 与打包门禁复用同一验证。一次仅修改校验实现的代码变更就使 Catalog 预期 digest 漂移并被测试拒绝；当前 revision 18 已纳入 11 个模块根和 36 个 Tool，在既有 search/glob/text edits 与固定展示语义上增加 LSP、move/delete，冻结 Catalog digest 为 `5df0cf…`。纯实现与合同漂移因此都进入 release contract，而不是继续信任 name/version 标记。

跨版本策略现已闭合为“持久退休”，而不是伪装成旧代码可恢复。`ProductionAgentRunWorkAuthorityVerifier` 只把 exact Catalog snapshot 缺失分类为 `retired_tool_catalog`；模型、SubAgent Provider、binding 或 Effect Tool 漂移仍是健康故障。启动调度先收敛 persisted started work，再按 Child-before-Parent 顺序提交稳定的 `agent_tool_catalog_retired` 失败与 checkpoint；Child 使用与 Public Projection 相同的 terminal observer 释放预算并推进 Parent，版本冲突后整轮重扫。已有未投影 Child terminal 先通过 startup outbox drain 补齐。因此旧 Run 不会执行新 callback，也不会阻断正常 Run；用户必须在当前 Catalog 下启动新 Run。只有未来产品明确承诺“跨二进制升级继续原 Run”时，才需要再引入有界签名历史 bundle 与支持窗口。

运行中交互现在是双向的。user → Agent 继续使用统一 inbox；Agent → user 使用 `ask_user` Directive，而不是 transient Renderer callback、Provider Promise、普通外部 Tool 或旧 SubAgent router 枚举。问题正文/选项先写入受保护 Directive payload；Run 以 `waiting/user_question` 和精确 checkpoint/Decision 暂停；Public Projection 将受保护 `prompt` 脱敏映射为公开 `question`；回答 action 绑定 token、question ref/digest 和 answer digest，并与 `user_question_answer` 的 `next_step` inbox 输入原子落盘。后续 Turn claim 后，受保护历史按 assistant question → user answer 重建。Core、协议、SQLite authority、public projection、scheduler、interaction resolver、迁移和 Renderer command 均有直接测试；进程外确定性 HTTPS Provider 驱动的真实 Electron 场景既验证卡片显示、选项回答、answer claim 与同 Run terminal continuation，也在 `waiting/user_question` 时由外层杀死 Runtime，并在 supervisor 重启后恢复精确 Decision、回答并完成同一 Run。真实商业 Provider、自由文本窗口场景和取消等待问题的产品语义仍未验收。

### 4.8 复杂度和旧链路仍需持续清理

热点门禁已经证明没有新增环和规则违规，但它当前允许 `SqliteAgentRunUnitOfWork` 达到 5200 行、默认 Factory 达到 850 行。这是迁移护栏，不是完成标准。

下一轮拆分应以权威 owner 为单位：schema/migration、row mapper、command receipt、checkpoint、outbox、execution intent、projection source 分别有可测试端口。拆分后同步下调阈值。对旧 `runtime/src/agent`、`runtime/src/subagent`、旧 context/model/scheduler，只在生产引用归零和迁移测试存在后删除，禁止用兼容 wrapper 延长双链路寿命。

### 4.9 已关闭：Conversation fork、lineage、查询与跨重启稳定引用

Conversation Authority 现已拥有 Session title/status。`rename/archive/restore` 使用精确 Session/Workspace identity 和 expected version；命令 receipt、`conversation.session.updated` event、Session head 与不可变 `conversation_session_versions` 在一个 SQLite 事务中提交。Public Projection 按事件版本读取精确 Session 快照，因此后续重命名不会污染旧事件重放。归档 Session 拒绝新用户消息，但已经运行的 Agent 仍可提交终态结果，避免留下悬挂 Handoff。

schema v4 新增不可变 `conversation_session_lineage` 和幂等 navigation receipt。Fork 必须同时提供 source Session expected version 与已结算 Message 的 `session/message/version/contentDigest`；一个事务创建 child Session、lineage、普通 Session-created event 与命令回执。Child 不复制 ancestor rows，模型历史沿 lineage 递归读取到固定 boundary，因此父会话后续追加不会污染已存在的分支。循环/深度、Workspace 漂移、未结算 boundary 与命令 payload 漂移均 fail closed。

Session query 直接读取 Conversation 权威表并返回 bounded 匹配与稳定引用，没有建立第二数据库或索引权威。引用解析按四元组精确复核，Runtime 关闭再打开后仍能解析；Public Projection 给已提交消息附带同一引用，RuntimeStore 暴露 query/resolve/fork，侧栏搜索正文并可从任一已投影消息创建分支。SQLite 迁移、幂等/冲突、继承历史、跨重启 resolve、公共命令、Projection 与 Renderer Store 均有直接测试。大历史量未来可加可丢弃索引与分页 event read，但不能改变当前权威边界。

### 4.10 已关闭：Credential 统一“引用—解析—授权”边界

`MainCredentialAuthority` 现在是统一 seam。Provider bootstrap 只携带 `model:<provider>`，Runtime 的 Host resolver 在一次 `inferExact` 边界解析一次，重试复用该操作值，下一次推理会观察轮换后的 key。MCP Remote Service 也只依赖该 authority 的 OAuth 方法；ACP 描述为 external/unmanaged，默认不能 resolve。Renderer/公开状态只接触 configured/source/writable，secret 不进入 bootstrap、日志或 Projection。仅修改 API key 的 Settings 事务为 hot-applied，不重启 Runtime。

### 4.11 已关闭：长期 Goal、Todo 与受限 Workflow

独立 productivity authority 以 session/workspace owner 约束 Goal、Todo、Workflow 和 Schedule。Goal 使用 CAS 并区分 active/paused/blocked/complete；Todo 只接受完整快照、稳定 id 和 revision；Workflow 只能推进该快照中的子任务，受并发、转换预算和 deadline 限制，失败/取消会把所有 remaining child 收敛到静止终态并生成结构化 result。它不执行脚本或任意宿主代码，也没有第二套 Agent loop。Renderer 的“目标与工作流”模块可创建、推进、失败或取消这些权威记录。

### 4.12 已关闭：system prompt 已进入 Manifest-owned instruction assembly

Capability Manifest 现在同时管理 Workspace instruction、Skill catalog 与 execution-mode policy contributor。每个 contributor 有稳定 id/version/order、适用 mode 和 Workspace/Run/mode scope；`ProductionAgentInstructionAssembly` 接收精确 Run/Session/Workspace/mode subject 和 `AbortSignal`，校验重复 identity/order、scope 矛盾、block/总量/数量上限，并只返回 `complete: true` 的不可变快照。任一 contributor 失败会使 admission 以 `AGENT_ADMISSION_INSTRUCTIONS_INVALID` 关闭，不会发布半份 prompt。

Factory 已删除 Workspace/Skill 拼接和 `skillCatalog` 输入，admission reader 也不再拥有 plan/chat 文案。最终 system block 带 contributor/version/block/order/scope/SHA-256 revision 标记进入受保护 Turn input，因此旧 Run 的解释不依赖运行期重新解析。Provider 接线和快照编译器保持分文件维护。Skill contributor 消费 ADR-0029 的 scoped snapshot，package 资源与 invocation policy 由 ADR-0030 固定，Hook ownership 由 ADR-0031 固定；人类命令 consumer 已从同一 snapshot 接入，剩余只有若未来需要外部扩展时的签名/发现设计。

### 4.13 已关闭：Scheduled work 进入普通 v3 Turn

Schedule 现在是 productivity SQLite 的版本化记录，owner 计算 once/interval/cron 的下一次时间，并先提交稳定 occurrence，再用稳定 command/message ID 调用 `conversation.message.accept.v3`。进程在提交前后崩溃都会重试同一个身份，由 Conversation command receipt 去重；后续 handoff、admission、权限、预算、Tool Catalog 与 Projection 全部沿用现有 v3 链。生产 `createAppContext()` 已不再构造旧 Scheduler；只读 `LegacySchedulerJournalReader` 仅由显式 `scheduler:migrate:v3` 使用，要求指定已经存在的 workspace/session，事件型 trigger 安全跳过。

### 4.14 已关闭：TypeScript/JavaScript 语义代码导航；跨会话 canonical reference 已进入 Conversation 权威

旧 Runtime application 的 `LspCodeIntelligenceProvider`、Tree-sitter fallback、ProjectIndex 与 HistoryFileRecaller 不再是生产入口。Catalog revision 18 的 `workspace.code_intelligence` 使用可替换 `WorkspaceLspService` seam，在现有 `AgentProcessSandbox` 中持有 bundled TypeScript language server 的长生命周期 stdio lease；definition/reference/hover/document symbols 都带精确文件 version、有界结果与 workspace containment，完整结果只进入受保护 Effect payload。真实 server 集成测试覆盖启动、连续查询与关闭。Conversation owner 同时持有 canonical Session/Message/version/digest reference、resolve 和 fork lineage；未来 Agent 跨会话 Tool 应消费这套引用，而不是复制文本。

LSP/search 已复用现有 Tool authority，没有复活旧 registry。其他语言服务器、全仓语义索引与跨会话 Agent Tool 只有在出现明确产品需求时再沿相同 seam 增加；UI mention 语法仍只属于 Renderer，不能进入 Agent Core。

### 4.15 已关闭：运行中输入 delivery receipt 与 Projection 活性

Renderer 现在在发送前生成稳定 commandId/inputId，保留原始 `agent.inbox.enqueue.v3` 命令，并展示 `pending/accepted/failed/reconcile`。超时、取消或结果不确定不会生成新业务命令；用户触发“重新确认”时以同一 commandId 和完全相同 payload 进入 Runtime command journal。Public Projection 中出现精确 inputId 是强于 IPC 响应的提交证明，可以直接把本地回执结算为 accepted；确定性失败才进入 failed。已结算回执可关闭，未结算回执不可静默丢弃，Tracker 有界且只淘汰终态记录。

真实 Electron smoke 在 Agent inbox 已提交而 IPC 响应尚未返回时由外层 watcher 强杀 Runtime，随后验证 Runtime 重启、同一 commandId、唯一 input、accepted 回执、回执关闭、输入移除和原 user-question Run 继续完成。smoke oracle 不强制短暂出现 reconcile：若权威 Projection 先到，它已经完成了更强的对账；若确实进入 reconcile，则必须点击同一记录的“重新确认”。

同一场景还证明了 wake 不能作为唯一活性来源。Renderer 现在只把 wake 当作加速提示；存在活动 Run 时，它以 500ms 低频读取同一权威 Projection tail，终态后停止。Decision answer 会先等待对应 Projection 结算，因此丢失 wake 不再让卡片关闭后 Run 永久停留在 Running。该机制没有第二份数据库、本地推断或 UI writer。

当前诊断 artifact 保留 lifecycle step、脱敏错误、Provider 计数、结果和截图，默认仍不复制含受保护正文的 Agent Control DB。`-KeepData` 只用于显式本地诊断，不属于发布门禁产物。长期多轮 soak 仍可增加，但它是稳定性深度，不再是运行中输入产品闭环缺失。

### 4.16 已关闭：未结算回执跨 Renderer/整桌面重启恢复

发送方恢复现在由 `AgentInputDeliveryOutbox` 承担，但它不拥有执行权威。Renderer 在调用 Runtime 前把唯一允许的 `agent.inbox.enqueue.v3` 精确 envelope 写入 Electron Main；Main 使用系统 `safeStorage` 加密完整记录，磁盘外层只保存 commandId 的 SHA-256 storage key、密文和创建时间。记录数与密文长度有界，写入串行化并经临时文件原子替换；同 ID 同 payload 幂等，同 ID 漂移、解密失败、身份 hash 不匹配和非 inbox 命令均 fail closed。正文不会进入 localStorage、StateRepository、普通日志或 Public Projection。

Runtime command journal 与 Agent inbox 仍是唯一 delivery/执行权威。确定性成功响应或 Public Projection 出现精确 inputId 时，Renderer 将回执结算为 `accepted` 并从 sender outbox 删除；确定性失败删除发送记录；传输结果不确定时保留原 commandId/inputId/payload。Renderer 初始化从 Main 恢复这些记录为 `reconcile`，不会自动调用 Runtime；只有用户明确重新确认时，才以完全相同 commandId 和 payload 进入 Runtime journal，因此没有第二套队列或启动期盲重放。

真实 Electron gate 先在完整产品场景后暂存一条未提交命令并 reload Renderer，验证同一回执和加密 outbox 记录恢复；第一个桌面进程正常退出后，PowerShell 使用同一隔离 userData 启动全新 Electron Main/Preload/Renderer/Runtime，再验证相同 commandId/inputId 的 `reconcile` 回执、outbox 未提前结算且该 inputId 不在 Runtime Public Projection，最后显式 settle 并确认 outbox 为空。对应证据是 `rendererReloadDeliveryRecovered=true`、`renderer-reload-delivery.json` 与 `desktop-restart-delivery.json: passed=true`。

## 5. 不应照搬 deepseek-harness 的部分

- 不引入 Cordis 作为新的全局容器；Ariadne 已用静态 Manifest compiler 建立可审计的 service dependency resolver，应继续保持 Provider scope 与 bootstrap root 边界。
- 不开放任意磁盘 JavaScript 插件、热重载或 Renderer 注册 Runtime Provider。
- 不复制 Web Server 边界；保持 Renderer → Preload → Main → Node IPC → Runtime，Runtime 无入站 HTTP。
- 不用 plugin event 替换 Agent Control 事务、checkpoint、outbox、Decision 与 started-work recovery。
- 不降低 Windows Sandbox、路径 containment、credential 环境变量白名单和权限预览标准。

## 6. 建议实施顺序

1. scoped Skill snapshot、固定 package 资源、model/user policy、可信 Hook Provider lifecycle 与不激活 Agent 的人类命令 consumer 已闭环；除非有明确产品需求，不开放外部动态 Hook 包发现。
2. 在已完成的 exact request/response/image content blocks 与 Electron 图片 smoke 上补 adapter-private replay state，并为现有内容寻址 AttachmentStore 增加引用感知 GC 与真实远程 Provider 验收；不要复用旧 ResourceRegistry 形成第二条多模态权威。
3. 已完成稳定边界 fork/lineage、Session reference 与权威 Session query；后续只在真实大历史基准证明需要时增加可丢弃索引和 bounded event pagination，置顶与未读继续保留为设备偏好。
4. 在已完成的版本化原子文件 service 和 contract-pinned kind/label 上补受保护结果驱动的 read/search/diff/terminal 详情、LSP Provider 与 move/delete；所有变更继续复用同一 freshness/result owner，不复活旧 Tool registry。
5. 外部 continuable/reconnect、Codex/Claude Provider、Goal/Todo/受限 Workflow 已接入；后续只保留 structured SubAgent report、Claude 商业登录态和真实 Electron SubAgent 深度验收。
6. 旧 unattended Scheduler/Orchestrator 已迁移为向原 Session 投递普通 v3 Turn 的 durable Schedule，第二套 scheduled Run/notification 语义与可执行旧 Scheduler 已删除。
7. 统一 credential reference/resolve/describe/authorization seam；ACP 凭据仍默认隔离。
8. 继续拆 UoW/Factory 热点、删除无生产引用旧链路并下调门禁阈值。

## 7. 统一完成定义

任何一项都只有同时满足以下条件才可从本审计移到“已完成”：

- 单一 owner、单一权威和清晰的恢复语义；
- Protocol schema、visible descriptor、validation、mock 和 migration 同步；
- 没有把 protected payload 复制到 Public Projection；
- focused tests、全量 tests、architecture、runtime-independence 全部通过；
- 涉及 Runtime/UI 行为时有真实 Electron 窗口证据；
- 文档只描述当前唯一生产路径，旧内容已删除；
- 干净检出能够通过 `verify:reproducible`。

## 8. 关联文档

- [当前实现架构](architecture.md)
- [v3 目标架构](architecture-v3.md)
- [验证说明](verification.md)
- [Agent inbox](agent-inbox.md)
- [v3 长上下文生命周期](long-context-v3.md)
- [SubAgent v3 产品闭环](subagent-v3.md)
- [Skills、Hooks 与可观测性](skills-hooks-observability.md)
- [Runtime Capability Manifest](capability-manifest.md)
- [ADR 0020：v3 inference stream authority](adr/0020-v3-inference-stream-authority.md)
- [ADR 0021：exact Provider response content blocks](adr/0021-exact-agent-provider-content-blocks.md)
- [ADR 0022：exact Provider request content blocks](adr/0022-exact-agent-provider-request-content-blocks.md)
- [ADR 0023：durable Conversation image attachments](adr/0023-durable-conversation-image-attachments.md)
- [ADR 0024：durable Conversation session lifecycle](adr/0024-durable-conversation-session-lifecycle.md)
- [ADR 0033：contract-pinned Tool semantics and public presentation](adr/0033-contract-pinned-tool-semantics-and-public-presentation.md)
