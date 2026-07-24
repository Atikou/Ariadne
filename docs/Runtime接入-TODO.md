# Runtime 接入 TODO 与完成状态

> 状态日期：2026-07-24。`[x]` 表示已在当前工作区实现并验证；`[ ]` 是正式发布前仍需完成的门槛。

## 1. 架构与协议

- [x] 建立 `@ariadne/protocol` 独立 workspace。
- [x] 拆分 Renderer 安全的 Public 协议与 Main/Runtime 专用 Host 协议。
- [x] 定义版本化握手、请求、响应、事件、关闭与公开错误 envelope。
- [x] 对所有入站消息执行严格 schema 校验，拒绝未知字段和畸形消息。
- [x] 限制单条 IPC 消息为 8 MiB，在覆盖公开 2,000,000 字符消息契约的同时拒绝无界消息；公开 DTO 不含 Base64、PID、端口、令牌、密钥和绝对路径。
- [x] 覆盖版本不匹配、消息尺寸、私有字段泄漏和严格解析测试。
- [x] 定义模型通用推理 profile/请求接口，并在 Runtime 侧拒绝不受支持的模式、强度和矛盾配置。

## 2. Runtime 核心

- [x] Agent、模型、上下文、记忆、工具、权限、计划、调度、存储和追踪核心完整维护在 `runtime/src`。
- [x] Runtime 不包含入站 HTTP Server、DesktopHost、网页测试台、运行状态、模型权重或 `.env`。
- [x] 建立 Runtime 独立性审计，发布流程不读取或测试任何外部源码仓库。
- [x] 提供 Ariadne 自带的 Transformers JSONL Worker，并确认项目内本地模型链路不依赖外部应用。
- [x] 建立可由独立 Node 启动的 Runtime 入口和 Node IPC Host。
- [x] 将安装目录、数据目录、模型目录和工作区改为 Host 注入。
- [x] Runtime 不创建本地 HTTP Server，不监听端口，不依赖 Electron。
- [x] 建立最多 32 个并发请求、启动/请求/关闭超时、取消和 fail-closed 行为。
- [x] 将长时间 Agent 执行与单次 IPC 请求解耦：提案/审批先返回已持久化状态，执行、恢复、权限、计划、活动和追踪通过事件持续收敛。
- [x] Runtime 事件桥把持久化 Run 的开始、等待和终态投影为 `run.changed`，长任务在结束前即可出现在 Agent 状态栏。
- [x] Run 到达终态时收敛仍为 pending/running 的活动项，避免取消或失败后工具继续显示“运行中”。
- [x] `CompanionConversationWorkflow.chatStream` 在 `prepareTurn` 前接入 abort；知识检索完成并再次检查取消信号后才创建会话/消息，启动超时不会留下尚未发布 `run_start` 的孤儿数据。
- [x] `deleteCompanionSession` 在同一 Agent 状态事务中 retire 访问并持久化删除意图；Companion 权威删除失败时用精确快照和竞争检查恢复提案、会话授权及 Agent 链接。进程中断后，启动恢复会根据权威会话是否存在选择恢复访问，或在完整重建向量后确认删除。向量索引属于可重建派生数据，清理失败只写诊断并要求重建，不把已提交的业务删除误报为失败。
- [x] 权限拒绝和计划拒绝都会生成终态消息、提案和运行记录，不再把提案遗留在等待状态。
- [x] 合并流式文本事件，避免逐 Token 跨进程刷新。
- [x] 分离 Provider 身份、Protocol transport 与 Model profile；OpenAI-compatible transport 不依赖 OpenAI SDK。
- [x] 本地模型保持 embedded runtime 直接启动，不引入 Ollama、LM Studio、vLLM 或本地 HTTP 服务依赖。
- [x] 为 DeepSeek、Kimi 实现推理参数映射，Kimi 使用 `max_completion_tokens`，并隔离仅供厂商后续轮次使用的私有推理上下文。
- [x] 提供 Windows 原生沙箱工程并完成 Release 构建。
- [ ] 在隔离虚拟机运行会修改账户、ACL 或防火墙的原生沙箱烟雾测试。
- [ ] 完成原生沙箱 helper 的生产签名、发布者信任清单和产物哈希验证。

## 3. Electron App 接入

