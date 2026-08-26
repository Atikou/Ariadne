# Ariadne 验证与验收边界

> 状态日期：2026-08-26
> 自动回归不能替代真实模型、正式签名或干净机器验收。

## 1. 当前复核

| 命令 | 当前结果 | 证据 |
|---|---|---|
| `npm.cmd run typecheck` | PASS | Protocol、Agent Core、Runtime、App 类型检查通过 |
| `npm.cmd test` | PASS | Protocol 39、Agent Core 99、Runtime 681、App 249，共 1,068 项 |
| `npm.cmd run check:architecture` | PASS | 845 个 TS/TSX 文件、3,387 条内部边、0 SCC、0 循环边、0 规则违规；Hotspot Boundary Gate 通过 |
| `npm.cmd run audit:runtime-independence` | PASS | 866 个生产文件；无入站 HTTP、仓库外文件依赖或根脚本路径 |
| `npm.cmd run verify:release-contract` | PASS | 安装器、迁移、模型资产和验收矩阵契约通过 |
| `npm.cmd run test:electron` | PASS | 真实窗口完成 direct、真实 Composer 运行中 inbox continuation、Tool continuation、Decision allow/deny、运行中取消和三个持久边界的 Runtime 强杀恢复 |

`test:electron` 的最新结果记录了 13 次 Provider 请求、11 次响应、2 次被取消请求；其中 inbox 场景通过真实 Composer 在首轮推理进行中加入输入，并由同一 Run 的下一 Turn 消费。三个强杀点分别位于 initial inference started、effect started 和 Agent authority completed/Public Projection pending。上述数字是本次修复后的当前工作树结果；后续仍应以命令和 artifact 为准。

## 2. 历史审计快照

在后续工作树状态变化前，本日对比审计曾记录：

- `typecheck` 通过；
- Protocol 39、Agent Core 90、Runtime 659、App 246，共 1,034 项测试通过；
- Architecture Gate 扫描 825 个 TS/TSX 文件、3,290 条内部边，0 循环、0 违规；
- Runtime independence 扫描 848 个生产文件并通过；
- 当时的 Electron Conversation/Projection smoke 通过。

这些数字是升级真实 Agent smoke 之前的固定审计时点，不能替代当前命令和 artifact。

## 3. 开发门禁

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run check:architecture
npm.cmd run audit:runtime-independence
npm.cmd run verify:release-contract
npm.cmd run test:electron
```

- `typecheck` 和 `test` 按 Protocol -> Agent Core -> Runtime -> App 顺序运行。
- `check:architecture` 验证完整 TS/TSX 依赖图和规则，并执行 Hotspot Boundary Gate；后者限制 Factory、Tool family 和 SQLite UoW 子边界的规模与职责回流，不允许通过刷新 baseline 隐藏新增债务。
- `audit:runtime-independence` 只证明源码、依赖、入口和入站网络边界独立，不证明产品能力。
- `verify:release-contract` 校验安装器、数据库兼容策略、外部 Embedding 资产和本验收矩阵的静态契约。

## 4. Electron smoke 的准确含义

当前 `app/src/main/smoke/electron-smoke.ts` 通过产品公开路径运行：

```text
Renderer -> Sandbox Preload -> Electron Main -> Node IPC -> Runtime
         -> SQLite authority/outbox -> Public Projection -> Renderer
```

它验证：

- 真实 Electron 主窗口、Sandbox Preload、Main、Runtime 子进程、SQLite 和 Public Projection；
- 通过真实设置接口启用唯一可用的 Agent 模型；
- 直接回答形成带因果 `runId` 的 terminal assistant message；
- 首轮推理期间从真实 Composer 排入 `next_turn`，Public Projection 唤醒 Renderer 清除 pending overlay，并在同一 Run 中形成第二轮 assistant response；
- `workspace.read_file` 执行后由 Provider continuation 消费精确结果；
- `workspace.write_file` 在 allow 前不产生外部动作，allow 后只写一次，deny 后不写；
- 推理进行中取消会中止 Provider 请求，并以持久 recovery evidence 收敛为 cancelled；
- 在 initial inference started、effect started、projection pending 三个持久边界强杀真实 Runtime 子进程；
- 重启后分别收敛为 interrupted 或完成投影，不重复 Provider 请求和文件副作用；
- Renderer 没有控制台错误，失败时保存诊断快照和截图。

Provider 是 smoke 脚本启动的进程外、确定性 HTTPS OpenAI-compatible fixture。它经过真实网络/证书/Provider adapter，但不是外部商业 Provider。强杀边界由独立只读 SQLite watcher 观察权威状态，不依赖固定延时猜测。

证据位于：

- `artifacts/electron-runtime-smoke/electron-runtime-smoke.json`
- `artifacts/electron-runtime-smoke/electron-runtime-smoke.png`

它不验证真实远程 Provider、本地聊天模型、真实 Browser/MCP、正式签名 Sandbox Helper 或正式安装器；这些能力不得由确定性 smoke 代替。

## 5. 自动测试覆盖与生产接线必须分开

以下能力已有源码和自动测试，但当前没有完整 v3 product consumer 或真实验收：

- Memory、Embedding 与 spill；
- SubAgent、Background Task 与 Scheduler；
- 完整 Hook lifecycle；
- Diagnostics publisher 与 Telemetry lifecycle；
- Provider Resilience policy 在 v3 inference adapter 中的消费；
- Context compaction 与 Tool result pruning 已进入 v3；精确 tokenizer、spill、Live Provider 长上下文验收仍未完成；
- 不唤醒模型的独立 context injection 与可恢复 token/reasoning stream；运行中 follow-up/steer 已进入生产链路。

这些条目在 [verification-matrix.json](verification-matrix.json) 中只能标记为 `partial` 或 `not_accepted`，不能因为目录、schema 或单元测试存在而标记为产品已验收。

## 6. 矩阵状态语义

| 状态 | 含义 |
|---|---|
| `verified` | 该维度已有直接、当前、可重复的证据 |
| `partial` | 只覆盖部分路径，或实现存在但 consumer/lifecycle 不完整 |
| `not_accepted` | 该维度尚无可接受证据 |
| `not_applicable` | 该维度不适用于此模块 |

`realWindow=verified` 只表示真实 Electron 路径直接覆盖该模块；单元测试使用 Electron 类型或 mock Browser 不算真实窗口。

## 7. 发布门禁

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

详细差距和退出条件见 [deepseek-harness 对比审计](deepseek-harness-comparison-audit-2026-08-26.md)。
