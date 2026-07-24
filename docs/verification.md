# 验证说明

## 自动验证

```powershell
npm.cmd run typecheck
npm.cmd run audit:runtime-independence
npm.cmd test
npm.cmd run build
npm.cmd run test:electron
npm.cmd run verify:release
```

`verify:release` 是严格发布门禁：除下述 Protocol → Runtime → App 验证外，还会执行根依赖与独立 Runtime 依赖审计、Runtime 独立性审计、真实 Electron 冒烟，最后生成并复验受信任 Windows 安装包。缺少签名环境或模型资产时必须失败。

根级测试命令按 Protocol → Runtime → App 顺序执行，重点覆盖：

- 协议严格校验、版本、消息尺寸和私有字段隔离；
- Runtime 无 Electron 依赖、无本地 HTTP Server、无端口监听；新 Chat 在 workspace 归属失败时有界停止并补偿新会话，同时保护已有会话不被误删；
- Runtime 进程握手、请求/响应、会话持久化、并发启动/停止、关闭截止时间内的已接收请求排空和 fail-closed；
- Agent 提案、执行、恢复、拒绝终态以及权限/计划/活动/追踪的增量事件闭环，并验证超过旧查询窗口上限的单批索引 Trace 不丢失，以及索引 segment 暂时不可读时不推进游标、恢复后能够重试投递；
- Main 唯一拥有 Runtime 子进程，Renderer/Preload 不接触 Host 协议；
- Supervisor 请求超时、崩溃退避重启、稳定窗口后的计数清零和退出清理；
- Renderer 模块注册、状态投影、对话滚动、复制动作、中文文案和 Dockview 布局；
- Dockview 标签越过主窗口边界后创建受控 Popout、完成渲染、确认 Popout 没有高权限 Preload/IPC 能力、关闭后回停，并拒绝非白名单外部窗口；
- Provider/Protocol 分离、设置 JSON 迁移、API Key 加密状态与四个独立凭据槽位；
- 模型推理 profile 校验、DeepSeek/Kimi 请求字段映射及厂商私有推理上下文隔离；
- Agent/Companion Run 来源与取消路由、暂停 Run 取消、审批能力子集与作用域、启动前拒绝传播，以及 `run_start` 前取消不产生孤儿会话/消息；
- Companion 会话删除把 Agent 访问 retire 与持久删除意图放在同一事务；权威删除失败时精确恢复提案、会话授权和 Agent 链接，进程中断后按会话存在性收敛，已删除会话先重建向量再确认意图，恢复竞争、存储或重建不可判定会 fail-closed；提交后 `DETACH`/派生向量清理失败只触发连接重建和脱敏诊断，不反转已提交的关系数据删除；
- 稳定工作区 ID/根、读写级别、只读权限上限、文件与终端显式工作区授权、真实路径/Junction 越界约束、终端会话所有权、明确会话删除后的 workspace sidecar 延迟落盘与后续写入自愈，以及 ConPTY helper 配置；
- 桌面偏好系统副作用与持久化的串行提交、失败补偿、损坏状态/设置文件保全失败时的 fail-closed，以及 Runtime 观察者故障隔离。

2026-07-22 当前自动回归已扩展到 Protocol、Runtime、App 的进程生命周期、持久化失败恢复、权限工作区、Renderer 竞态与生产打包边界。精确测试数以命令输出为准，不能替代下述发布门禁。

## Runtime 独立性审计

`npm.cmd run audit:runtime-independence` 只读取 Ariadne 当前工作树，检查所有 `file:` 依赖仍位于项目根内、根发布脚本不引用项目外路径，并拒绝 Runtime 入站 HTTP Server 和端口监听。

完整范围见 [Runtime 独立性审计](Runtime独立性审计.md)。命令会把机器可读 JSON 写到标准输出，任一独立性约束失败时返回非零状态；该审计不替代功能测试、真实窗口或签名发布验收。

## Windows 生产打包

只验证独立 Runtime 生产依赖树与 Node runner：

```powershell
node scripts/prepare-runtime-package.mjs --dependencies-only --arch=x64
```