- [x] Main 建立唯一 `RuntimeSupervisor`，负责启动、握手、请求、事件、有限重启和优雅关闭。
- [x] Runtime 连续重启计数只在就绪稳定窗口后清零；应用退出先完成 Runtime/存储清理，再由 Electron 正常关闭窗口和进程。
- [x] 打开 sandbox/contextIsolation，Preload 只暴露固定 `getStatus`、`request` 和 `onEvent`。
- [x] Renderer 以 `RuntimeStore` 替换 `MockScenarioStore` 和静态 Chat Mock。
- [x] 会话、消息、模型、提案、运行、活动、权限、计划和追踪面板接入真实 Runtime 状态。
- [x] Public Run 标记 Agent/Companion 来源并路由到各自取消命令；等待权限/计划的暂停 Run 会通过拒绝对应申请收敛终态。
- [x] 提案与权限 UI 保留准确能力子集、风险、目标、理由及 once/session/project/workspace 审批作用域；启动前能力/工作区校验失败不会被异步执行误报为成功。
- [x] 修复 Windows 终端使用 Electron 可执行文件作为 ConPTY helper 的退出问题。
- [x] 界面正文与操作统一中文，保留 Agent、Runtime 等必要专业术语。
- [x] 实现 `settings.toml`、旧 `agent-settings.json` 一次性迁移、API Key 系统加密存储、OpenAI/DeepSeek/Kimi/Anthropic 独立凭据配置与保存后 Runtime 重启。
- [x] 持久化稳定的 Agent 工作区根和读写级别；只读工作区同时约束文件服务、公开能力和 Runtime 权限审批上限。
- [x] 统一多工作区导航与桌面能力上下文：文件浏览器和新建/重启终端显式接收 `workspaceId`，由 Main 授权目录表解析；已有终端在导航切换时保持运行，不会被静默迁移或突然终止。
- [x] Chat 随模型切换展示对应推理模式/强度控件；未配置可用模型时禁用输入并引导到设置。
- [ ] 实现文件/图片资源登记表与附件 UI；仍须只传资源 ID，不传 Base64 或私有绝对路径。

## 4. 自动与真实窗口验证

- [x] Protocol 类型检查、构建和 schema 测试。
- [x] Runtime 子进程握手、状态、会话持久化、优雅关闭和畸形协议 fail-closed 测试。
- [x] Runtime/App 端口隔离、Renderer 边界、Preload 最小化和 Supervisor 崩溃恢复测试。
- [x] Runtime 事件桥使用 TraceIndex 增量游标，单次 Trace 突发不再受公开查询窗口上限影响；索引 segment 暂时不可读时整批不提交游标，恢复后重试投递；无索引测试场景保留兼容回退。
- [x] App 模块、布局、消息动作、中文界面和终端生命周期测试。
- [x] 设置 JSON 迁移、凭据不回传、Provider 配置注入、推理映射与实际 Chat stream 集成测试。
- [x] 真实 Electron + 真实 Runtime 冒烟：窗口渲染、主 Renderer Preload 桥、Runtime 就绪、会话创建、Chat 可用/禁用状态、设置页与 JSON 落盘、Popout 创建/主题同步/回停且无高权限 Preload、正常退出、零 Renderer 控制台错误和截图。
- [x] Runtime 独立性审计通过，发布流程不依赖外部 Agent 源项目或其工作树状态。
- [ ] 配置真实本地模型，完成“输入 → 模型流式回答 → 持久化”的桌面全链路测试。
- [ ] 完成至少一个真实工具调用、权限拒绝/一次性允许、计划确认、取消和崩溃恢复的 UI 全链路测试。
- [ ] 做长会话、并发请求、大型工作区索引和长时间运行压力测试。

## 5. 打包、升级与发布

- [x] 建立打包态资源装配：固定 SHA-256 校验的 Node 22.23.1 x64 runner、独立 Runtime 生产依赖锁和 `resources/runtime` 路径。
- [x] 打包前强制重建 Protocol/Runtime，并让生产流水线要求受信任、自包含的原生 helper 与 Transformers Runtime 均存在。
- [x] 正式 Windows 打包在构建前检查签名环境、强制 Electron Builder 代码签名，并在构建后验证安装器与主 EXE 的 Authenticode、发布者和时间戳。
- [ ] 使用正式证书执行原生 helper 签名，并完成 Transformers Runtime 下载后生成实际 NSIS 安装包。
- [ ] 在干净 Windows 机器验证安装包内 Runtime、原生 helper 和本地模型 Worker 的启动。
- [ ] 建立 app/runtime/protocol 兼容矩阵与发布物校验清单。
- [ ] 验证数据库升级、备份、失败回滚和旧版本可读性边界。
- [ ] 验证 Windows 安装、升级、卸载、代码签名和残留进程回收。
- [ ] 在 CI 中运行根级测试、生产构建和隔离环境 Electron 冒烟。

## 完成定义

当前已达到“源码移植和开发态联调完成”。只有第 4、5 节剩余项目全部通过，才能标记为“可生产发布”。
