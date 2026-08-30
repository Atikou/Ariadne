# Ariadne 验证与验收边界

> 状态日期：2026-08-29
> 自动回归不能替代真实模型、正式签名或干净机器验收。

## 1. 当前复核

| 命令 | 当前结果 | 证据 |
|---|---|---|
| `corepack.cmd npm run typecheck` | PASS | Protocol、Agent Core、Live Work、Runtime、App 类型检查通过 |
| `corepack.cmd npm test` | **FAIL** | Protocol 48、Agent Core 106、Live Work 5、Runtime 834 均通过；App 296/297，唯一失败仍是 `global-radius-contract` 检出的共享 UI `4px/6px` 非 token 圆角 |
| `corepack.cmd npm run check:architecture` | PASS | 936 个 TS/TSX 文件、3,718 条内部边、2,061 个 type import、0 SCC、0 循环边、0 规则违规；Hotspot Boundary Gate 通过 |
| `corepack.cmd npm run audit:runtime-independence` | PASS | 953 个生产文件；无入站 HTTP、仓库外文件依赖或根脚本路径 |
| `corepack.cmd npm run verify:release-contract` | PASS | 安装器、迁移、模型资产和验收矩阵契约通过 |
| `corepack.cmd npm run test:electron` | PASS | 完整命令通过；真实窗口观察到运行中 stream、2 个持久分块、单一最终消息，并完成 inbox、稳定 delivery receipt/权威对账、ask-user 卡片/等待态恢复/同 Run 续跑、Tool、Decision、取消和五个持久边界的 Runtime 强杀恢复 |
| `corepack.cmd npm run verify:source-snapshot` | **FAIL** | 唯一失败是当前 Git 工作树不干净；固定 npm 11.13.0 已生效 |

最新真实窗口 artifact 记录了 18 次 Provider 请求、16 次响应、2 次被取消请求。运行中输入场景在 command journal/Agent inbox 已提交但 IPC 响应尚未返回时强杀 Runtime；Renderer 以同一 commandId 显示 `pending/accepted/failed/reconcile` 回执，并以唯一 Public Projection inbox input 作为更强的结算证据。ask-user 场景还在 Run 已提交 `waiting/user_question` 时强杀 Runtime，重启后恢复同一 Decision/卡片并由同一 Run 完成。其余三个强杀点分别位于 initial inference started、effect started 和 Agent authority completed/Public Projection pending。上述数字是本次修复后的当前工作树结果；后续仍应以命令和 artifact 为准。

assistant-profile/schema 测试夹具已由其 owner 补齐；Renderer 对内部 settings 的直接依赖也已改由 Desktop shared contract 暴露规范默认值，typecheck 与 architecture gate 恢复通过。当前 App 全量测试唯一失败仍来自共享 UI 样式中的 4px/6px 圆角；本轮没有机械改写该设计改动，所以仓库仍不得被描述为全量测试通过。

## 2. 开发门禁

```powershell
corepack.cmd npm run typecheck
corepack.cmd npm test
corepack.cmd npm run check:architecture
corepack.cmd npm run audit:runtime-independence
corepack.cmd npm run verify:release-contract
corepack.cmd npm run test:electron
```

- `typecheck` 和 `test` 按 Protocol -> Agent Core -> Live Work -> Runtime -> App 顺序运行。
- `check:architecture` 验证完整 TS/TSX 依赖图和规则，并执行 Hotspot Boundary Gate；后者限制 Factory、Tool family 和 SQLite UoW 子边界的规模与职责回流，不允许通过刷新 baseline 隐藏新增债务。
- `audit:runtime-independence` 只证明源码、依赖、入口和入站网络边界独立，不证明产品能力。
- Capability Manifest 测试验证 Provider 依赖/所有权、缺 Provider 不宣告、Tool Catalog 同源、失败回滚和公开安全诊断；它不代替真实 Provider/窗口验收。
- Capability Manifest 测试同时验证 Provider 顺序、service ownership、启动期依赖注入、必需/可选依赖、未声明读取拒绝、必需输出缺失拒绝，以及 Skills/live-work/可选 Telemetry 到类型化 Agent Control service bundle 的组装；默认 Factory 不再按字符串查找这些扩展 service。
- live-work 测试验证真实 Host pipe process、沙箱内 Agent PTY 的 write/resize/interrupt/kill、Main PTY registry、owner/cursor/join，以及完成通知的 SQLite inbox-first 提交、系统来源、去重领取和 close → drain → unbind → Store freeze 顺序；native Runner smoke 覆盖所有 signal frame，并真实终止一个 30 秒 PowerShell Job。SQLite reopen 验证 Agent Job 收敛为 `interrupted`；Electron smoke 强杀持有活动 Terminal 的 Main，再在新进程窗口中验证 `interrupted/main_process_lost`、不可自动重放提示、显式 restart 和 `restartOf` lineage。
- `verify:release-contract` 校验安装器、数据库兼容策略、外部 Embedding 资产和本验收矩阵的静态契约。