正式打包命令为：

```powershell
npm.cmd run package:win
```

它会先验证签名环境，再重建 Protocol/Runtime，下载并校验固定版本 Node runner，用独立 lockfile 安装 Runtime 生产依赖，并要求受信任、自包含的 Windows Sandbox helper 和 Transformers Runtime。Electron Builder 被强制要求代码签名；构建结束后会验证安装器、主 EXE 与内嵌 Windows Sandbox helper 的 Authenticode 状态、发布者证书摘要和时间戳，并交叉校验 helper manifest 的文件名、版本、文件哈希与发布者摘要。正式执行前必须由发布环境安全注入应用与 helper 的发布者证书摘要、签名凭据、SignTool 绝对路径及 HTTPS 时间戳服务；不得把证书或实际标识写入仓库。当前开发机只完成了依赖装配和未签名自包含 helper 的构建验证，未生成可发布安装包。

## 真实 Electron 冒烟

`npm.cmd run test:electron` 会先做完整生产构建，再用隔离的临时 `userData` 启动应用。它验证：

1. 主窗口和 Renderer 根节点实际完成绘制；
2. 固定 Runtime Preload 桥存在；
3. Runtime 通过真实子进程 IPC 达到 `ready`；
4. 有可用模型时输入区可用；无模型时禁用输入并显示设置引导；
5. 打开自定义下拉菜单，验证菜单通过顶层 Portal 渲染、根据窗口边界自动翻转或回缩，并保持紧凑选项高度；
6. 验证“打开工作区”和“新建会话”是可见的带文字主操作；通过界面在当前工作区创建会话并从公开协议列表读回，同时验证 Runtime 返回同一 `workspaceId`、工作区会话树的折叠/展开、紧凑行、悬停详情、双击行内重命名和置顶；
7. 使用显式 `workspaceId` 读取文件目录并创建/关闭真实 ConPTY 终端，同时确认未知工作区会被 Main 拒绝；
8. 设置页显示四个远程 Provider、四个独立 API Key 输入框并生成 `settings.toml`；旧 `agent-settings.json` 仅执行一次迁移；
9. Chat 权限菜单显示“请求批准 / 替我审批 / 完全访问权限 / 自定义 (settings.toml)”四档，选择后保存并重启 Runtime；
10. 用户消息保留前后空格与换行，单行气泡不被错误拉高；
11. Renderer 控制台没有 error；
12. 将“对话”模块标签拖出主窗口，验证第二个原生窗口完成渲染、没有高权限 Preload 桥，关闭后模块回到主工作区；
13. 尝试打开非白名单外部窗口并确认被 Main 拒绝；
14. 验证 Popout 与主窗口主题初始一致、实时同步；
15. 保存截图和结构化 JSON 报告，并确认清理后 Electron 正常退出。

输出位于：

- `artifacts/electron-runtime-smoke/electron-runtime-smoke.json`
- `artifacts/electron-runtime-smoke/electron-runtime-smoke.png`

临时 Runtime 数据在验证结束后移入系统回收站，避免污染真实用户数据。

## Windows 原生沙箱

以下工程应使用 Release 配置构建：

```powershell
dotnet build runtime/native/Ariadne.WindowsSandbox/Ariadne.WindowsSandbox.csproj -c Release
dotnet build runtime/native/Ariadne.WindowsSandbox.SmokeTests/Ariadne.WindowsSandbox.SmokeTests.csproj -c Release
dotnet build runtime/native/Ariadne.WindowsSandbox.RunnerSmokeTests/Ariadne.WindowsSandbox.RunnerSmokeTests.csproj -c Release
```

烟雾测试可能修改本机账户、ACL 或防火墙，必须在隔离虚拟机运行；普通开发机只做编译验证。

## 尚未覆盖的发布验收

真实模型回答、工具/权限/计划完整链路、压力测试、原生 helper 正式签名、数据升级/回滚、安装包生成与签名仍是发布前门槛，详见 [Runtime 接入 TODO](Runtime接入-TODO.md)。
