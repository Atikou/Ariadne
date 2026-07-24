# Runtime P0/P1 完成状态

> 状态日期：2026-07-24。
>
> `[x]` 表示当前工作树已有实现和自动证据；`[ ]` 表示缺少实现或指定的真实验收。
>
> 产品扩展不在本清单范围内。

## P0

- [x] Protocol 一次性升级到 2.0，Public/Host 分层并使用严格 Schema。
- [x] 单一 `RunAggregate`、typed command、合法状态转换和乐观版本竞争检查。
- [x] aggregate、checkpoint、tool ledger 和 domain event outbox 事务提交。
- [x] 非终态不确定副作用进入 `recovery_required`，不静默完成或重跑。
- [x] `runtime.snapshot.get`、`events.replay` 和持久 cursor。
- [x] Renderer 从单一 revision 快照初始化并幂等应用事件。
- [x] Trace 只承担诊断职责。
- [x] Zod 4 与唯一 `ToolContract<I,O>`。
- [x] Provider native Tool Calling 与文本 fallback 统一规范化为 `AgentAction`。
- [x] 协议修复最多两次，修复成功前不执行工具。
- [x] 安全只读工具并发、资源冲突串行和默认并发上限 4。
- [x] 工具 intent/start/result checkpoint、稳定幂等键和恢复决策。
- [x] `ContentEnvelope`、instruction authority 和 secret egress gate。
- [x] Browser capability 只有 Main 健康并成功注册工具后才动态公布。
- [x] 隔离工作区 Eval Harness 和 11 类固定场景。
- [x] 当前仓库自有测试基线，源码、测试、构建和发布不依赖项目外实现。
- [ ] 使用真实远程/本地模型完成工具、权限、计划、取消和强杀恢复验收。

## P1：Context、Memory 与代码理解

- [x] `TokenCounter`：本地实际 tokenizer、远程 profile、保守降级标记。
- [x] Context 预留输出和 Tool Schema 预算，超限 section 可跳过。
- [x] 本地 GGUF Embedding 接入和 BGE-M3 固定来源/许可证/SHA-256 清单。
- [x] 严格结构化摘要、来源范围和 degraded 状态。
- [x] 长期记忆生命周期、来源、敏感度、保留期、作用域和 Public 治理 API。
- [x] 用户编辑记忆生成可审计 replacement，旧版本进入 `superseded`。
- [x] LSP 3.18 优先、Tree-sitter WASM fallback。
- [x] TS/JS、JSON/Markdown、Python、C# fixture。
- [x] 持久 Repo Map 与任务相关最小子图。
- [ ] 装配真实 BGE-M3 权重并完成多语言语义召回验收。
- [ ] 在大型多语言仓库完成索引性能与增量失效压力验收。

## P1：扩展边界

- [x] MCP 使用官方 TypeScript SDK。
- [x] 远程 MCP 只允许 HTTPS Streamable HTTP，旧 SSE 默认关闭。
- [x] MCP 工具适配为 ToolContract，annotations 不可靠时默认危险、串行、非幂等。
- [x] Runtime 拒绝 token passthrough，credentialRef 只作为 opaque reference。
- [x] 原生 Sandbox v5 提供可审计的长连接双工 process lease。
- [x] MCP STDIO 通过该 lease 工作，受有界 I/O、环境允许列表、网络和工作区策略约束。
- [x] Main 托管远程 Streamable HTTP、OAuth 2.1/PKCE 和 `safeStorage` 加密凭据；Runtime 只交换 JSON-RPC 与 opaque ID。
- [ ] 用签名 helper、真实 STDIO MCP 服务和真实 OAuth 授权端完成首次授权、刷新、撤销、崩溃与断线恢复验收。
- [x] `.ariadne/skills/<name>/SKILL.md` 三层 Skills。
- [x] 系统 → 用户 → workspace 根 → 目标目录 → Skill 的固定指令优先级。
- [x] Skill 脚本不获得 ToolContract/Policy/Sandbox 之外的权限。
- [x] session/run/model/tool/subagent/stop Hooks 真实接线。
- [x] Hook 版本、超时、持久 delivery ID、去重和 fail-open/fail-closed。
- [x] Hook 只能拒绝 pre 操作或收紧权限/超时，不能扩权。
- [x] 内容寻址 Resource Registry 与 opaque Public DTO。
- [x] Resource list/get/update/delete。
- [x] Browser Service 由 Electron Main 管理隔离 WebContentsView。
- [x] Browser navigate/a11y/screenshot/click/type/scroll/wait/download 工具。
- [x] 默认临时 Session、HTTPS、同源重定向、权限/弹窗/未批准下载拒绝。
- [ ] 在隔离验收机执行真实网页、重定向、下载、截图和敏感输入验收。

## P1：Headless、恢复与可靠性

- [x] Headless 复用 RuntimeFacade，不创建第二套执行路径。
- [x] stdin/stdout NDJSON：hello/command/shutdown 与 ready/response/event/fatal。
- [x] stdout 仅协议、stderr 日志、resumeCursor、取消、退出码和 `--once`。
- [x] Task Checkpoint list/get/compare/restore Public API。
- [x] Restore 只管理 Run 工具账本文件并在哈希冲突时阻塞。
- [x] Restore 本身生成新的可撤销 checkpoint。
- [x] Provider 错误分类、Retry-After、退避/jitter、限流、并发和熔断。
- [x] 首个流式 token 后禁止透明重试。
- [x] Provider qualification matrix，不按兼容协议名称推断能力。
- [x] OTel Node trace/metric，默认关闭，HTTPS endpoint allowlist 和属性脱敏。
- [ ] 用真实 Provider 完成 qualification 和 resilience 故障注入验收。
- [ ] 用真实 OTLP collector 验证网络策略和导出字段。

## P1：数据库与 Windows 发布

- [x] 迁移前一致性备份与恢复 manifest。
- [x] 迁移失败事务回滚。
- [x] 新版本数据库拒绝旧程序写入。
- [x] N-1 → N 前向策略和备份恢复降级策略清单。
- [x] NSIS assisted installer、残留应用/helper 回收。
- [x] 静默卸载默认保留数据；交互删除数据需显式确认。
- [x] 发布契约、原生 Sandbox、Node runner、模型 Runtime 和签名产物门禁。
- [x] 机器可读覆盖矩阵。
- [x] MCP、Skills、Hooks、Browser policy、telemetry、Provider resilience 和 Embedding 的版本化 `runtimePolicy` 设置快照与 Host bootstrap。
- [ ] 安全注入一个远程 Provider 凭据。
- [ ] 安全注入真实本地聊天模型和 BGE-M3。
- [ ] 安全注入应用/helper 签名环境。
- [ ] 在干净 Windows 验收机执行全新安装、N-1 升级、迁移失败回滚、备份降级和卸载。

## 当前门禁证据

- `npm.cmd run typecheck`
- `npm.cmd test`
- `npm.cmd run audit:runtime-independence`
- `npm.cmd run test:electron`
- `npm.cmd run verify:release-contract`
- [verification-matrix.json](verification-matrix.json)

未完成的真实验收不能通过勾选单元测试替代。