## 3. Electron smoke 的准确含义

当前 `app/src/main/smoke/electron-smoke.ts` 通过产品公开路径运行：

```text
Renderer -> Sandbox Preload -> Electron Main -> Node IPC -> Runtime
         -> SQLite authority/outbox -> Public Projection -> Renderer
```

它验证：

- 真实 Electron 主窗口、Sandbox Preload、Main、Runtime 子进程、SQLite 和 Public Projection；
- 通过真实设置接口启用唯一可用的 Agent 模型；
- 在真实侧栏重命名和归档持久 Session，从设置页恢复并重新选择；每一步都等待对应的 Public Projection title/status 版本，不读取本机 lifecycle shadow；
- 直接回答形成带因果 `runId` 的 terminal assistant message；
- exact Attempt 的 reasoning 与公开 respond content 通过 SSE 分块进入 durable Public Projection；Renderer 在最终消息到达前显示流，之后只保留权威 terminal assistant message；
- 首轮推理期间从真实 Composer 排入 `next_turn`，Public Projection 唤醒 Renderer 清除 pending overlay，并在同一 Run 中形成第二轮 assistant response；
- 在 command journal/Agent inbox 已提交而 IPC 响应未返回的边界强杀 Runtime；Renderer 保留稳定 commandId，允许不确定结果用原命令对账，且权威 Projection 只能出现一个相同 input；
- 未结算 enqueue 在调用 Runtime 前进入 Main-only `safeStorage` 加密 sender outbox；Renderer reload 后以同一 commandId/inputId 恢复为 `reconcile`，不会自动重放；
- 第一个桌面进程退出后，脚本用同一隔离 userData 启动全新 Electron Main/Preload/Renderer/Runtime，验证同一回执再次恢复、目标 inputId 不存在于 Public Projection，随后显式结算并确认 outbox 为空；
- 模型提交 `ask_user` 后，真实 Conversation 内显示脱敏问题与选项卡片；点击选项会通过 opaque Decision action 原子写入 `user_question_answer` inbox，卡片关闭，答案被 claimed，并由同一 Run 继续到 terminal response；
- `workspace.read_file` 执行后由 Provider continuation 消费精确结果；
- `workspace.write_file` 在 allow 前不产生外部动作，allow 后只写一次，deny 后不写；
- 推理进行中取消会中止 Provider 请求，并以持久 recovery evidence 收敛为 cancelled；
- 在 inbox response loss、user-question waiting、initial inference started、effect started、projection pending 五个持久边界强杀真实 Runtime 子进程；
- 重启后分别收敛为 interrupted 或完成投影，不重复 Provider 请求和文件副作用；
- Renderer 没有控制台错误，失败时保存诊断快照和截图。

Provider 是 smoke 脚本启动的进程外、确定性 HTTPS OpenAI-compatible fixture。它经过真实网络/证书/Provider adapter，但不是外部商业 Provider。强杀边界由独立只读 SQLite watcher 观察权威状态，不依赖固定延时猜测。

证据位于：

- `artifacts/electron-runtime-smoke/electron-runtime-smoke.json`
- `artifacts/electron-runtime-smoke/renderer-reload-delivery.json`
- `artifacts/electron-runtime-smoke/desktop-restart-delivery.json`
- `artifacts/electron-runtime-smoke/electron-runtime-smoke.png`

它不验证真实远程 Provider、本地聊天模型、真实 Browser/MCP、Agent PTY 窗口交互/live-work completion 自动续跑、正式签名 Sandbox Helper 或正式安装器；这些能力不得由确定性 smoke 代替。

## 4. 自动测试覆盖与生产接线必须分开

以下能力已有源码和自动测试，但当前没有完整 v3 product consumer 或真实验收：

- Memory 与 Embedding；
- SubAgent 批量 Child、外部 continuable/reconnect、Codex/Claude/structured report 与真实窗口场景；one-shot/continuable ordinary Child、运行中非终态 interrupt 和 fresh-process ACP one-shot Provider 已有 production-pipeline/真实子进程 integration evidence；旧 Background Task 第二进程表及其幽灵 trigger contract 已删除；
- Provider-neutral typed request history 与 exact response `text/reasoning/tool_call` 已进入 v3；历史 Tool 输入按 committed digest 从受保护 Effect payload 恢复，OpenAI/Anthropic/本地模型使用原生 Tool history。图片附件由 Conversation 的内容寻址引用持有，推理前按精确 Message owner 复核并只在临时 Provider 请求中展开；仍缺 adapter-private replay state；
- 确定性因果 semantic compaction、可恢复 Tool result spill、request-envelope-bound Provider usage anchor 与 bounded overflow recovery 已进入 v3；source/summary digest 会跨 SQLite reopen，摘要保持普通用户历史权限且 Tool 全量结果仍由原 Effect payload owner 读取。逐 binding tokenizer 与最终投影硬准入已进入 v3；真实本地 llama.cpp 长上下文跨进程重启门禁已通过，真实远程 Provider 因当前机器无 credential 尚未执行；
- 不唤醒模型的独立 context injection；运行中 follow-up/steer 和可恢复 token/reasoning stream 已进入生产链路；
- Agent 主动提问的 durable ask-user Directive、受保护问题载荷、回答 receipt、SQLite authority、Projection、scheduler continuation 与 Renderer 已有直接自动测试；确定性进程外 HTTPS Provider 驱动的真实 Electron 操作与 `waiting/user_question` 强杀恢复也已验收。真实商业 Provider、自由文本窗口场景和取消等待问题的产品语义仍未验收；
- 人类 Skill command catalog，以及若产品需要外部 Hook 包时的签名/发现；scoped complete/incomplete snapshot、last-good、取消/关闭、固定 package 资源读取、model/user invocation policy、Manifest-owned 静态可信 Hook Provider 生命周期、Diagnostics publisher 与受控 Telemetry 已接入。
- `workspace.search_text/glob/apply_text_edits` 已进入 Catalog revision 17：服务与 Tool integration 覆盖稳定搜索 version、Unicode 行列、CRLF、重叠/越界拒绝、外部陈旧编辑、realpath containment、symlink 排除和扫描/字节/结果上限。V2 Tool 合同额外固定模型 description/guidance 与可公开静态 kind/label；Provider request 和 Renderer activity 均从同一 exact pin 获取，Public Projection 不包含 result visibility、input 或 result。真实 Electron 搜索→编辑交互与受保护结果驱动的 read/search/diff/terminal 详情尚未验收。

这些条目在 [verification-matrix.json](verification-matrix.json) 中只能标记为 `partial` 或 `not_accepted`，不能因为目录、schema 或单元测试存在而标记为产品已验收。

## 5. 矩阵状态语义

| 状态 | 含义 |
|---|---|
| `verified` | 该维度已有直接、当前、可重复的证据 |
| `partial` | 只覆盖部分路径，或实现存在但 consumer/lifecycle 不完整 |
| `not_accepted` | 该维度尚无可接受证据 |
| `not_applicable` | 该维度不适用于此模块 |

`realWindow=verified` 只表示真实 Electron 路径直接覆盖该模块；单元测试使用 Electron 类型或 mock Browser 不算真实窗口。

## 6. 发布门禁

静态发布契约：

```powershell
npm.cmd run verify:release-contract
```

正式门禁：

```powershell
npm.cmd run verify:release
```

正式门禁依次覆盖依赖、契约、Protocol、Agent Core、Runtime、App、独立性、Electron、签名环境、Windows 包、打包 Runtime/模型/Sandbox 资产和 Authenticode。缺少正式证书、模型资产或受信任 helper 时必须失败。

## 8. 当前仍未验收

- 真实远程 Provider 和本地聊天模型；
- Plan/Recovery/预算等未进入本 smoke 的 Decision 类型；
- 实际 Embedding 模型的多语言召回；
- 签名 Sandbox helper 下的真实 MCP STDIO 和真实远程 MCP OAuth；
- Browser 真实 HTTPS、重定向、敏感输入和下载隔离；
- 正式签名安装包在干净 Windows 上的安装、N-1 升级、迁移失败回滚、降级和卸载。

详细差距和退出条件见 [deepseek-harness 对比审计](deepseek-harness-comparison-audit-2026-08-28.md)。
