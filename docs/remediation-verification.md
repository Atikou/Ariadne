# 整改实现与验证证据

本页记录当前整改的实际边界。每项只有实现、正式说明和对应验收都完成后才可认定完成；历史测试和模型验收不代表本次修改已验收。

## 2026-10-05：唯一生产主干清理

状态：清理实现与生产主流程验证完成，安装包验收待发布环境。真实 Windows 通知的完整验收归属 T04，仍未完成。

桌面 `runtime-process.ts` 和 `headless.ts` 使用相同 Kernel Factory、Sandbox Factory 和 `ComposedRuntimeIngress`。Electron Main 的 RuntimeSupervisor 指向该桌面入口。Capability、Agent、UI、Speech 组件生成器提供静态注册；本地 llama.cpp Worker、终端 PTY Worker 和外部 Transformers Worker 由当前 Adapter 绑定。

| 能力 | 当前生产所有者 | 继续保留的验证 |
| --- | --- | --- |
| 会话、消息与 Handoff | Conversation Authority、Conversation UoW 与协调器 | conversation-*.test.ts、handoff 集成与 Electron |
| Run 与恢复 | Agent Core、Agent UoW、Run Work Scheduler | sqlite-agent-run-unit-of-work、work recovery、effect continuation |
| 推理与流 | RuntimeKernelModelInferenceGateway、ProductionExactAgentModelInferenceGateway | exact gateway、follow-up、Provider stream 与恢复 |
| 工具与权限 | 冻结 Tool Catalog、Admission Authority、Tool Execution Dispatcher | admission、effect dispatch、workspace file、MCP |
| Plan、Budget、Child | Agent Core Plan/Budget/Delegation 及当前子任务 Adapter | agent-plan-budget-child-run-sqlite.integration、subagent provider |
| 调度与工作流 | Productivity Authority、Schedule／Workflow／Goal Worker | schedule-durability、occurrences、workflow、goal autonomy |
| 长期记忆与指令 | SqliteLongMemoryStore、ProductionLongMemoryService、Instruction Assembly | memory owner、store、tool authority、instruction assembly |
| 通知 | Main DecisionNotificationSource 与 ApprovalNotificationService | 当前 Decision 元数据、wake 合并、迟到结算、导航；Windows 实验待执行 |

已删除退役 AgentLoop／Orchestrator／Companion／Context／Plan 等执行闭包及反向依赖；当前入口的值导入、类型导入、动态 import 和 Worker URL 重新建立清单。没有以目录名称删除仍在生产闭包中的模块。

删除退役记忆和调度导入 CLI、解析层、导入事务、工程注册及专属测试；删除操作旧存储的 CLI 和未真实执行的自检声明。开发入口直接运行当前 Headless。当前七个业务数据库自己的 Schema 升级、命名规范化、协议存储升级继续保留。来源已是当前 LongMemory 格式的历史记录仍可读取其来源元数据，不能由此导入退役格式。

退役控制格式的识别只读查看已知表是否存在记录，发现后报告不支持。不会读取旧执行正文、转换记录、迁移旧库或删除用户数据。物理隔离测试使用独立 SQLite sentinel，避免因保留旧测试而保留旧 Schema 实现。

旧系统测试的需求按当前所有者核对。旧 Proposal／暂停快照／旧 routing pipeline 等接口专属断言删除；权限、Budget、Child、取消、未知副作用、消息隔离、草稿和安全约束继续在当前生产契约上验证。`retired-test-inventory.json` 保存被移除测试的原始断言标题，测试数量变化必须按该清单解释。

本轮基线：类型检查通过；完整自动测试 1,725 项通过（Runtime 1,169、App 363，其余工作区 193）。第一批清理后类型检查通过；第二批 Runtime 918 项通过，App 366 项通过且 1 项失败。失败是通知定位用了越过所属滚动容器的 DOM API，已改为现有 viewport 几何方法，14 项通知／滚动复验和最终 App 367 项通过。清理后 Runtime 最终 912 项，其余工作区 192 项通过；typecheck、架构／组件目录、Runtime independence、release／persistence contract 和文档文件链接检查通过。

证据位于 `artifacts/todo-remediation/`：`baseline-status.txt`、`baseline.patch`、未跟踪文件基线、`production-reachability.json`、删除清单、旧测试断言清单、逐批 typecheck／test／architecture 日志。该目录为本地审阅证据，不是生产源码、用户数据库或安装包资源。

通知接线现已使用当前 Projection 的 V3 pending Decision 最小目录分页，完整页链校验后才发布待处理集合。Action token 和问题正文不进入 Main 的读取响应。持久去重和真实 Windows 通知验收仍需完成。每 15 秒、Runtime ready、Projection wake 和窗口隐藏时重新核查，抑制解除后可以补读。通知只保留公开标题、稳定引用、类型、状态和版本；不保留私有工具参数或凭据。

真实 Electron 第一次在取消命令返回 command_outcome_uncertain 而失败；独立新数据的第二次完整主流程、强杀边界、扩展功能及 Main 重启通过，70 次确定性 Provider 请求、4 次中断与零 Renderer console error。第二次仅增加了受限 Owner 错误诊断，没有修改取消行为，因此首次取消竞态仍需追踪，不能宣称已修复。证据分别为 electron/ 与 electron-diagnostic/。

首次失败的持久证据显示 Run 为 version 1／running，Attempt 为 intended。Core 在持久开始前允许 Abort 并保持 intended；ExecutionIntent Scheduler 已登记 dispatching，其异常分支却统一报告 crossed boundary。现已修复此契约矛盾：先加入分发、读取精确权威并证明 Attempt 尚未开始，再由原命令所有者提交 run.cancel。结算 Receipt 来自真实 cancelled Attempt 的 before_start 证据。已开始且结果未知的推理仍要求精确恢复证据，不会自动重试。

三个实际 Core＋SQLite＋Scheduler＋取消所有者场景在禁用修复后稳定失败，恢复后全部通过，包括两次并发 Inbox 输入及重启无遗留恢复项。完成先于取消的等待者释放也已验证。最终 Runtime 914、App 367、其余工作区 192 项通过；干净构建、类型检查、架构、独立性、九个 persistence contract、release contract 和文档链接通过。修复后的独立 Electron 主流程、强杀恢复和 Main 重启 gate 通过，证据为 `electron-cancellation-fixed/`；Provider 为确定性 HTTPS 夹具。

另外删除 29 个退役授权／状态、模型路由／截断和 trace 展示文件。当前入口图为 416 个 Runtime 文件，其中 408 个支持入口可达；八个独立无状态工具、当前模型 barrel 和已有独立进程安全实现保留。无未解析本地依赖或非字面量动态加载。

`package:dir` 在可信 Sandbox 发布前失败，原因是缺少 `ARIADNE_SANDBOX_PUBLISHER_SHA256`。没有放宽签名规则；新生成依赖暂存的退役代码及依赖检查通过，但完整安装包和 packaged-runtime 验收仍未通过。日志 `t01-package-dir.log`，因此清理任务保持待验证。继续沿唯一生产主干实现分页投影及其余整改。

## 2026-10-05：投影分页、作用域扫描与有界存储校验

状态：Runtime 查询／存储、Main 通知读取以及 Renderer 客户端接口已实现；Renderer 组合 Store 的订阅缓存、消息窗口与大数据 UI 验收仍未完成。T02 与 T04 保持进行中。

实现细节和长期边界见 [ADR 0035](adr/0035-scoped-projection-reads-and-journal-settlement.md)。九个已有持久契约未修改，新增 V2 Journal、分页只读 V1 和作用域扫描只读 V1 分别冻结并通过守卫。Journal 写入和 Ingress replay 继续按当前公共 Schema 校验。

已移除追加时的全量 `buildSnapshot`；受影响 Head 在覆盖前核对最新持久版本和摘要。启动审计改为逐个 Commit／版本读取，不保留所有历史 DTO；仍检测完整工件、连续版本、来源顺序、Head 和 Checkpoint。分页也校验每行持久摘要。原 8 MiB 标量读取上限保留，超限查询不能使 Store 的写入和分页接口不健康；Renderer 消费者迁移尚未完成，不能以此宣称大数据桌面已可用。

独立容量夹具：100 个会话、10,000 条消息，展示 DTO 序列化 78,060,000 字节。每批追加 100 条消息时，SQL 返回已有行最多 2 行；前十批中位数 31.37 ms，最后十批 26.91 ms。空库打开 10.45 ms，已有数据启动审计 2,368.80 ms。指定会话 100 条消息在固定 C 的七页读取 111.83 ms，并发更新／删除／创建仍不混代；从 C 的作用域扫描读到后续三项变更。重启后新代际包含 101 个实体头和一个墓碑，旧代际明确失效。峰值 Heap 约 170.27 MB、RSS 354.38 MB，属于该 Node 进程夹具采样，未作为真实 Renderer 内存结论。

证据：`t02-projection-capacity.json`／`.log` 保存独立数据根、规模、SQL 查询形状和返回行数；`t02-scoped-owner-tests.log` 为 31 项存储／扫描／真实 Headless 验证；`t02-cross-workspace-integration.log` 为三项 Main／Renderer 客户端与生产查询所有者验证。根项目集成测试放在 `tests/integration`，Runtime 测试未放宽工作区隔离规则。分页中第二页 reset 不返回第一部分待处理集合；作用域增量扫描保留无相关事件的 Cursor，字节截断不会跳过未返回提交。

持续保留全部 Commit、版本和墓碑，尚未执行派生数据压缩或权威历史删除。Renderer 当前生产组合 Store 仍调用旧全局快照和全局增量读取；下一步替换该消费者，不能将分页结果重新拼成受 8 MiB 限制的全应用快照。

本阶段最终全量 Runtime 929、App 367 项通过；干净构建、类型检查、架构、固定及扩展持久契约、release contract、Runtime independence 和文档链接通过。入口图为 421 个 Runtime 文件、413 个支持入口可达、八个保留的独立工具／安全实现；没有未解析导入或非字面量动态加载。移除已无生产消费者的 Journal ingress 类型 barrel，测试直接使用当前 Port。

`electron-t02-query/` 独立桌面 gate 通过主流程、五个 Runtime 强杀边界和 Main 重启，70 次确定性 Provider 请求、四次中断，主流程 Renderer console errors 为空。Main 重启退出阶段仍出现通知同步与 IPC teardown 警告，先前取消修复 gate 也有相同警告；完整通知生命周期验收尚未完成，不能把此结果写成所有进程零错误。当前使用小型桌面夹具，尚未验收 78 MB 数据的 Renderer。

## 2026-10-05：选择性元数据、消息窗口和 Renderer 缓存所有者

状态：T02 进行中。V2 查询生产所有者、Renderer staging／Repository 已实现并验证；`RuntimeStore` 仍调用原全局快照，没有完成桌面接入或大数据 Electron 验收。

新增选择性 Feature 元数据和同 C 的最新／之前／锚点附近 Message 窗口。固定流、范围、摘要、有效期和二进制排序均验证；锚点删除／缺失／跨会话明确拒绝。窗口不超过 128 条或 2 MiB。实际 Headless 和 Renderer 客户端集成调用现行 `AgentProjectionQueries`，没有第二个查询所有者。原九个契约、Journal V2、分页 V1、Scope V1 保持冻结，新增 View V2 有独立基线。

`ProjectionScopeRepository` 完整 staging 后发布，默认三会话／八条目／24 MiB DTO 缓存，单次 staging 和并发 staging 同样有界；保护选中范围，按 LRU 淘汰。相同范围和生命周期的迟到结果不发布；不同 Stream 要求显式失效。每个 Scope＋Feature 选择有独立 Cursor／Digest，空增量正常推进；相关变更标 dirty，由完整新 C 原子替换。reset、摘要漂移、旧扫描和预算拒绝保留最后可信状态。生产组合与全局最小读模型尚未接入，不能以这个模块存在为由宣称 UI 容量整改已完成。

修复持久行校验的合成 Commit 外壳误差。回归提交序列化仅比 1 MiB 上限少一字节，原虚拟 ID 外壳确实超过上限；真实追加、分页和重新打开审计通过。没有提高包限制或放松持久摘要校验。

当前验证：Runtime 全量 937 项通过（`t02-window-boundary-runtime-tests.log`），App 全量 367 项通过（`t02-scope-cache-app-tests.log`）；协议 70 项通过（`t02-window-correlation-protocol-tests.log`）。锚点缺失响应必须关联同一 snapshotId，最新窗口不能返回锚点缺失；协议、独立 staging 和七项 Runtime 窗口回归复验通过。根跨工作区 13 项集成通过（`t02-scope-cache-integration.log`），包含八项 Repository 行为验证和五项 Main／客户端 staging 验证。干净 Runtime 构建、App 三套类型检查、架构、release／九个固定与四个扩展持久契约、Runtime independence 通过，证据前缀 `t02-window-boundary-`／`t02-window-correlation-`／`t02-scope-cache-`／`t02-view-`。最新 Runtime 源文件 423 个、支持入口可达 415 个，八个既有独立工具保留；未解析依赖和非字面量动态加载为零。

容量夹具最新结果（覆盖前一阶段同名 JSON）：78,060,000 字节、100 会话、10,000 原始消息；早期／后期提交中位数 34.02／28.02 ms，已有行读取最多两行；已有库审计 2,374.78 ms，指定会话七页 115.99 ms。选择性元数据 1.85 ms，16 条最新窗口 205.98 ms，9 条锚点窗口 255.27 ms；均为数据库／查询测量，见 `t02-projection-capacity.json`。

同一独立临时库的 Renderer Repository 基准通过（`t02-scope-cache-capacity.json`／`.log`）：24 个会话每次读取 16 条消息，加载中位数 138.70 ms、P95 142.48 ms；缓存始终不超过三会话，DTO 峰值 381,993 字节。淘汰后九条锚点窗口重载 128.58 ms；无变更扫描 1.70 ms；数据库重开 2,272.44 ms，重开后窗口加载 133.88 ms。该 Node 进程采样 Heap 峰值 123,781,528 字节、RSS 378,277,888 字节，包括数据库和启动审计，不能作为 Electron 内存结果。基准只使用经 TEMP 路径及库内夹具来源检查的已生成数据，没有删除或转换实际用户数据。

后续目录读模型与缓存进展见下一节；生产 Renderer 迁移、大数据 UI 验收、T01 可信发布环境、T04 通知生命周期及其余任务均未完成。

## 2026-10-05：最小目录、通知消费者和有界目录缓存

状态：T02 与 T04 仍进行中。V3 查询、Main 通知生产消费者、Renderer 客户端和目录 Repository 已实现；`RuntimeStore` 仍使用全局 snapshot／commits，尚未完成实际 UI 迁移。

同一所有者增加 Session／Run／Decision 最小目录的固定 C 分页、合法状态过滤、稳定排序、全范围统计、显式详情和连续增量扫描。Run 不返回 Inbox／工具活动／交互消息；Decision 不返回问题／选项／Action token。关闭或退出所选过滤的实体以 remove 返回；目录信封自身超限也从实际最后 Cursor 续读。V1、V2、V3 共享 64 个五分钟代际和同一 HMAC 所有者。新增 `PublicProjectionCatalogQueryStoreV3` 的独立基线；原九个固定和四个扩展契约未覆盖，守卫现验证九加五个契约。

Main `DecisionNotificationSource` 完整校验 V3 pending 摘要页链才发布通知读取集合，130 个待处理问题跨页与结算场景验证通过。真实 Headless NDJSON、Renderer 客户端与生产查询所有者集成也通过。协议校验额外拒绝摘要携带正文／令牌、错误状态域、错误数量及跨工作区详情。

`ProjectionCatalogRepository` 每个选择仅保留当前页、全范围统计和独立扫描水位，默认八选择／4 MiB／四个物理在途请求；选中范围受保护。新页在页链、摘要和容量均通过后发布；链 fork 防止失败翻页破坏重试。回退重读同 C 页链并逐页丢弃。相关扫描标 dirty，再由新 C 完整替换；无关扫描只推进水位。并发导航／扫描合并，迟到响应、新流、过期、校验错误和预算失败均不覆盖可信状态。

当前验证：Runtime 全量 943 项通过（`t02-catalog-runtime-tests.log`），随后新增目录自身字节边界的第七项存储回归，目录存储七项通过（`t02-catalog-store-tests.log`）；不将它写成重跑过的全量 944 项。App 全量 367 项通过。最新协议 74 项、根跨工作区集成 23 项通过，其中八项为目录 Repository 的真实 SQLite 集成；见 `t02-catalog-navigation-protocol-tests.log`／`t02-catalog-navigation-integration.log`。目录接线后的干净根构建、App 三套类型检查、架构、release／持久契约、Runtime independence 通过；新增 Repository 后 web typecheck 通过。入口图为 Runtime 425 文件、417 个支持入口可达、八个既有独立工具，无未解析依赖或非字面量动态加载。详细日志前缀为 `t02-catalog-`；最新新增模块的守卫结果记录在 `t02-catalog-navigation-`。

独立目录容量夹具（`t02-catalog-capacity.json`）：100 会话、512 Run，Run DTO 正文合计 75,602,102 字节，原标量读取明确拒绝。四页每页 128 摘要，最大 38,888 字节，单页约 487—511 ms；统计固定在并发结算之前的 512 running。显式详情 148,371 字节／3.42 ms；结算增量仅 1,248 字节且无正文。重开审计 2,520.64 ms，新 active 目录准确为 511。该 Node 进程采样 Heap 254,356,936 字节／RSS 432,513,024 字节，含数据库与审计，不能作为 Renderer 内存结果。

同一临时库的目录 Repository 基准（`t02-catalog-cache-capacity.json`）：四页前进始终只保留 128 行，缓存峰值 38,899 字节；首载 537.01 ms，后续前进约 488—497 ms，回退到第三级页面重读约 1,488.37 ms；无变更扫描 2.25 ms。重开审计 2,462.62 ms，旧代际扫描明确过期，失效后加载 501.42 ms。Node Heap／RSS 峰值 173,049,104／432,865,280 字节，未验证真实 DOM。统计、排序和持久行验证的 JSON 读取开销仍需改进，不能把这些耗时描述成大数据 UI 响应验收通过。

最新实际 Electron gate `electron-t02-catalog/`／`t02-catalog-electron.log` 通过主流程、五个 Runtime 强杀边界和 Main 重启；70 次确定性 HTTPS Provider 请求、66 个响应、四次中断，主流程 Renderer console errors 为空。该 gate 使用小型独立测试数据；不是 75 MB／78 MB 大数据 Renderer 验收，也不是 Windows 通知或真实商业模型验收。当前 Main 重启退出 stderr 仍有 `Decision notification synchronization failed` 和 Runtime request IPC handler 已移除的警告，证据为 `electron-desktop-recovery.stderr.log`；须按 T04 处理并实际复验，不能描述成全进程零错误。

后续生产迁移和当前验收见下一节。

## 2026-10-05：生产 Renderer 作用域迁移与桌面复验

状态：T02 仍进行中；本阶段完成生产消费迁移与小型桌面验证。后续大数据桌面验收见下一节；查询性能、单实体拆分和压缩水位尚未完成。T01—T16 仍按 TODO 的依赖执行，未勾选未完成项。

`RuntimeStore` 现在只使用 `RendererProjectionRepository` 的目录、Session 推理流／Message 窗口和显式 Run／Decision 详情。各范围有独立固定 C、水位和摘要，范围完成后原子发布；会话切换、生命周期和请求票据阻止迟到发布。Session、Run 和 pending Decision 目录每页 128 行，详情最多 16 个／8 MiB；Scope 缓存三会话／八条目／24 MiB，目录缓存八选择／4 MiB。全局统计来自完整选择的目录统计，不把窗口外实体当成不存在。删除原全应用 `ProjectionCache`、七个 Feature Head Store、公共基类及客户端标量快照／全局提交方法；没有为旧测试保留 fallback。

新增 Feature Window V1 沿同一只读所有者读取 models、diagnostics 和 Session inference_streams：最多 128 行、整包 2 MiB、同 C 锚点、合法 filter／Run 归属、摘要与明确 reset。对应独立持久基线已冻结，九个固定契约加六个扩展不被覆盖。当前目录模型／诊断仅首窗，更多数据仍须明确加载和呈现，不能宣称已读取全部元数据。

Message Window 在 SQL 中合并原 Message 权威与 Run interactionMessages，同 C 排序；专用 Message 版本包括墓碑优先，不在 Renderer 再展开全部 Run 历史。读取派生消息核对父 Run 的持久摘要、精确身份与正文。跨会话 outbox 通过指定 Run／Session／inputId／delivery／source 的临时详情证明结算；Decision 通过指定实体的新详情确认关闭／删除，不凭当前页面缺失推断成功。

实际 UI 已接目录翻页、Run 摘要与详情按钮、待处理 Decision 摘要与详情、选中会话历史前窗／最新窗。尚需完成窗口外搜索结果、附近定位、部分范围提示和更完整分页交互。已有会话发送和用户 Session 操作在提交前读取指定 Session 的新版本，每个意图仅提交一次；读取后再发生的并发写入仍由命令所有者拒绝。自动 AI 标题继续使用原版本约束，不能覆盖后来的用户改名。Runtime 恢复期间模型读取未完成显示“正在读取模型”，并禁用发送；验证为空后才显示未配置。

当前证据（路径以项目根为基准）：

- `artifacts/t02-bounded-renderer-integration.log`：九文件／84 项真实 SQLite 与生产 Renderer／查询所有者集成、静态类型检查通过；聊天的 19 项包括图片、流恢复、消息排序、发送 overlay、计划选项、一次标题请求、精确 outbox 重发、恢复、子任务摘要身份和两种取消结果。新增四项验证无关 Feature 引用保持、墓碑后恢复、持久版本跳跃拒绝和模型读取状态。原启动／路由／会话一致性／流与 Feature 隔离断言已迁移后删除旧全局快照测试。
- `artifacts/t02-bounded-renderer-app-tests.log`：App 75 文件／322 项通过，包含当时仍在的七项旧缓存测试；之后已迁移相关不变量并删除旧缓存。删除后的 App 全量与构建须以新的检查结果为准。
- `artifacts/t02-renderer-migration-runtime-tests.log`：Runtime 130 文件／950 项通过；`artifacts/t02-renderer-migration-root-build.log` 干净根构建通过。之后的 App 三套类型检查／构建见 `artifacts/t02-bounded-renderer-app-build.log`。这些构建早于最后的缓存删除与引用保持，后续复验会补最新结果。
- `artifacts/todo-remediation/electron-t02-bounded-renderer/` 和 `artifacts/t02-bounded-renderer-electron.log`：实际小型独立 Electron gate 通过，70 次确定性 HTTPS 请求／66 响应／四次中断；图片、会话重命名／归档／恢复、补充输入、Renderer reload、问题／权限、五个 Runtime 强杀边界和 Main 重启均通过，Renderer console errors 为空。该构建已使用分页生产消费与模型读取状态，早于最后的无关 Feature 引用优化／无消费者源码删除。失败的前两次 Session 版本复验和第三次恢复状态复验保留在 `electron-t02-renderer-ranges*`／`electron-t02-session-mutations`，未改写成通过。

删除后 App 全量 74 文件／315 项、三套类型检查和构建通过，见 `artifacts/t02-retired-cache-app-tests.log`／`t02-retired-cache-app-build.log`；架构和九固定加六扩展 release 契约通过，见 `t02-retired-cache-architecture.log`／`t02-retired-cache-release.log`。旧缓存不变量分别由真实持久所有者、作用域／目录协议、生产 Renderer 验证，未通过单纯减少测试获取结果。

后续搜索修正直接呈现 `conversation.sessions.query_result`，不再与当前目录页交集而丢失窗口外会话。最多四个工作区查询在途、每工作区 50 项、仅保留 128 项，达到边界明确提示缩小查询；查询代际变化停止后续批次。点击先验证不可变 Message reference，再加载真实 Session 和附近 64 条消息；返回引用错配、删除或当前消息版本变化明确拒绝，不回退无关最新页。Chat 在附近窗口完成后居中锚点并停止自动追到尾部。此路径已接生产 UI，但尚未执行其大数据桌面交互验收。

最新检查：`artifacts/t02-search-window-integration.log` 为十文件／87 项及集成静态检查通过；`t02-search-window-app-tests.log` 为 App 75 文件／317 项通过。`t02-search-window-app-build.log` 为搜索组件后的构建；随后不可变引用相关性守卫补充后，三套 App 类型检查仍通过（`t02-search-window-app-typecheck.log`）。最新架构／热点守卫（Chat 881／930，原预算未提高）及文档链接通过。对应根集成覆盖真实目录第 150 个会话的窗口外结果、100 条历史的附近锚点、失效引用及错配引用；App 搜索测试覆盖并发／缓存上限与取消继续读取。

小型 Electron 不代替大数据桌面验收；后续结果见下一节。Windows 系统通知、真实商业 Provider 或可信签名安装包仍未验收。该小型 Main restart stderr 的 notification 同步和七次已移除 IPC handler 警告仍须在 T04 生命周期处理和复验。单个过大详情拆分、模型／诊断更多窗 UI 和安全回收水位仍属于 T02。

## 2026-10-05：真实 Electron 大数据容量验收

`scripts/benchmarks/projection-electron-fixture.mjs` 在全新命名 TEMP 目录通过当前 Conversation authority、Handoff UnitOfWork、失败结果所有者和实际 Public Projection Publisher 生成 150 个会话，其中 100 个各有 100 条消息，总计 10,000 条、82,766,850 字节公开展示 DTO。标题和正文明确标记模拟数据；所有 5,000 个 handoff 已结算，待发布 outbox 为零，不发起模型执行。夹具不直接伪造数据库正文，不修改真实用户数据。

第一次实际桌面启动失败，发现 `PublicAgentObservability.start()` 仍调用全局标量快照。现改为持久化适配器的 `readPublicAgentObservationHeads()`，只读其最多 512 个当前诊断 Head，验证持久摘要、身份与版本；超出数量明确失败。重启去重测试将标量读取改成拒绝，证明恢复不再依赖全历史快照。失败日志保留在 `t02-capacity-electron.log`／`electron-t02-capacity-run/`，未改阈值掩盖错误。

`scripts/electron-projection-capacity.ps1`／`npm run test:electron-capacity` 使用真实 BrowserWindow、preload bridge 和实际 Runtime。仅在独立 smoke 模式安装请求元数据观察器；原所有者、commandId、Signal、结果与拒绝原样传递，一次调用只委托一次，不保留 DTO。测试操作生产 DOM：128＋22 行会话目录、64 条最新／36 条更早消息、返回最新、目录外会话搜索、不可变引用附近 64 条与实际可见锚点、24 次会话切换、10 次持久重命名写入期间的旧 C 两页读取。随后强杀 Runtime，恢复同一会话；强杀 Main 后同数据重开，再完成以上路径。每次切换消息数量固定 64，DOM 固定 3,039 个元素。

最终 Windows PowerShell 5.1 实际运行通过，证据：`artifacts/t02-capacity-electron-final.log` 和 `artifacts/todo-remediation/electron-t02-capacity-final/` 下 baseline／initial／main-restart 的 JSON、截图与进程采样。观察器到 UI 就绪：空库 1,024.6 ms，大数据 9,591.4 ms，Main 重开 9,597.5 ms；24 次切换合计 8,043.4／8,078.1 ms，目录外搜索并居中 1,143.4／1,092.3 ms；10 次写入加固定边界验证 487.8／468.9 ms，Runtime 强杀恢复 10,913.7 ms。采样包括观察器开销，不能当作无观察器基准。

两轮 Renderer 堆内存约 38.6—77.0 MiB，随 GC 回落；Runtime RSS 空库单次采样 230.1 MiB，大数据采样峰值 691.8／698.2 MiB。空库仅一个 Runtime 样本，不能当作完整峰值。Main／Renderer／GPU working set 与峰值分别保存在 JSON，不能与 JS heap 混写。Runtime 启动／重放的内存增长仍需归属分析，不能据此宣称性能整改完成。

全部 Runtime bridge 查询均记录；没有 `projection.snapshot.get` 或 `projection.commits.read`。目录最大 37,456 字节，消息窗口最大 540,343 字节；所有 Projection 响应均小于 2 MiB。最新检查为 Runtime 130 文件／950 项（`t02-capacity-runtime-tests.log`）、App 76 文件／318 项（`t02-capacity-app-tests.log`）、根实际 SQLite 集成十文件／87 项及静态检查（`t02-capacity-integration.log`）、三套 App 类型检查和构建通过。架构／原热点预算、九固定加六扩展 release 契约和文档链接通过（`t02-capacity-architecture.log`／`t02-capacity-release.log`／`t02-capacity-doc-links.log`）。观察器测试验证委托、错误和元数据副本，不代替真实桌面。

本阶段结束时 T02 仍进行中：512 大正文 Run 的目录统计／排序仍有约 500 ms JSON 开销，后续优化见下一节；超大单实体详情拆分、安全回收水位、模型／诊断更多窗 UI 和 Runtime 启动内存优化尚未完成。大数据 Main 重开退出仍记录一次 `No handler registered for ariadne:runtime:request`，T04 未完成。此次容量路径不验证真实 Windows 通知、Windows 中文输入法、商业 Provider 或签名安装包。

## 2026-10-05：有界目录元数据与完整性复验

当前目录查询以固定 C 的持久 Header 扫描替换全文 JSON 的统计／排序路径。新增最多 4 MiB／4,096 项的 `SqliteProjectionCatalogMetadataCache`，只保存已校验版本的摘要和 Header，不保存 Inbox、交互消息、工具正文、问题和 Action Token。启动审计以已有验证结果初始化当前 Head；成功提交后才发布新增摘要。缓存 miss 读取同一个精确持久版本并完成原摘要校验，淘汰不删除历史。

每页临时候选最多 `limit+1` 行／2 MiB（插入一个当前有界行后即裁剪），所有权 memo 最多 128 项。同一 C 的计数、过滤与二进制 ID 顺序不变；单次追加只处理本提交。页查询前后校验 SQLite 连接 `data_version`：当前只有一个独占写入所有者，其他连接修改正文，即使 Header／摘要未改也会触发完整性拒绝并锁存不可用，不能继续返回旧缓存。显式详情仍读取与验证正文。没有新增物理表／索引、修改 Schema、修改公开结果或覆写固定契约。

五项新增 Runtime 验证覆盖热读／重开无全文 miss、返回值修改不影响缓存、失败事务／旧 C、正文单独漂移导致拒绝、条数与字节淘汰。Runtime 全量 130 文件／955 项及根实际 SQLite 集成十文件／87 项通过；App 最新 76 文件／318 项及三套类型检查／构建通过，见 `t02-catalog-metadata-runtime-tests.log`／`t02-catalog-metadata-integration.log`／`t02-catalog-metadata-lifecycle-app-tests.log`／`t02-catalog-metadata-lifecycle-types.log`／`t02-catalog-metadata-lifecycle-final-build.log`。架构和原热点预算通过。

新基准保存到独立 JSON，未覆盖旧约 500 ms 证据：`t02-catalog-metadata-capacity.json`（100 会话、512 Run、75,602,102 字节正文）四页各 128 行、约 42.97／39.71／39.27／38.97 ms；页最大 38,888 字节，2,048 次摘要命中、零全文 miss，缓存 278,752 字节；四 Run 追加中位数 15.67 ms，显式详情 148,371 字节／3.93 ms，重开完整审计 2,568.67 ms。`t02-catalog-metadata-repository.json` 为实际 Renderer 模块的 Node 验证：前进约 39—62 ms、回退重读三页 122.19 ms、重开页 40.25 ms，一页缓存峰值 38,899 字节。冷查询仍可能读取被淘汰的版本，Header 扫描仍随目录规模增长，不作无限规模的延迟承诺。

实际大数据桌面复验 `electron-t02-catalog-metadata/` 功能通过，但首次启动多一次 Runtime 退出，恢复到 UI 25,228.4 ms；该不稳定证据保留，不能称为原因已解决。随后增加仅含时间、availability 和握手超时标志的生命周期记录，并在 gate 中拒绝故障注入之前的崩溃、额外崩溃与握手超时。原请求与监听器继续一次委托，不保留诊断正文；测试验证监听转发和最小记录。

最新 `electron-t02-catalog-metadata-lifecycle/`／`t02-catalog-metadata-lifecycle-electron.log` 三阶段通过：空库 1,042.8 ms，大库 9,579.1 ms，Main 重开 9,620.3 ms；注入前无崩溃、无握手超时，强杀 Runtime 对应一条 crashed→restarting→ready。24 次切换约 8,045.9／7,987.4 ms，10 次写入与固定 C 约 373.5 ms，Runtime 恢复 10,702.4 ms；Runtime RSS 峰值 678.9／667.4 MiB。这只验证 10,000 条会话消息的真实窗口，512 个大 Run 的性能仍来自上述 Node 基准。Main 退出 IPC handler 警告仍须 T04 处理；启动偶发退出的原因、超大详情、更多窗 UI 和回收水位仍未完成。

## 2026-10-05：真实 Runtime 启动归属与审计资源边界

实际容量 gate 的 Runtime 入口新增可选私有阶段观察，经同一 Ingress、Factory、持久化组件和 Projection 固定点启动，不替换执行路径。普通启动没有 trace sink；只有明确容量 smoke、直接命名 TEMP 夹具和匹配物理 `runtime` 目录可以写入证据。Windows 使用原生物理路径解析统一短路径／完整路径身份。每个进程最多 128 个阶段点，只含固定阶段名、PID、耗时与 RSS／heap／external／arrayBuffers 数字；ready／failed 关闭文件，不记录正文、路径、凭据或业务引用。Main 的 availability／握手超时记录继续独立校验，证据观察没有放宽 15 秒握手时限。

`scripts/benchmarks/runtime-startup-attribution.mjs` 汇总阶段间隔和真实进程采样，输出为新 JSON 且拒绝覆盖已有报告。阶段点 heap 最大值不是连续堆峰值；Runtime RSS、Runtime heap 与 Renderer heap 不能混为同一指标，也没有强制 GC。改动前的实际三阶段结果为 `electron-t02-startup-attribution-recheck/`／`t02-startup-attribution-baseline.json`：首次 UI 9,578.8 ms、Main 重开 9,595.4 ms；Projection 审计约 3,837.9—4,062.4 ms，首次权威重放约 4,298.5—4,797.9 ms，其余模型初始化远小于这两个阶段。入口／静态模块加载在 processElapsedMs 中单独可见。

审计循环原来每个 Head 编译一次 latest-version SQL、每个 Source 编译一次 latest-commit SQL，并把两份完整 `dto_json` 再次转义成 JSON 后比较。现按固定语句集合复用这两个只读查询，并精确比较全部九个持久字段。Commit Schema、安全载荷、原持久摘要、全局链、来源顺序、连续版本、Head、Checkpoint 和数量校验全部保留。新增实际 SQLite 验证 257 个 Head 的完整审计编译不超过 16 个语句，正文单独漂移仍拒绝；原损坏矩阵继续通过。

改动后 Windows PowerShell 5.1 的 baseline／initial／main-restart 实际通过，保留于 `electron-t02-startup-audit-bounded/`，日志 `artifacts/t02-startup-audit-electron.log`，汇总 `t02-startup-attribution-audit-bounded.json`。UI 可用约 1,056.7／9,294.8／9,278.1 ms；首次与 Main 重开审计约 3,506.1／3,520.9 ms，首次重放约 4,332.7／4,297.2 ms，强杀恢复重放约 4,610.0 ms。没有注入前崩溃、握手超时或额外重启，目录／历史／搜索／固定 C／24 次切换仍通过。该样本启动约缩短 0.3 秒，不宣称所有机器都达到相同改善。Runtime RSS 采样峰值仍约 685.7／650.6 MiB；阶段点 heap 最大值约 474—488 MiB，内存增长没有因此解决。此前约 25 秒启动的偶发退出原因仍未确认。

首次新增观察器的实际空库启动失败因短路径身份误判，见 `electron-t02-startup-attribution/`／`artifacts/t02-startup-attribution-electron.log`；它发生在观察器打开之前，已经明确定位并由原生路径解析和包含物理长路径的测试修复。该失败不归并为此前未定位的额外退出，也不删除证据。

最新验证：Runtime 131 文件／960 项全量、相关五文件／73 项、根实际 SQLite 集成十文件／87 项及静态检查通过，见 `artifacts/t02-startup-audit-runtime-tests.log`／`t02-startup-audit-owner-tests.log`／`t02-startup-audit-integration.log`。Runtime 干净构建、架构／原热点预算及九个固定加六个扩展 release 守卫通过，见 `t02-startup-audit-build.log`／`t02-startup-audit-architecture.log`／`t02-startup-audit-release.log`；App 源码未改，保持上一节的 318 项、类型及构建证据。当前只新增有界私有观测和审计资源优化，没有改物理布局或公开契约。超大实体分块、更多窗 UI、安全回收／升级重建、偶发退出和 Main 退出 IPC 警告仍未完成，T02 保持进行中。

## 2026-10-05：超大 Run 分块基础与同一 Core 映射

新增独立 document 1.0 协议与 Runtime `RunDocumentPlan`，根摘要和三个集合 Merkle root 绑定 Run／版本；每项按 canonical UTF-8 分为 256 KiB 原始块，叶整包小于 512 KiB。描述符绑定完整项／块摘要、覆盖字节、项身份、序号与版本；客户只在同一个明确请求项完整后解码，未读齐不返回半个 JSON，不拼接完整 Run。新交互沿当前受保护解析器的 1 MiB 字符界限，旧 DTO、单 Commit 上限和冻结契约未改变。准备索引保留当前 Run 的身份／哈希，元数据仍随该 Run 大小增长，不宣称生产存储索引已实现。

旧 `projectAgentRunV3` 与新 `projectAgentRunDocumentV1` 共享同一 Core 校验、字段映射、脱敏、稳定身份和时间语义，避免新造另一套运行状态。旧 Schema 对超长交互仍拒绝，新表示保存完整内容。写端编码前和读端恢复后均校验明文安全；测试构造恶意发送者重算全部摘要的有效编码，读端仍拒绝凭据内容。其他检查覆盖完整恢复、缺块／乱序／重复、字节／Merkle 篡改、版本／会话错配、精确 queued／claimed 计数、空集合及准备后的来源变更。

证据：`artifacts/t02-run-document-projector-tests.log` 两文件／22 项、`t02-run-document-runtime-tests.log` Runtime 132 文件／966 项、`t02-run-document-protocol-tests.log` 协议 10 文件／74 项、`t02-run-document-integration.log` 根实际 SQLite 集成十文件／87 项及静态检查通过；类型、Protocol／Runtime 干净构建、架构和九固定加六扩展守卫见 `t02-run-document-*-types*.log`／`t02-run-document-*-build*.log`／`t02-run-document-architecture.log`／`t02-run-document-release.log`。

`node scripts/benchmarks/run-document-plan.mjs` 新 JSON `t02-run-document-plan.json` 明确标记仅 Node 读模型：源 6,003,812 字节，根 845 字节，17 Inbox／一条约 2.6 MB 正文，共 27 叶、最大 350,286 字节，18 项完整恢复；准备约 26.9 ms，逐项读取恢复约 433.4 ms，heap／RSS 采样约 99／191 MiB，不是连续峰值。没有权威写入、SQLite、IPC、模型或真实窗口。生产 Publisher 仍调用旧 DTO，旧格式超大提交目前仍会失败，不将该基准视为生产验收通过。

接线与升级要求见 [ADR 0036](adr/0036-multipart-run-projection.md)：同一 Projection 库版本化事务存储、完整准备后原子发布根／版本／C／Source、水位与 Outbox ACK、固定 C 集合／项查询，以及明确部分范围的 Renderer 消费。尚未改物理 Schema／布局或当前传输命令；迁移、重建、旧游标、窗口、系统通知和其他任务均待完成，T02 不勾选。

随后将独立项元数据摘要纳入叶与 Merkle 根，增加不读取 content 的元数据证明。Inbox 的 identity／version／delivery／state／source 被同一不可变文档绑定；篡改投递或状态拒绝，恢复完整项时也核对同一 metadata digest。最新 Runtime 132 文件／967 项、相关两文件／23 项、协议 74 项、根实际 SQLite 集成 87 项及静态检查通过，见 `artifacts/t02-run-document-metadata-runtime-tests.log`／`t02-run-document-metadata-proof-tests.log`／`t02-run-document-metadata-protocol-tests.log`／`t02-run-document-metadata-integration.log`；Protocol／Runtime 构建与架构通过。新独立 JSON `t02-run-document-plan-metadata.json` 最大叶 350,381 字节，27 叶／18 项完整恢复；prepare／restore 约 27.2／485.7 ms，旧 JSON 保留。生产接线仍未启用，不能从元数据证明测试推断发送结算的生产消费者已经迁移。

### T02：SQLite 文档准备区候选与迁移副本

新增 `RunDocumentDbSchema` 候选升级与 `SqliteRunDocumentPreparation`，只操作调用者持有的同一 Projection 连接。生产打开器与固定布局仍是 Schema 3，候选升级尚未激活。独立副本先完整审计 3 版，再事务增加三张准备区表、4 版迁移记录和 user_version；旧 Commit／版本／Head／墓碑／Stream／Source 水位逐行保留。异常回滚全部 DDL／账本；原 3 版恢复副本能由现有生产 Store 重开。

根状态 preparing／prepared 不等于公开可见。每个完整项在明文／Schema／Merkle 验证后短事务保存，重试核对精确根和已有字节，不覆盖冲突；任何外部 SQLite 提交由 data_version 拒绝，包括保持所有摘要字段的正文改写。读取精确元数据不选择 BLOB，项／叶索引也必须匹配证明。范围外返回空，已声明覆盖内缺失拒绝，不能虚构不存在。仍没有最终公开 Commit／Run 版本／全局 C／Source 推进或 ACK，没有新 IPC、消费者或 UI。

证据：`artifacts/t02-run-document-sqlite-fence-tests.log` 三文件／31 项，其中八项实际 SQLite 测试；`t02-run-document-sqlite-fence-runtime-tests.log` Runtime 133 文件／975 项；`t02-run-document-sqlite-fence-integration.log` 根类型检查及十文件／87 项通过。Runtime 干净构建、架构、Runtime 独立性 739 文件、九固定加六扩展 release 守卫分别见 `t02-run-document-sqlite-fence-build.log`／`t02-run-document-sqlite-architecture.log`／`t02-run-document-sqlite-independence.log`／`t02-run-document-sqlite-release.log`。App 此前 `t02-run-document-app-build.log` 包含 node／web／tests 三项类型检查与完整构建，通过不代表新分块窗口验收。

`node scripts/benchmarks/run-document-sqlite.mjs t02-run-document-sqlite-fence.json`：独立命名 TEMP 候选库保存 6,003,812 字节模拟源、根 845、27 叶／18 项完整恢复，最大叶 350,381、原始 BLOB 262,144 字节；准备持久化／验证约 429.9 ms，逐项读取／恢复约 859.3 ms，heap／RSS 采样约 112／221 MiB，不是连续峰值。准备中断后 prepared 根不可读，关闭重开后重试完成，公开 Commit 与 Source checkpoint 均零；原库和 fsync 恢复副本保留。旧 `t02-run-document-sqlite.json` 也保留。这不是 Core 权威写入、最终提交、进程强杀、IPC、模型或 Renderer 验收。

下一步以 ADR 0036 为约束实现显式文档 Commit 的最终事务和 version-aware 审计／查询，接固定 C 的精确元数据与完整项读取、Outbox ACK 和全部实际消费者。随后才能激活正常 Schema 升级并复验旧 C／大 Run／进程强杀。T02 与其他未验收项保持未完成，TODO 保留，不关机。

### T02：同一最终事务、双表示审计与 Windows Node 强杀

独立 Commit 6.0 第一项为真实 Run 文档根，Source cursor 与 Run 版本／时间绑定，其余仅同一 Run／Session Decision，拒绝重复和越界。旧 Commit 5.0、完整 DTO、1 MiB 提交上限与固定契约不改。普通 Store append 提取为同一个事务函数，候选文档发布借用同一所有者连接；完整正文／索引验证后，由短事务一起推进 Commit、Run／Decision 版本／Head、Source 和 published_cursor。提交前失败回滚全部可见产物，提交后响应丢失重用原 C。当前 5.0 未 ACK 事件通过完整旧 DTO 派生根、核对全部 Decision 和事件身份字段后等价重放，不改原历史或伪造 6.0 发布。

全历史审计识别两种表示，正文逐项完整校验，不只信根／索引中的摘要。Web Crypto 与 Node 同步 SHA 使用同一生成式验证步骤和组装器，未复制 Merkle／明文安全算法；跨块元数据摘要也必须一致。任何外部 SQLite 提交在准备、最终验证或后续版本入口被拒绝。旧 read 遇新表示明确 reset，旧 scalar snapshot 明确升级错误；实际 Store 测试证明该错误不锁存成全局存储损坏，后续模型 Head／Source 读取可用。生产 Publisher、正常 Schema 打开器、fixed-C 新查询与全部消费者仍未接入，T02 未完成。

证据：`artifacts/t02-run-document-publication-legacy-read-recheck.log` 五文件／66 项（文档发布九项），`t02-run-document-publication-runtime-complete-tests.log` Runtime 134 文件／984 项，`t02-run-document-commit-protocol-tests.log` 协议 11 文件／78 项，`t02-run-document-publication-app-tests.log` App 76 文件／318 项，`t02-run-document-publication-integration.log` 根类型与实际 SQLite 十文件／87 项通过。Protocol／Runtime／App 构建与三项 App 类型检查通过；架构、743 文件独立性和九固定加六扩展守卫见对应 `t02-run-document-publication-*` 日志。旧读取测试首次失败来自错误的测试函数名，修正为实际公开 Source 查询后通过，失败日志保留。

`node scripts/benchmarks/run-document-publication.mjs` 新 JSON `t02-run-document-publication.json`：两个具名独立 TEMP 候选库，真实 Windows Node worker 在 COMMIT 前／后检查点 SIGKILL。重开分别零／一个公开提交；重试保持 C=1，后者 replayed=true，再写下一版本为 C=2，Source=2；旧已发布交互正文仍精确完整恢复，完整性／外键通过。源 6,003,818 字节、最大叶 350,381；原测试库与旧 JSON 保留。没有 Core 权威写入、Outbox ACK、Runtime/Main 强杀、公共 fixed-C manifest/query、模型或窗口验收，不把内部 worker IPC 算作 Runtime 公共接口验收。

下一步接 fixed-C 根、集合元数据、精确 Inbox 与完整项查询，再将 Publisher／Outbox ACK、消息／搜索／通知／Renderer 全部迁移为真实部分覆盖。最后才启用正常 3→4 升级、双版账本和物理布局，复验大实体权威写入／旧 C／Runtime/Main／UI。完整 TODO 与关闭计算机条件仍未达成。

## 2026-10-05：固定 C 文档根、元数据与单块查询

候选 document-query 1.0 与 `SqliteRunDocumentQueryReader` 借用原 Store 连接、Catalog 快照租约和 data_version 围栏，提供文档根、连续元数据页、精确 Inbox 与单块正文。只接受精确 Session 的未过滤 Run manifest；正文引用绑定快照、C／边界摘要、Run／版本、documentDigest 和 version Commit，页游标再绑定集合／后续序号／页号／前页摘要。当前根必须在同一 C 已发布；准备区未发布版本不进入查询。新版本及 Session 工作区变更不改变旧 C 的根和完整正文；跨 Session／代际／版本、伪造或 TTL 到期明确拒绝／reset。

元数据页双界为 128 行／2 MiB，查询只选择元数据、描述符与证明，SQL 不读 BLOB。客户验证根、所有元数据证明、连续页链和整包摘要；完整项读取才逐块使用最多 256 KiB 原始内容，仍只组装一个明确请求项。否定结果也校验原请求身份。精确 Inbox 核对输入 ID、版本、delivery、state、source；缺声明覆盖的项／块不得解释为不存在。查询前后检测外部提交，即使它仅改正文也拒绝返回根或否定 Inbox 结果。

当前系统原 5.0 小 DTO 可以在同一 C 临时派生文档；旧可选 runId 由父 Run 归属推导，提供其他 Run 仍拒绝。原 1 MiB 边界、Schema 3、事件／提交／摘要／水位保持原样，不新增准备表或写历史。6.0 根的 catalog 页只缓存摘要，原 4 MiB／4,096 项限额不变。候选新查询端口未冻结，九固定和六已发布扩展仍是原基线；Catalog 增量遇到 6.0 仍 reset，消息窗口和所有公共消费者尚未迁移。

七项实际 Store 测试覆盖多块旧正文完整恢复、后续 Run／Session 变更下旧 C、140 Inbox 连续分页／证明、metadata SQL 不选择 BLOB、精确 source、空集合、乱序／重算包摘要后的篡改拒绝、跨 Session／快照／集合／版本、TTL、缺块、未发布准备不可见、外部正文改写、Schema 3 保留和重开后租约失效。协议新增三项验证根摘要、否定结果绑定与空集合完成。首轮根响应比较 request.document=undefined 的失败已修正比较条件，日志保留。

证据：`artifacts/todo-remediation/t02-run-document-query-runtime-complete-tests.log` 为 135 文件／991 项；`t02-run-document-query-protocol-tests.log` 为 12／81；`t02-run-document-query-related-tests.log` 为六／47；`t02-run-document-query-app-tests.log` 为 76／318；`t02-run-document-query-integration.log` 为十／87 且含集成类型检查。Runtime 与 App 构建、应用 node／web／tests 类型检查、架构、Runtime 独立性 746 文件和九固定加六扩展守卫通过。最后统一根／否定／reset 结果的 Schema、安全与字节校验后，`t02-run-document-query-final-result-build.log` 和 `t02-run-document-query-final-result-tests.log` 再次构建、47 项通过；全量测试没有无因重跑。相关构建日志 `t02-run-document-query-runtime-build.log`／`t02-run-document-query-app-build.log`，守卫日志 `t02-run-document-query-architecture.log`／`t02-run-document-query-release.log`／`t02-run-document-query-independence.log`。

本轮仅当前所有者的 SQLite／协议／集成验证；没有 Runtime 公共 IPC、Core 权威写入／Outbox ACK、真实 Provider、Main 强杀或窗口验收，不扩大此前 Node SIGKILL 和实际 Electron gate 范围。生产 opener／布局仍为 Schema 3、Publisher 仍使用完整旧 DTO。下一步实现 version-aware 目录增量与合并消息元数据窗口，明确旧 Message／根内交互版本及墓碑优先级；随后接命令／preload／Renderer 部分覆盖、精确 Inbox 结算和通知，再接唯一 Publisher／提交后 ACK，最后激活正常升级并做大 Run 的真实权威、旧 C、Runtime/Main 和 UI 验收。更多窗、安全回收水位、启动内存／偶发退出及其余 TODO 均未完成。

## 2026-10-05：同链双表示目录增量摘要

原目录增量先执行完整标量读取，6.0 提交必须 reset，且完整正文决定了目录扫描的批容量。现由 `SqliteProjectionCatalogCommitReader` 在原 Store 连接直接流式读取原 5.0／6.0 提交，仅保留请求数量（最多 256）及 2 MiB 的摘要结果；逐次解析一个受原 1 MiB Commit 限制的记录，不选择 document items／leaves，不放大正文进目录。删除被替代的 DTO batch 转换函数。内部存储格式与 Catalog V3 的摘要响应分别校验，输出仍使用原 payloadDigest／history digest／事件／Source 与全局连续 C，不能把 6.0 原提交改写或伪称为 5.0；没有目录变更的提交保留空 changes 位置。旧 scalar read 的契约 reset 保留。

当前成员返回符合过滤条件的摘要，转出原 Session／工作区／过滤条件或产生墓碑时向旧目录发 remove；完全无关的所有者不会泄露摘要。前归属仅读取原不可变版本的有界目录元数据缓存。Session 工作区移动／删除／恢复会影响未改变版本的全部 Run／Decision，依赖范围目录明确 scope_mismatch 并重取快照；恢复须识别直接前版本的墓碑，不能借更早非空版本认为归属没变。全局无工作区任务目录仍连续推进，Session 自身的工作区目录发单实体移除。游标边界、原摘要、连续性、读前后 data_version 和原历史链接验证保留；目录与 scalar／审计共用同一链接校验函数。

七项实际 Store 测试覆盖混合原摘要、逐页与无关位置、过滤移除、存储中多兆完整正文不进入响应且查询不读分块表、Run／Decision 转移后旧 Session 移除、不泄露新 Session 摘要、工作区移动／删除后同工作区恢复重取依赖目录、原文档墓碑、游标／摘要差异、外部正文修改和历史链接损坏锁存。`t02-document-catalog-runtime-tests.log` 全量 136 文件／998 项通过；`t02-document-catalog-app-tests.log` 76／318；`t02-document-catalog-integration.log` 十／87 并含集成类型检查。`t02-document-catalog-build.log`、`t02-document-catalog-types-recheck.log`、`t02-document-catalog-architecture.log`、`t02-document-catalog-independence.log`（747 文件）、`t02-document-catalog-release.log` 通过。日志位于 `artifacts/todo-remediation/`；初次类型检查的可选 sessionId 错误保留，现工作区成员严格要求真实 Session，未补造归属。新七项中的恢复场景随最终全量验证通过。

协议及 App 源码／接口未改，保留此前协议 81、应用类型与构建证据；九固定与六既有扩展冻结基线未改，生产 opener／布局仍 Schema 3，唯一 Publisher 仍使用完整旧 DTO。现有 Renderer 的 reset 信号进入新同步代际，但本轮没有新文档 Runtime IPC、Core 权威发布／ACK、真实模型、Main 强杀或窗口验收。下一步接同 C 合并消息元数据窗口与附近定位，正确处理旧 Message 与 Run 文档内交互的同身份版本及墓碑隐藏，再接公共命令、preload、Renderer 部分覆盖、精确 Inbox 结算与通知；随后生产 ACK／升级与实际大实体恢复验收。安全回收水位、更多窗、启动内存／偶发退出和其余 TODO 继续保留。

## 2026-10-05：同 C 合并消息元数据窗口与显式正文

候选 message-metadata-query 1.0 使用文档查询的同一 Session／all Run Catalog C，提供 latest／before／around 合并窗口，最多 128 行／2 MiB。独立 Message、当前 5.0 Run 内交互和已发布 6.0 文档元数据共同排序，锚点及 hasEarlier／hasLater 以同一不可变 C 查询。独立 Message 在 C 前出现过即拥有身份，最新墓碑或其他 Session 归属隐藏文档副本，不能按数值版本复活副本；不同 live Run 仅共享交互 ID 而没有独立 Message 时明确歧义拒绝。否定结果和空窗仍绑定原 manifest／描述符，不把缺覆盖解释成缺消息。

SQL 在返回／排序前剥离 content，新文档仅选择元数据索引与证明，不读 BLOB；只验证被选中的旧 Run，在本次请求内最多保留四个受原 1 MiB Commit 保护的父文档。窗口完成后不存正文缓存，SQL 对全体候选的排序／查重和启动完整审计成本仍需要实际容量分析，不声称恒定整机内存。文档 item 索引／publication link 不完整时即使负查询也失败；所选证明错误按持久化损坏锁存。旧正文窗口遇当前 Session 非空 6.0 根明确 contract_mismatch，模型 Head 仍可读，不返回缺失交互的假完整结果。

独立 Message 元数据给签名正文引用，绑定快照、C／摘要、Session、Message／版本、Commit、原 change digest、projectedAt 与 metadata digest。显式读取单个原小 DTO，客户端核对正文派生元数据、原完整 change digest 和包摘要。文档交互给根／引用与项证明，沿单块／单项组装接口读取，长正文不会伪装成旧 100k 字符 Message DTO。模拟正文 900,000 个 UTF-16 单元、1,080,000 UTF-8 字节（原文本，不含项 JSON）在实际 Store 的同 C 窗口选择后完整分块恢复。仅模拟公共文本，没有实际 Provider／Core 权威写入或附件内容。

十项实际 Store 测试包括 140 交互分页／锚点、两种源后续更新与墓碑下旧 C 不变、独立 Message 优先级与跨 Session 隐藏、时间／角色／ID 排序和空边界、正文原 change digest、重算包摘要后的证明／正文漂移拒绝、跨快照／Session／版本正文引用、TTL／外部正文修改、Schema 3 历史无写入派生与可选父 Run 归属、缺覆盖／坏证明／跨 Run 身份歧义；四项独立协议测试补齐元数据字段／顺序／请求／C／锚点／原摘要校验。

证据 `artifacts/todo-remediation/t02-message-metadata-runtime-tests.log`：137 文件／1,008 项；`t02-message-metadata-protocol-tests.log`：13／85；`t02-message-metadata-related-tests.log`：五／42；`t02-message-metadata-app-tests.log`：76／318；`t02-message-metadata-integration.log`：十／87 且含集成类型检查。`t02-message-metadata-protocol-build.log`／`t02-message-metadata-runtime-build.log`／`t02-message-metadata-app-build.log` 构建通过，`t02-message-metadata-app-types.log` 三项类型通过；架构、Runtime 独立性 751 文件及九固定加六扩展 release 守卫通过，日志同前缀。新端口未冻结，现有冻结契约未覆写。

此阶段仍是 SQLite／协议／集成验证，新查询尚未加入 Runtime 公共请求／响应、IPC、Runtime client 或 Renderer；生产 opener／布局仍 Schema 3，Publisher／ACK 仍旧路径。没有新实际 Provider、Main 强杀或窗口验收。下一步补限于模型／诊断／流前缀的双表示元数据增量，避免无关 6.0 提交在旧 scoped scalar 链处 reset，同时保持旧完整 Scope 契约；再接所有新公共命令和客户端、Renderer 有界正文 Repository、Chat／定位／输入结算／通知。正常升级、生产提交后 ACK、大 Run 权威及 Runtime/Main／UI 故障验收随后进行，安全回收水位、更多窗、启动内存／偶发退出和其余 TODO 未完成。

## T02 限定 Feature 失效通知与公共查询接线

feature-receipts 1.0 只消费已保存的 View 2.0 租约：目录 models／diagnostics，或精确 Session inference_streams。旧完整 Scope 1.0 不改义。新 reader 逐个验证原 5.0／6.0 Commit 与原历史链接，以当前 C 为读取上界，最多 256 个连续位置／2 MiB；无关提交保留原位置和摘要而 receipts 为空。失效通知只包含所选 feature、实体 ID／版本／时间和 upsert／remove，不携带 DTO 或文档正文，不读分块表。推理流转移向旧 Session 移除；Session 工作区迁移、删除或恢复要求重取，不把最终同工作区当作没有发生成员变更。租约、边界、历史摘要、原链损坏及外部写入都校验。现有有界 Feature 窗口也对空结果与否定结果执行外部写围栏。

七个 query/result 分支已进入公共 Runtime 联合并注册在既有 projection.query owner：根、项元数据页、精确 Inbox、单块、合并消息元数据、独立 Message 正文、Feature receipts。现有 Main IPC 请求 Schema、Runtime supervisor、preload 结果 Schema 共享该联合，代码审查确认通用路径继承新分支；没有新增专用 IPC。Renderer client 提供七个验证方法，归属／包摘要／Merkle 证明都在返回调用者前检验。该接线尚未替换页面 Repository 或 Chat 的范围模型，Session 原消息窗的消息／Run 隐含失效依赖不能随 Feature 选择被丢弃。

真实无界面 Runtime 子进程测试在只读派生的 Schema 3 旧 Run／独立 Message 上执行七个公共 NDJSON 查询，验证根、连续元数据、精确 Inbox、叶正文、合并消息窗、独立正文和 Feature 原链，并清洁 shutdown／exit 0。两项跨工作区集成使用真实 candidate-4 SQLite、公共请求／结果 Schema、唯一 owner 和 Renderer client，验证多块文档与全部七种响应包摘要篡改拒绝。八项 Store、三项协议覆盖限定 Feature 增量与围栏。最新 Runtime 138 文件／1,017 项，协议 14／88，App 76／318，根集成 11／89；Protocol／Runtime／App 构建、node／web／tests 类型、集成类型、架构和 Runtime 独立性 754 文件通过。九固定加六既有扩展继续按原冻结范围检查，新接口未覆盖既有基准。

证据为 artifacts/todo-remediation/t02-feature-receipts-*、t02-document-public-queries-*。初次 headless 用错叶字段名造成断言失败，已使用正式 contentBase64；失败清理改为先等待子进程 exit，再删除本测试 TEMP，失败日志保留。该实际 NDJSON 证据不覆盖 Electron preload 的实际 IPC、Core 超大权威发布／Outbox ACK、候选 4 正常启动、商业 Provider、Main 强杀或页面验收。正常 Schema 仍 3，Publisher 仍输出旧完整 DTO。下一步接 bounded Repository 失效扫描、同 C 消息和流窗口／显式正文、真实部分覆盖及结算，随后接生产发布／ACK、正常升级和全量故障／UI 验收。

## T02 模型／诊断范围失效与有界单项正文

没有附带消息窗且选择符合 Feature receipts 的 View，现通过原 5.0／6.0 原链失效通知推进独立水位；无关文档提交不使模型／诊断范围重置或读取正文。相关失效只置 dirty，原 C 完整窗口继续可信，完整加载新代际后替换。消息窗仍保留原 Message／Run 失效依赖，没有将 inference-only 通知当作其完整替代。Feature 租约过期在范围内重新读取，不增加全局 resetEpoch；坏包／坏链保留可信窗口和水位。

ProjectionBodyRepository 提供独立 Message 显式正文及 Run 文档单项正文。独立 Message 保留原 change 摘要校验；文档项逐块验证并通过共享 assembler 完整校验，未完成时不进入缓存或发布。地址身份包含精确 Manifest／C、文档根／引用／项证明或独立 Message 引用；同一 Message 文档行与显式项地址共用一个请求和缓存。默认 32 项／16 MiB（正文序列化、地址与 pin 字节均计入）、单项 8 MiB、两个物理请求及 16 MiB 声明字节预留。LRU／pin 淘汰和容量拒绝原子更新；invalidate 清逻辑代际但不提前释放已派发请求的物理预留，迟到返回不发布且不继续后续块。没有完整 Run 拼接器，未把文档正文塞进旧 100k Schema 或用空数组伪称完整 DTO。这些预算是持有范围约束，不是整机连续峰值证明。

新增 11 项实际跨工作区 SQLite 集成，最新 12 文件／100 项与集成类型通过：真实 Renderer 模型范围跨大文档更新、范围租约续取、原水位／窗口保持、旧 C Message／文档、1,200,000 字节纯正文（900,000 UTF-16 单元）的多块完整恢复、同项请求合并、末块前不发布、包篡改／假缺块拒绝及正确重试、迟到代际和物理请求限额、LRU／pin／字节预算、可变调用者地址及伪造归属。App 76／318、完整应用构建所含 node／web／tests 类型和架构通过；Runtime／协议未改，仍按上一阶段 1,017／88、Runtime 构建、754 文件独立性范围使用证据，不宣称本轮重新执行。九固定加六既有扩展继续守卫原基准。

证据 artifacts/todo-remediation/t02-bounded-feature-receipts-*、t02-body-repository-*。初次集成类型校验发现重复 queryContractVersion 字段，已按正式 item_unavailable 形状修正；App 架构守卫将本地 fetch 回调名匹配为网络入口，改用语义准确的 readBody，没有放宽守卫，复验全量 318 项通过；失败日志保留。该正文仓库尚未由 Chat 范围消费，真实 Renderer 证据限于模型／诊断组合，没有新增 Electron 正文、Core 超大权威发布／ACK、正常 Schema 4、商业 Provider 或 Main 强杀验收。下一步提供精确 Session 的 Message／Run／inference 原连续失效链与 Catalog C 下的 inference 窗口，再接同 C 会话范围及正文加载／真实部分覆盖，不能改写 View 清单或跨 C 拼接。

## T02 同 C 会话失效、推理前缀与按需正文范围

conversation query 1.0 复用精确 Session／all Run 的 Catalog 3.0 租约；没有把 View 2.0 清单改写为 Catalog，消息元数据、文档项与推理前缀直接使用同一 C。失效通知包含 Message／Run／inference 三个真实依赖，保留原 5.0／6.0 提交的全局连续位置、payload／history digest、Source 与空无关位置，只返回实体失效身份。转移和墓碑向旧所有者发 remove，Session 工作区移动／删除／恢复明确重取。共享原链扫描器及 Feature 窗口行算法，删除旧重复算法，旧 View-2 响应形状和冻结契约未扩义。两查询进入既有公共联合、唯一 Projection owner 和校验客户端；实际 headless NDJSON 与跨工作区客户端现在覆盖九查询及九种包摘要拒绝。

ProjectionConversationRepository 保存单个消息元数据窗口及同 C 的 streaming／所见 Run 前缀窗口；每个窗口保留自身 filter、锚点和 hasEarlier／hasLater，字节截断明确保留未覆盖状态。正文只在显式请求时交给单项正文仓库，不预加载 64 条大正文，不伪造完整 Message／Run。附近／之前导航继续原 C；失效水位独立推进，可信窗口直到完整新范围才替换。默认三个 Session 范围、24 MiB 总量／8 MiB 单范围、三个物理范围／扫描请求；完整正文另受 32 项／16 MiB、两请求的既有预算控制。相同加载／扫描合并，迟到加载／正文不发布到新范围；invalidate 不释放未完成物理请求。LRU 保护选中范围，容量拒绝保留原状态。预算为序列化持有范围／声明预留，不是整机峰值证明。该仓库仍为待接 Chat 的范围所有者。

新增七项实际 Store、三项协议、九项会话仓库集成。覆盖混合原链、三依赖所有者转移／墓碑、Session 成员变动、同 C 消息与流、2 MiB 前缀分页、租约／否定绑定、外部写与坏链锁存；范围测试覆盖读取之间权威更新仍保留旧 C、1,200,000 字节完整交互仅显式加载、附近／之前定位、缺锚点、坏证明、TTL、合并请求、迟到代际／物理预留、LRU／字节容量、可变调用者参数，以及前缀截断的真实覆盖状态。最新 Runtime 139 文件／1,024 项、协议 15／91、App 76／318、根集成 13／109 与集成类型通过；Protocol／Runtime／App 构建、node／web／tests 类型、架构、Runtime 独立性 762 文件、九固定加六既有扩展通过。证据 artifacts/todo-remediation/t02-conversation-*。首次仓库测试夹具的 updatedAt 早于 createdAt，被正式 Schema 拒绝；修正模拟时间后全量通过，失败日志保留，未放宽校验。

这些证据不包含新 Electron 页面／preload 实测、Core 超大权威发布／Outbox ACK、正常 Schema 4、Provider 或 Main 强杀。生产 Schema 仍 3、Publisher 仍旧完整 DTO，Chat 会话组合仍旧范围，不能据此勾选 T02。下一步将 Renderer／Chat 切到该明确部分范围及显式正文状态，替换 Run 详情／Tool／Inbox 为文档根和单项读取并接精确输入结算、附近定位与搜索、通知；再接唯一 Publisher／提交后 ACK、正常升级及完整大数据／Runtime／Main／UI 验收。更多窗、安全回收水位、启动内存／偶发退出和 T03—T16 保留。

## T02 Renderer／Chat 元数据与正文状态消费（2026-10-05）

RendererProjectionRepository 的精确 Session 已切换到 ConversationRepository，Message／Run／inference 三依赖继续独立失效扫描；消息与前缀窗口仍直接共享同一 Catalog C。latest 更新、before／around 导航和历史锚点使用元数据窗口，未读取正文的行明确 bodyState=unloaded，正文缺省不能解释为完整空内容。正文读取绑定 Session、windowDigest 和页面代际；坏证明锁存，过期租约仅刷新元数据和新 token，旧 token 不触发新正文。MessageFeatureStore 最多合并／排队 32 项、同时派发两物理请求，迟到结果不能进入新范围。

Chat 正文占位组件在真实视口可见后授权读取；未加载时有读取／重试动作，没有空正文或复制动作。读取在途身份绑定具体 onLoad 授权和 ticket；新窗口 token 可以派发新请求，旧 ticket 的错误和结束不能覆盖新的组件状态。底层请求／缓存预算不变。语音等到完整正文，终态首个完整语段带 final 标志，处理时长和理由信息继续正常呈现。Run 详情／Tool／Inbox 尚使用旧完整 Run，文档根和精确项结算仍待迁移。

随机 HMAC 的 Base64URL 游标可偶然符合明文凭据禁止模式。唯一 SnapshotReader 游标编码器现在对两段采用 c1_ 前缀和可逆规范转义，MAC 仍绑定原 payload，解码重新编码核对规范形状并拒绝旧别名／非法逃逸；安全 Schema 与明文禁止检查没有例外。游标是 Runtime 代际内的不透明租约引用，没有修改持久历史或冻结契约。

最新 Runtime 140 文件／1,026 项、App 77／321、根 SQLite 集成 14／115 通过；Runtime／App 构建、三应用类型、架构、独立性 765 文件通过。新增六集成验证元数据不读正文、32 项排队／两物理请求／合并、旧 C 与所有者／token 绑定、坏正文摘要、Message／Run 失效与正文租约续取；App 两项正文呈现与一项终态语音，Runtime 两项游标编码验证全字节和凭据形状／非法别名。协议源码未改，上一阶段 15／91 按原范围保留。证据 artifacts/todo-remediation/t02-chat-range-*；失败类型／断言／语音／行数守卫与随机游标日志保留，未放宽守卫。

Electron 新正文消费尚未整体验收：首轮 Inbox DOM 等待失败，权威三条交互完整，验收已补有限真实滚动来授权视口外正文；第二轮及诊断轮通过直接流式、Inbox、权限、输入／页面重载投递和五次 Runtime 强杀，随后 terminal_dom 超时。诊断轮 partial 已在重载后恢复，但终态正文未显示；失败诊断 JSON 保留，capturePage 的 UnknownVizError 不能替代原超时，已单独收集截图错误。组件在途授权竞态修复后的 electron-t02-chat-range-visibility-fence 正在复验。没有新的完整 Provider gate 或 Main 强杀结论，正常 Schema 仍 3，Publisher 仍旧 DTO。完成小型真实 Electron gate 后，下一步接 Run／Tool／Inbox 文档项、生产发布／提交后 ACK、正常升级、大 Run 权威及 Runtime/Main/UI 验收；机器峰值、安全回收和其他 TODO 仍未完成。

### 小型 Electron 正文消费 gate 的后续记录

视口授权 ticket 修复后的首轮 electron-t02-chat-range-visibility-fence 仍在 terminal_dom 超时：重载部分已恢复，两个行保持正文未加载，捕获页面出现 UnknownVizError；该竞态修复不能被声称为已证明的失败根因。添加失败专用观察器／窗口状态与手动动作诊断之后，electron-t02-chat-range-observer-diagnostic 用相同产品代码通过完整 gate：70 次确定性 Provider 请求、66 响应、四次预期中止，五次 Runtime 强杀和 Main 重启恢复，重载最终正文、Inbox／权限／工具、调度、取消、工作流、目标、记忆、模型夹具和文件场景均通过，consoleErrors 为空。失败专用手动动作未在通过轮调用，不能把日志添加当原因修复。它是小型 Schema 3 夹具窗口验收，未覆盖生产超大文档、真实商业模型、ACK 或 Schema 4 激活。

由于同产品代码上一轮仍失败，electron-t02-chat-range-stability-recheck 正在新具名 TEMP 目录复跑。失败原因与稳定性结论保留未确定；矩阵当前 gate 为 partial，记录通过轮和这一限制。下一步依复跑失败诊断确定触发层，或在完整复跑后推进 Run 文档读端，不能以单次通过删除原失败证据或勾选整个 T02。

### 已定位的隐藏窗口触发层（2026-10-05）

stability-recheck 再现 terminal_dom 超时并给出完整证据：BrowserWindow 可见且未最小化，但 bounds=(-10000,-10000,1362,863)，document.visibilityState=hidden；新增 IntersectionObserver 一秒内没有回调。失败专用手动点击后，两条正文完整加载，最终文本为 ARIADNE_SMOKE_STREAM_RECOVERY_OK，占位行清空。这将故障定位到验收脚本主动移到屏幕外的窗口与可见性触发条件，而非正文读取或流恢复。脚本先前的偶然通过不能证明屏幕外视口验收可靠。

唯一 showSmokeWindow helper 将验收窗口放进主显示器工作区域并显示；普通、应用配置和容量窗口共用这一所有者，删除三个屏幕外位置。流恢复检查在开始与重载后显式验证 document.visibilityState=visible，并在成功时记录独立 inference-stream-recovery.json，包含真实边界、visibility 和传输故障恢复结果；自动正文和最终 DOM 断言保留。没有用手动读取回退把失败改判成功，没有扩大超时或修改生产可见性规则。先前组件 ticket 改动只解决并发授权归属，不能归因于屏幕外问题。

最新 App 构建及三项类型、架构通过；electron-t02-chat-range-visible-window 正在全 gate 验证此触发层修正。所有屏幕外失败、手动诊断与独立 TEMP 数据保留；本轮 gate 仍 pending，容量页面采用新窗口 helper 后尚未复验。生产大 Run／ACK／正常升级和 TODO 其余要求未完成。

### 可见窗口完整 gate 通过

electron-t02-chat-range-visible-window 的普通全 gate 与 desktop-restart-delivery 均 passed=true，69 次确定性 Provider 请求、66 响应、三次预期中止，轨迹有效、五次 Runtime 强杀、全部原场景与 Main 强杀重启通过，fatalError=null、consoleErrors=[]。独立 inference-stream-recovery.json 记录 visible 和 bounds=(0,0,1364,863)，丢失／重复片段及重载最终正文自动恢复；失败专用手动动作未调用。实际请求／中止计数由各轮轨迹记录，不强制等于上一轮 70／4。验收触发层修正通过，旧屏幕外失败全部保留。

当前小 gate 已验证，T02 整项仍未完成。容量验收增加“搜索窗口外会话 → 锚点进入视口 → 实际正文包含 CAPACITY_ANCHOR_149”的断言，保留其余目录、64 条历史／附近定位、24 次切换、固定 C 写入和 Runtime/Main 恢复。electron-t02-chat-range-capacity 正在复用原具名 TEMP 的 150 会话／10,000 消息／82,766,850 字节夹具，未触及真实用户库；其新消费与可见窗口结果尚待收取。生产超大 Run 发布／ACK、正常 Schema 4、全部文档读端和最终清单仍未验收。

### 容量新消费结果：页面通过，启动 gate 未通过

electron-t02-chat-range-capacity baseline 通过；initial 的目录／64 条历史、窗口外搜索、真实锚点正文、24 次切换、旧 C 下十次写入及计划的 Runtime 强杀恢复均完成。元数据 29 请求最大 99,725 字节、正文 80 请求最大 10,094 字节，均零失败；没有 scalar snapshot／commit 查询，响应字节界有效。页面阶段成功不能覆盖整体 passed=false：第一次启动在约 15.23 秒握手超时，多出一个 Runtime，initial 共三个进程；脚本按原门槛拒绝，Main 重启阶段未运行。

按 lifecycle 与 trace 对齐，首次进程 PID 146508 在 productivity_store_open 已耗约 3.49 秒、persistence_ready 12.675 秒、进入 startup_projection_drain 12.682 秒后被超时终止，没有 ready；重试 PID 129508 与计划强杀后的 PID 146492 分别约 9.214／9.165 秒到 ready。首次 UI ready 25.39 秒。此前容量 gate 的额外超时问题本轮再次出现，不能仅暖缓存重跑后声称消失。新 Renderer 缓存和正文断言没有据此取得容量整体验收，采样不代表连续峰值。

证据：initial/capacity-initial.json、runtime-startup-146508／129508／146492.jsonl、runtime-startup-metrics.json、stderr.log 与顶层 t02-chat-range-electron-capacity.log。具名 TEMP 权威保留；没有扩大 15 秒握手、跳过原历史审计、清库或把额外 Runtime 算成预期恢复。下一步定位首次 Productivity／Projection 打开和 authority replay 的时间与所有者读取，优化真实审计／重放工作且保留全部不变量，再复验完整 baseline／initial／Main 重启；Run 文档消费者、生产发布／ACK／正常升级及其他 TODO 同时保持未完。

## T02 同字节重放与一致快照完整审计（2026-10-05）

生产路径重新核对：各 startup trace 是“即将开始该阶段”的时间点；conversation_store_open → productivity_store_open 属于 Conversation 库打开，productivity_store_open → public_projection_store_open 才是 Productivity。上轮首次慢启动前者约 3.37 秒，后者约 3 毫秒，不能把 3.49 秒时间点当 Productivity 阶段耗时。Projection 打开／审计和 Conversation 权威重放仍是主要工作，15 秒握手未改。

唯一 appendProjectionLedgerCommit 对已经通过完整公共 Schema、安全和字节界校验的请求生成规范 Commit 字节。若原 commit_json 与它完全相同，直接用相同已校验值验证原行的 cursor／event／source／sourceCursor／contractVersion／occurredAt／原字节／SHA 与 historyDigest 形状，仍核对原历史链并提交原重放事务；省去解析、校验和规范化同一份旧正文。不同字节继续完整解析和原等价校验，5.0 → 6.0 重放未改，未覆盖旧记录、版本、Source 或原 C。共用行绑定函数使普通解析与同字节重放没有另一套判断。没有可信历史缓存或跳过权威重放。

完整启动审计在同一 SQLite 读事务中验证全部 Commit、版本正文／摘要、连续历史、每源水位、文档所有项／publication link、版本次序、Head 与 checkpoint。每个 Head 与刚验证的 latest 版本的九个持久字段精确相同，包含 dto_json、payload_digest、C／index；在该一致快照内继承已验证正文，不重新解析所有 Message 等正文。目录缓存只观察 Session／Run／Decision，普通审计 callback 默认语义保留。审计自己创建读事务时完成后核对 data_version，外部写入拒绝；迁移已持有事务时借用并不提交调用者事务。读失败回滚自己的事务。没有降低历史／正文审计覆盖，也没有依赖跨代际的 data_version 信任。

ConversationProjectionReader 的 event／精确 Session 版本／精确 Message 版本三个固定 SQL 每批准备一次，替换逐事件准备；行归属、摘要、时间和 Schema 核对全部保留，批次上限与 frozen source 契约不变。默认空批准备成本不被当作跨调用缓存。

新增十项 replay／audit SQLite 测试和一项权威 reader 测试。覆盖同字节原记录／C／版本／Source 不变、五类原行绑定漂移、坏 history link、请求正文漂移、只观察目录时 Message 版本仍全审计、审计期间外部写入拒绝、一致快照／读事务结束，以及三语句读取真实权威 Session／Message 版本。原候选发布／迁移、正文篡改和冻结契约断言保留。最新 Runtime 141 文件／1,037 项、相关五文件／57 项、根实际 SQLite 集成 14／115 与类型、Runtime 干净构建、架构、766 文件独立性、九固定加六既有扩展通过。App／协议源码和公共接口未改，上一阶段 321／91 按原证据范围使用。

独立 Node owner 基准在原具名 TEMP 夹具上重放 10,300 权威记录／22 批，原 Commit 数／C 不变；before 为 Conversation open 449.7 ms、Projection open 3,511.0 ms、replay 4,924.2 ms、合计 8,890.1 ms；只改同字节重放后 replay 3,639.7 ms；最终两项优化后 open 440.9／2,612.7 ms、replay 3,492.7 ms、合计 6,550.1 ms。OS 缓存状态未受控、各轮内存只为单点，不是冷启动、Core ACK、IPC／Main／UI 或连续峰值验收。报告 t02-commit-replay-before.json、t02-commit-replay-after.json、t02-startup-audit-replay-after.json；脚本只能操作 TEMP 下 AriadneCapacity- 命名夹具，未写真实用户库。

真实 electron-t02-startup-audit-replay 容量 baseline／initial／Main 强杀后重启均 passed=true，数量仍 150 Session／10,000 Message／82,766,850 公开字节。初始／Main 后 UI ready 7,770.2／7,763.4 ms；两者及计划 Runtime 恢复的进程 ready 约 7.408／7.389／7.312 秒，严格进程数和 lifecycle 无额外退出／握手超时。搜索窗口外会话后锚点可见且正文完整，目录／历史／24 次切换／旧 C 十次写入和 Runtime/Main 故障恢复通过；没有 scalar snapshot／commit 请求，metadata 最大 99,737、显式 body 最大 10,095 字节，零失败且字节界有效。原屏幕内可见性所有者和正文断言保持。

按 t02-startup-audit-replay-attribution.json，初始／Runtime 恢复／Main 后 Runtime RSS 采样分别 579.4／572.9／581.6 MiB，stage heap 点约 269.7／270.8／270.7 MiB；这是 22／10／22 次采样与阶段点，不是整机或连续峰值。先前首次慢启动失败与冷缓存影响仍保留；本轮通过不保证任何存储规模或最坏时间，也不把暖重试当失败已消失。新小型确定性完整 Electron gate electron-t02-startup-audit-replay-small 正在复验，未计入通过。Run 文档页面、精确 Inbox 结算、生产 Publisher／ACK、正常升级、更多窗／安全回收和 T03—T16 仍待完成。

### 同字节重放／一致审计后的完整小 gate 通过

electron-t02-startup-audit-replay-small 的普通完整 gate 与 desktop-restart-delivery 均 passed=true，70 次确定性 Provider 请求、66 响应、四预期中止，原轨迹有效、五次 Runtime 强杀、Main 重启和全部原场景通过，fatalError=null／consoleErrors=[]。独立流恢复记录 visible、bounds=(0,0,1364,863)，丢失／重复片段、重载部分前缀和最终正文自动恢复；没有失败手动动作或超时扩张。该 gate 连同前述真实容量 gate 验证当前优化的完整生产接线，仍是模拟 Provider／旧 Schema 3 与既有小 Run 范围，不能替代超大 Run 的 Core／Publisher／ACK／Schema 4 或真实模型验收。

最新工作区仍需将 readRunProof／observeRunProofs、RuntimeRun.inbox、Chat 输入编辑与 SessionActivityPanel 的完整旧 Run 消费替换为同 C 文档根、部分元数据范围、精确 Inbox source／delivery／版本证明和显式单项正文；未加载的工具活动或 Inbox 不得呈现为“没有”。随后完成生产发布、正常升级、安全回收及其余 TODO。用户数据和所有原失败证据保留。

## T02 Run 集合范围与精确 Inbox 结算（2026-10-05）

Run 文档仓库已经接入 Renderer 的同一 Projection composition；与 Conversation 共用一个 complete-item body LRU，未建立第二套正文缓存或完整 Run 组装。每个精确 Session／all-Runs manifest 绑定一个 C，根保留原版本、Header、documentDigest 和 bodyCursor；三个集合各只保留一页，页面 startOrdinal／pageIndex／previousPageDigest 和下一页游标必须连续。缺页、页前和页后均保持未知，空页只有完整证明的零集合才表示为空。默认最多 16 个根范围／8 MiB、两个物理元数据请求；单根不超 8 MiB。原正文预算 32 项／16 MiB／两个物理请求保持，页加载不读取 chunk。

Inbox 精确查询每根最多保留 32 个已证明输入，按 inputId 读取窗口外项目；阳性证明给出 Run／Session／RunVersion、输入版本、delivery 和 source，正文继续显式读取单项。证明为 null 只说明这个 C 下该 ID 不存在，不能结算未知投递。查询、证明、连续性、容量或租约失败均保留既有可信范围；generation／逻辑票据丢弃晚到结果，invalidate 不释放仍在执行的物理请求预算。新 C 替换根时清空旧集合和精确输入，旧 proof 不能给新根加载正文。

生产 sender 结算移除了完整 Run DTO 的 observeProjection／observeVerifiedRunDetails／observeRunProofs 路径，以及无人使用的全局 readRunProof。RuntimeStore 对 pending／reconcile 的精确 runId／sessionId／inputId 逐个验证；先读取真实 Session owner，再为该 Session 获取 unfiltered Run catalog manifest，根和 Inbox lookup 共用它。引用最多 100 个并去重，交错 Session 先分组完成，避免耗尽真实 64-lease 所有者后回读已过期 C。Tracker 仅凭同 Run／Session、正版本、同 inputId／delivery、无系统 source 的阳性元数据结算；遗漏、null、错误 owner／版本／delivery 和系统输入不结算。Main safeStorage sender outbox 的稳定 commandId／inputId、显式重确认和安全结算规则保留，不自动重发。

正常 Run／工具／Inbox 页面仍有完整旧 DTO 消费，尚未迁移成上述部分覆盖状态。本阶段不会把这些旧页面的数组改成空数组冒充新文档，也未激活正常 Schema 4 或唯一 Publisher 6.0／Core 提交后 ACK。新候选仓库、精确结算读取与生产旧表示的查询派生分开验证，后续须替换 RuntimeRun、SessionActivityPanel、Chat 编辑／删除／单项读取，再做超大 Run 的真实权威和故障恢复验收。

Runtime 的 Node 声明从 >=22.13 修正为 >=24.16.0，package-lock 的同一工作区同步。仓库根和实际打包 runner 已固定 24.16.0；本机 node -v 也是 v24.16.0。随库 @types/node/sqlite.d.ts 将 DatabaseSync.isTransaction 标为 since v24.0.0，候选迁移和当前一致审计使用该 API。修正所属声明，不加入旧 Node 兼容分支；只修改 engines，不改变 JavaScript 或 runtime-build 指纹。
### 当前验证与尚未完成的页面

新增八项真实 SQLite／客户端／仓库集成，另有 RuntimeStore 组合项证明：完整旧 Run 已含同一 input 时，sender 在精确 Inbox 响应返回前仍 reconcile，证明返回后才 accepted，enqueue 只发一次。根集成 15 文件／124 项和类型通过；App 77／321、完整 Main／preload／Renderer 构建与全部 App 类型通过；架构与 766 文件 Runtime 独立性通过。证据 t02-run-range-integration-final.log、t02-run-range-app-tests.log、t02-run-range-app-build-final.log、t02-run-range-architecture-final.log、t02-run-range-independence.log。36 个交错 Session／72 个精确 input 的真实有限租约测试通过，根 LRU 最终 16 项、正文零预读；该单元压力项专用 20 秒超时，不改变任何原生握手或 DOM 验收超时。

第一轮 electron-t02-run-inbox-proof 和最终分组构建 electron-t02-run-inbox-proof-grouped 的完整实际 Electron gate 均通过：70 请求／66 响应／四预期中止、五 Runtime 强杀、Main 重启、流式丢失／重复与重载自动正文，fatalError=null、consoleErrors=[]；desktop-restart-delivery passed=true。新结算仅读取真实公共根和精确 Inbox proof，没有用户手动成功回退。仍是确定性 Provider 和生产旧 Schema 3／既有 Run DTO 派生根的范围，不代替候选 6.0 大 Run／Core ACK／真实模型验收。

最终构建容量 gate electron-t02-run-inbox-proof-capacity 的 baseline／initial／main-restart 全通过，沿原独立 TEMP 150 Session／10,000 Message／82,766,850 字节夹具，目录 128+22、历史 64+36、窗口外搜索锚点实际正文、24 次切换、旧 C 十次写入以及 Runtime/Main 强杀恢复通过。三阶段无额外 Runtime、握手超时或查询失败，scalarQueriesAbsent／boundedResponses=true。UI initial／Main ready 为 9,146.7／7,760.9 ms；初始 PID 150596 的 Runtime ready 8,747.5 ms，恢复 PID 147308 为 7,504.8 ms，Main 后 7,416.9 ms。初始／恢复／Main 后 RSS 采样 630.9／572.9／579.1 MiB（24／10／22 样本），stage heap 点 446.0／274.6／272.1 MiB。本次初始内存／时间高于前一轮：缓存、GC 与 I/O 未受控，不能把较低单次样本写成稳定峰值或最坏启动保证。按 PID 和强杀记录区分初始与恢复，不按报告数组排序误标。完整出处 t02-run-inbox-proof-capacity-attribution.json 和各阶段原 JSON。

下一步是 Run 页面归属层：ProjectionPresentation.runs／RuntimeRun 必须区分根 summary 和三个集合的部分覆盖；loadVisibleDetails／openRun 移除完整 Run detail 读取，改两可见 Run 的同 C 根及有限工具／Inbox页。工具页面缺页显示未加载／部分覆盖，不能说没有工具；Chat Inbox 正文、编辑和删除绑定精确版本，读取经共用单项正文预算。后续选中根／集合的固定 pin 和后台输入证明之间必须遵守同一容量边界。页面迁移之后才接生产 Publisher／提交后 ACK、正常 Schema 升级、超大 Run 权威／旧 C／Runtime/Main/UI、安全回收和 T03—T16。TODO 保持未勾选，不删除、不关机。
## T02 Run 页面迁移到文档范围（2026-10-05）

当前 Renderer 已移除 Run 的完整 catalog detail 读取；Decision 独立完整详情继续使用原预算。两个可见 Run（主 Run／显式打开的 Run）在精确 Session／all-Runs Catalog manifest 下读取根，并仅加载工具和 Inbox 的第一元数据页。根与可见 catalog summary 必须逐字段规范相等，分页后保留当前页，不在每次 poll 时重置。零集合由已验证 Header 的计数／空 Merkle 根证明；正计数但缺页明确为 unloaded。ProjectionPresentation.runs 现在是独立 ProjectionRun：真实 summary、documentToken、集合覆盖和工具／Inbox 页，不能当完整 PublicRunProjection。RuntimeRun 不再持有完整交互消息数组；Chat 交互历史由原同 C merged Conversation 元数据窗口提供，无人调用的旧合并函数删除。

仓库键改为完整 immutable manifest 加 runId；新旧 C 可在原 16 项／8 MiB预算内并存，后台最新输入证明不会替换前台正读的旧 C。可见两 Run 的根地址 pin 计入字节界，LRU 不驱逐 pinned entries；全部可驱逐项不足时原子拒绝，不删可信根。前台 Root manifest 单独随展示范围发布，正文／分页以已发布 documentToken 和 Session 绑定，不能拿后台候选 manifest 配旧 UI token。陈旧 token、会话切换和 generation 结果不发起后续正文或改新页面；proof 错误锁存完整性，租约过期先更新元数据和 token，不以旧 token 自动读取新正文。

工具页面显示已打开 Run 的当前工具页和明确范围，“第一页／下一页”在同 C 运行；未加载正计数不会写成没有调用。Inbox 独立组件显示当前页、未加载正文和显式读取／重试；自动正文读取只在真实 IntersectionObserver 可见项触发，队列容器最大 180px 并滚动，128 行不会挤没 Chat 视口或全部预读。完整正文到达前编辑禁用。编辑和删除绑定实际 inputId／version，编辑失败在该组件仍存活时保留草稿；不将它宣称为 T05 的跨生命周期持久草稿。首个 Message／Inbox 正文调度共用 RuntimeStore 的一条 32 active-plus-queued／两物理请求队列，复用原 item LRU／单项声明字节预算，Feature Store 不建立第二正文缓存。

验证：新增 pinned 原子拒绝和实际候选 6.0 Renderer 集成，证明 150 Inbox 的 128／22 页、真实部分覆盖、正文缺失状态、根无完整交互数组、无 Run detail 请求、后台 v2 精确证明与前台 v1 正文共存、正文 LRU 共用及旧 token 丢弃。混合 16 Message／16 Inbox 正文项占满同一 32 ticket 队列时第 33 个 Inbox 被拒绝，实际公共 body／chunk 峰值并发为二，最后两种正文各 16 项完整。既有投递结算项改证明“已验证页含 input 也不能先结算”，页 metadata 不含正文，精确 proof 返回才 accepted，enqueue 一次。根集成 15 文件／127 和类型通过；App 新三个 SSR 覆盖项证明 unloaded／partial／输入正文与禁用编辑／非空未加载工具不说空，App 78／324 和完整 App 构建／类型通过；架构边界未扩大。证据 t02-run-page-integration-final.log、t02-run-page-app-tests-final.log、t02-run-page-app-build.log、t02-run-page-architecture.log。

实际 electron-t02-run-document-pages 完整 gate 与 Main 重启通过：70 确定性 Provider 请求／66 响应／四预期中止，五 Runtime 强杀、全部场景和流式丢失／重复／重载自动正文恢复，fatalError=null／consoleErrors=[]；独立恢复记录明确 visible、bounds=(0,0,1364,863)，没有手动成功回退。容量 electron-t02-run-document-pages-capacity 的 baseline／initial／main-restart 全通过：原独立 TEMP 150 Session／10,000 Message／82,766,850 字节，目录、历史、24 切换、旧 C 十次写入、窗口外搜索实际 anchorBodyRead=true 和 Runtime/Main 恢复通过；无额外进程、握手超时或查询失败，scalarQueriesAbsent／boundedResponses=true。metadata/body 最大 99,739／10,093 字节；UI 初始／Main ready 7,762.3／7,723.0 ms。按实际强杀 PID 145184 归属初始，Runtime ready 7,407.3 ms；恢复 PID 147448 为 7,316.2，Main 后 PID 149636 为 7,375.6。RSS 采样初始／恢复／Main 为 582.6／572.9／580.0 MiB（23／10／22 样本），stage heap 点 275.2／276.0／278.1 MiB。缓存／GC／I/O 未受控，不计连续或整机峰值、最坏启动保证；旧首次超时和屏幕外失败保留。完整出处 t02-run-document-pages-capacity-attribution.json 和各阶段原 JSON。容量夹具没有 Run，只证明本构建的 Chat／正文／启动恢复，不能算超大 6.0 Run 页面的真实窗口。生产 opener 仍 Schema 3、Publisher 仍旧 5.0；正常升级、Core 权威大 Run／ACK、更多窗／回收和其他 TODO 未完成。

## T02 可见范围交接与文档提交所有者（2026-10-05）

Run 可见范围在新 C 的根／元数据／Decision 完成前不释放旧 pin。stagePins 同时预留最多两个可见旧根和两个候选地址，全部地址和元数据仍占原 16 项／8 MiB，未扩缓存；容量不足原子拒绝，保留旧根。候选提交／释放以独立 ticket 绑定，旧 finally 不能清除新候选；失效会清全部 pins 并使旧 ticket 无效。两个实际 SQLite 用例验证后台第三根不能驱逐前台／候选、交接后旧根才可驱逐，以及容量不足／被替代／失效边界。根集成 15／129 和类型通过。App 构建／三项类型和 78／324 通过；electron-t02-run-page-pins 的完整 gate 与 Main 重启通过，70／66／四预期中止、五 Runtime 强杀和自动流式正文恢复。它仍读生产 5.0 派生文档，超大候选页面不计真实窗口。

文档写扩展 PublicProjectionRunDocumentCommitSinkV1 接入现有 SqlitePublicProjectionStore，appendRunDocument 先校验 6.0 请求，再经同一个 tail 准备项和最终事务；Schema-3 会显式拒绝，不隐式建表或改版本。最终返回才更新剥离的 catalog metadata；等价 5.0 重试返回原 C，原 5.0 字节／链／版本／Source 不改，候选准备根的 published_cursor 仍为空。关闭先冻结新入队，再等待已接纳异步发布及后续查询／5.0 写入；schedule 现在 await 异步结果后捕获和锁存存储腐败，不能由 Promise 返回绕过完整性门禁。文档 wake 扩展使用相同稳定身份，只在最终提交返回后发布，hint 失败仍向上失败，重试身份相同；准备／提交失败不发 hint。没有第二库或 Outbox ACK 实现。

架构检查曾发现 owner 引用发布器后形成两文件循环，已从归属层解决：发布器只依赖独立 ProjectionLedgerWritePorts，唯一所有者提供原最终事务函数；既有 candidate 夹具／强杀 benchmark 同样显式传入。固定 append 的事务／摘要／审计算法没有复制，原九持久契约签名和六扩展基线均通过，架构基线没有扩大。新增五个真实 SQLite owner 用例和一个 wake 项验证异步队列／close、Schema-3 拒绝、5.0 原收据、COMMIT 后未知结果重试及异步外部写锁存／hint 顺序，相关三个 SQLite 文件 48 项通过；Runtime 141／1,043、完整干净构建、根集成 15／129、独立性 776 文件通过。App 第一轮出现 runtime/dist/runtime-build.json ENOENT，保留日志；清单恢复后串行复跑 78／324 通过，未改产品或测试断言，未将复跑推断成已确定并发根因。

最终 Runtime 构建的 electron-t02-document-owner 未通过；当前复验结论见下节，容量尚待运行；前一 pins gate 只证明前一 Runtime 产物。新写扩展尚未被生产 AgentRun Publisher 使用，生产 opener／Publisher 仍 3／5.0；因此上述实际 SQLite 与 wake 项不代表 Core Outbox ACK／正常升级／超大生产 Run。下一条具体操作是收取最终窗口／容量，并将唯一 Publisher 从全 DTO 改文档 Commit，保留稳定 event/source、terminal Conversation 优先和最终提交后 ACK；接正常 3→4 审计迁移，完成大 Run／旧 C／Runtime/Main 故障验收。T02 安全回收／更多窗／峰值与 T03—T16 保留。

## T02 Provider 快照边界与最终构建复验状态（2026-10-05）

electron-t02-document-owner 失败：所有场景后 waitForProviderTrace/readProviderState 的 JSON.parse 遇到 Unexpected end of JSON input，未写最终 result，外层在原五分钟 Main crash deadline 失败。stderr 和具名 TEMP 保留。夹具 persistState 曾直接覆盖 provider-state.json，PowerShell 读端允许瞬时解析失败，而 Main 的严格读取没有该保证；直接覆盖确实暴露截断中的内容。写端已改为独立 smoke-json-snapshot.mjs 的完整临时文件／替换发布。Windows EPERM／EACCES／EBUSY 时保留上一份完整快照，最多保留一份最新候选并在五秒内重试，超时或其他错误显式失败；没有以直接写入、假状态、读端吞坏 JSON 或放宽原 trace／握手／DOM／Main 时限作为成功回退。

三个真实文件边界用例通过：共享冲突时读旧完整 JSON、替换后交付最新合并快照；永久／超时失败保留旧快照并拒绝；异步 flush 结算期间新写入在共享结果成功前完成，不能漏交付。t02-document-owner-atomic-provider-unit.log 留证。首个原子写端构建 electron-t02-document-owner-atomic-provider 完整 native gate 和 Main 重启通过，70 请求／66 响应／四预期中止、五 Runtime 强杀、自动流式正文恢复、全部场景，fatalError=null／consoleErrors=[]。

补齐异步交付边界后的最终夹具复验 electron-t02-document-owner-atomic-final 在启动阶段失败，Provider 请求为零：Runtime 意外退出 code 1，agent-settings:apply 与回滚均失败，runtimeReady／projectionReady=false，consoleErrors=[]。这不是新的 Provider trace 成功，尚未取得底层 Runtime 退出原因，不靠相同产物重跑宣称根因消失。期间 runtime/dist/runtime-build.json 的修改时间与之前构建结束不同，先前 App ENOENT 和此次启动退出都保留；尚无证据把两者归为同一个并发构建问题。当前正常桌面进程不作验收清理，真实用户目录不动。

当前最新完整 gate 仍为 partial，最终 writer 复验失败，容量未复验最新 Runtime 产物；前文 run-document-pages 容量和 atomic-provider 全 gate 只按各自构建／夹具范围保留。所有 shell 验收已结束，没有清理失败 TEMP 或改验收阈值。下一条具体操作：读取 Main 捕获的 Runtime 原始启动诊断，核对实际 entry／build manifest 和产物稳定性，在独立数据根验证最终完整 gate／容量，再继续生产 Publisher／Core ACK／正常 3→4 升级及大 Run。T09A 已按用户补充登记在 T09 后、T10 前，未插队实施。

## T02 正常 Schema 升级与唯一 Publisher 激活（2026-10-05）

正常 SqlitePublicProjectionStore 已激活 Schema 4。低层打开器保留原 3 版创建布局，同时严格识别已升级的 4 版；正常所有者在首次打开 3 版时借用唯一连接、BEGIN IMMEDIATE 和完整历史审计，原子增加 documents/items/leaves、4 版迁移记录及 user_version。既有五类历史表、Stream、Source、水位、墓碑和 3 版迁移记录不重写；错误整体回滚。打开 4 版仍执行完整历史／文档审计，不重复迁移。RunDocumentSchemaLayout 独立提供精确 SQL；升级器由调用所有者注入审计，不反向依赖 Store，没有循环、第二连接或第二审计实现。旧 3 版副本的升级、准备、恢复副本及正常 Store 再升级保留逐行历史；正常 4 版文档提交关闭重开保留原 C 与发布链接。schema-compatibility 当前版本为 4／前置 3，发布检查读取 current 常量；九固定签名、六既有扩展和原低层冻结布局保持。离线通信维护对已升级当前库先严格验证 4 版布局及元数据，再走原幂等审计；真实旧格式夹具仍使用原 3 版布局。

唯一 AgentRunPublicProjectionPublisher 改为 projectAgentRunDocumentV1、6.0 根与同版本 Decision，调用现有 appendRunDocument 扩展；不调用旧全 Run DTO，也不建立回退发布路径。原稳定 event/source、sourceCursor=Run.version、完整不可变 receipt、terminal Conversation 优先均保留。文档准备、验证和最终事务返回后才 markPublished；生产 composition 使用文档 wake 包装，最终提交后才发 hint，失败仍向上传播。旧 5.0 记录等价重试继续保留原字节／链／C／Source。原 Core/SQLite 生命周期测试改用目录摘要或精确 Session 的单 Inbox 项证明，不在测试中拼回完整 Run；Inbox 编辑正文读齐并验证 proof，删除使用根的零集合证明。新增 Publisher 150 Inbox 项（旧 1 MiB Commit 明确拒绝）验证整个文档提交返回前不 ACK，读取第 149 项原文。这一项使用真实 Core 结构校验与内存 receipt/outbox，不能算超大 Core SQLite／强杀／窗口验收；实际 SQLite 生命周期只验证当前小 Run 的 ACK 与重放。

生产旧 scalar Run 读取发现新表示时，抛出独立的 PublicProjectionRepresentationUpgradeRequired。查询所有者将它返回 public_projection_contract_mismatch，不锁存健康；真正的存储损坏仍按原完整性门禁失败。真实 Core/SQLite 测试先 ACK 文档，再发旧查询并收到明确失败，后续同 owner 目录查询仍成功。Provider 管线测试观察到 terminal Conversation 已从 agent_run_linked 前进到 agent_result_projected，两个合法阶段保留同一 Run 身份；验证终态、唯一 Provider I/O 与恢复意图清空保持。组件纯生命周期策略移到独立模块，保留唯一状态所有者；330 行门禁没有扩张。

验证：正常 Schema 阶段 Runtime 141/1043、根集成 15/129（含类型）、App 78/324 与完整 App/Runtime 构建通过。Publisher 与明确契约失败接入后 Runtime 141/1045 全通过，根集成 15/129 与类型通过；最后纯策略提取后三个相关文件 36 项及 Runtime 干净构建通过。架构、九固定／六扩展 release-contract 通过，独立性 778 文件通过（提取纯策略前），未扩大基线。App 324 是 Schema 阶段的结果，不当作新 Publisher 的 UI 证明。详见 t02-normal-document-schema-*、t02-production-document-publisher-*、t02-production-document-policy-* 日志；失败复跑日志保留。

真实 Electron：electron-t02-normal-schema4 的完整 gate 和 desktop-restart-delivery 通过，69 次确定性 Provider 请求、66 响应、三次预期中止，providerTraceValid=true、五 Runtime 强杀／Main 重启／全部原场景、自动流式正文恢复通过；fatalError=null、consoleErrors=[]，恢复窗口 visible、bounds=(0,0,1364,863)。这是 Schema 4 配合旧 5.0 Publisher 的构建，不算已激活 6.0 Publisher 的窗口验收。随后 electron-t02-production-document-publisher 在两次 Provider 请求／响应后失败：验收脚本 snapshot() 仍调用 projection.snapshot.get 全量旧契约，遇到 6.0 Run 返回 public_projection_unavailable 并使旧查询健康失败。根因已定位到这个验收调用；上述类型化契约错误已解决产品侧健康传播，但当前脚本尚未迁移，也未复验修正后的完整窗口。旧 atomic-final 零请求启动失败仍无已证明根因，不能用不同构建通过抹去它。

容量：electron-t02-normal-schema4-capacity 和新增阶段计时的 electron-t02-normal-schema4-attribution 均 baseline 通过、initial 失败、未执行 Main 阶段。两轮首次启动触发原 15 秒握手超时，自动重启及明确 Runtime 强杀后可 ready；原查询边界通过不能覆盖额外进程失败。计时轮首 PID 129916 在 projection_schema_open=4178.2 ms 到 projection_schema_validated=12725.8 ms 用 8547.6 ms，随后进入完整历史审计并被期限中断；PID 151592 重启同阶段 597.4 ms、审计 2162.9 ms。该区间包括物理打开、精确布局/元数据/完整性校验和连接设置，尚未细分到具体 SQLite/文件操作，不能断言是 Schema 迁移或缓存的根因。没有增加期限、跳过审计、清库或把暖重试计成通过。原 150 Session/10k Message/82,766,850 字节夹具保留；它没有 Run，也不是 6.0 超大 Run 验收。现有用户桌面及真实目录不作验收清理。

最终只读检查：纯策略提取后独立性 779 个生产文件通过，完整验证矩阵来源存在，新文件没有尾部空白。所有验收 shell 已结束；剩余 Runtime 属于原用户桌面 Main PID 99716，没有清理用户进程或失败 TEMP。

下一条具体操作：先迁移 electron-smoke 及其恢复场景的旧 snapshot() 调用，普通列表只读固定 C 目录/窗口，选中 Run 的断言显式请求有界文档页/单项正文，不重建全量快照或放宽原断言；复验已激活 6.0 Publisher 的完整真实窗口。再将容量的物理打开/完整性检查计时细分，修复实际耗时所有者并复验原 baseline/initial/Main；继续超大权威 Run、COMMIT/ACK 强杀、旧 C、Runtime/Main/UI、安全回收及剩余 TODO。T09A 已登记并仍按 T09 后执行，所有任务保持未勾选；全部完成后才删除 TODO 并按用户要求直接关机。

## T02 文档投影真实窗口读取与启动分段计时（2026-10-06）

已迁移 electron-smoke、流恢复、调度、取消、工作流、目标、长期记忆、模型质量、文件和 Main 重启验收的旧 projection.snapshot.get 调用。测试探针在独立 smoke TEMP 内使用既有 Vite 构建为浏览器脚本，调用普通预加载桥接与生产 ProjectionRuntimeClient、页链校验器、正文仓库；正常应用不装载探针，不新增 IPC、业务所有者或全 Run 拼装。目录只读 models/sessions，诊断读取最新 32 条并保留 partial/complete 覆盖；每个 Session 的 Run 摘要、消息元数据/单项正文和推理前缀共享其确切 unfiltered Run manifest/C。夹具窗口限制 32 Session、总 128 Run、每会话 64 Message、128 prefix、单集合 128 项/8 MiB、总留存 16 MiB；超出声明的完整集合窗口会明确失败。未请求的 Run 集合不生成空数组。选中 Run 的断言显式请求所需集合；Main 重启按 Run/Input 精确查询验证 Inbox 缺失。

生产正文仓库现保留 PublicResultError。观察到的 Runtime 断线不再被误包装成完整性故障；实际 proof、字节、元数据和绑定错误仍按完整性处理，失败或失效仍释放物理请求/字节预留，不发布部分正文。删除过渡性的测试错误转译，验收仅在原有等待期限内按桥接错误码重读完整只读窗口。原断言和验收期限没有放宽。

强杀观察器识别原 5.0 DTO 和 6.0 Header.summary 的实际状态字段，校验 Run 身份/版本；非法或跨所有者记录不能成为待发布证明。推理 Provider 保持请求未结束，Renderer 先实际读到 running，再通过现有 workspace.document.save 在夹具目录保存观察证据，PS 验证后才强杀。若强杀恰在文件提交与回执之间，使用原 commandId 对应的准确文件内容读取核对，不自动重发写入；核对在原恢复等待期限内完成。没有增加固定延时、跳过 running 断言或将已发布 6.0 Run 当成 projection-pending。

三次中间 native 失败保留：electron-t02-document-probe 在零请求时拒绝合法目录墓碑；electron-t02-document-probe-tombstones 在 16 请求/14 响应/两次中止时，正文断线被包装为完整性错误；electron-t02-document-probe-recovery 在同样 16/14/2 时因 Provider 已触发强杀而错过短暂 running 状态，按原期限超时。相应缺陷已分别修正并有回归证据，不能改写这些记录为通过。

最终 electron-t02-document-probe-causal 完整 gate 和 desktop-restart-delivery 均 passed=true：70 次确定性 HTTPS 夹具 Provider 请求、66 响应、四次预期中止，providerTraceValid=true；五次 Runtime 强杀、自动流/重复丢序恢复、Inbox/问题/权限/取消/副作用与投影恢复、调度/目标/工作流/记忆/模型质量/实际文件操作、Renderer reload、Main 崩溃恢复及终端显式恢复均通过，fatalError=null、consoleErrors=[]。Main 重启证明输入收据先保留、精确 Inbox 缺失、显式 settle，以及终端中断/恢复可见。已查看最终窗口截图。此证据来自当前 Schema 4/唯一 6.0 Publisher/生产正文错误分类构建；它是小 Run 和确定性 Provider 的实际桌面验收，不是超大持久化 Core/ACK 强杀、真实模型、系统 IME、通知或受信签名安装包验收。

当前验证：根集成 15 文件/133 项含类型全通过；App 78 文件/324 项全通过并完成构建（renderer index-C-dvGcXR.js）；正文范围文件新增四项探针/生产错误分类测试覆盖目录墓碑、150 诊断有界覆盖、篡改拒绝、页外 Inbox 存在/缺失、未加载集合、超窗口拒绝、失败预留释放及旧 C 重读。边界观察器两项 Node 测试通过。Runtime Schema/启动计时两个文件 31 项及 Runtime 类型通过；Runtime 已直接 TypeScript emit 并重写 build manifest，本轮没有删除 dist，不能将其描述成新的干净构建。已有 Runtime 全套 141/1045 是前阶段结果。架构、九固定/六既有扩展 release-contract 通过，独立性当前 780 生产文件通过。App 测试中旧 scalar 源码断言失败已改为验证有界生产读端，最后 324 通过；原失败日志保留。

容量打开新增仅在原 capacity trace 启用时记录的固定阶段：所有者锁、SQLite 打开、精确布局/元数据、integrity_check、foreign_key_check、WAL/连接设置。正常运行没有计时输出。新增测试验证检查顺序以及诊断回调失败后关闭连接、释放锁并能保留数据重开。当前正在执行 electron-t02-physical-open-attribution 原 baseline/initial/Main 三阶段，仍使用原 150 Session/10k Message/82,766,850 字节和已 ACK 的 5000 handoff 夹具；没有 Run、没有阈值扩张、清库或跳过审计。此前两轮 first-handshake 失败与 8547.6ms/597.4ms 区间差异保留；尚未将耗时归因为缓存、迁移或其它具体操作。

下一条具体操作：读取本轮首次进程的细分 trace 与容量最终 JSON，区分实际失败、自动重试和人为强杀，修复已证实的耗时所有者并按原门槛复验；继续 T02 的超大权威 Run、最终 COMMIT/ACK 强杀、旧 C/Runtime/Main/UI 与安全回收。T09A 的 UI 优化保持在 T09 后、T10 前实施。T02 与其它未完成事项保持未勾选，全部验收后才删除 TODO 并直接关机。

## T02 容量首次完整性检查失败定位（2026-10-06）

electron-t02-physical-open-attribution 已结束：baseline 通过，initial 因首次 15 秒握手超时失败，Main 阶段未执行。首次 Runtime PID 158084 未达到 ready；自动重试 PID 154840 与人为强杀后的 PID 160412 到达 ready，但不能抵消首次失败。initial JSON passed=false、unexpectedRuntimeCrash=true、fatalError=null、consoleErrors=[]，29 次元数据查询保持有界，无 scalar 查询。

首次细分耗时：owner lease 1.62ms、SQLite 打开 0.58ms、布局检查 1.55ms，PRAGMA integrity_check 7222.04ms、foreign_key_check 91.12ms、WAL 配置 0.28ms，完整历史审计 2167.81ms；启动投影 drain 开始后被握手超时终止。后续两个 Runtime 的 integrity_check 分别 474.41ms/478.03ms，ready 分别约 7572.09ms/7544.72ms。该证据定位到具体检查区间，尚不能确定冷缓存、系统安全软件、磁盘或其它等待的原因。

为进一步归因，在明确容量 TEMP 观察器的每个固定阶段记录累计 user/system CPU 微秒及数字 wallTimeMs，私有点格式升级为 v2；现有 PS 采样增加实际进程开始时间与 Win32_Process 累计 read/write transfer/operation 计数。计数包含缓存读取及其它进程 I/O，不能直接当成物理磁盘读量。正常 Runtime 不启用观察器，不改变握手期限、数据库布局、审计或事务配置。四项观察器测试、Runtime 类型及 PS 语法通过；Runtime 直接 emit/manifest 未删除 dist。

下一步：按原夹具与原验收期限复验，区分首次/自动重试/人为强杀，并用 CPU 区间与 I/O 采样定位真实瓶颈；再完成超大 Core/ACK/crash 与 T02 回收策略。全部未完成项继续保留，不删除 TODO、不关机。

## T02 容量三阶段与超大 Core/ACK 实际强杀（2026-10-06）

electron-t02-cpu-io-attribution 原容量全 gate 通过：baseline、initial 首次启动及 Runtime 强杀恢复、main-restart 均 passed=true、unexpectedRuntimeCrash=false。原 150 Session/10k Message/82,766,850 字节夹具保持；首次界面 7935.09ms、Main 重启 8021.13ms，Runtime ready 7578.61/7664.49/7652.64ms。完整归因在 t02-startup-cpu-io-full-gate.json、t02-capacity-cpu-io-analysis.json。三个大库 integrity_check 478–483ms，其中 CPU 453–483ms；历史审计约 2036–2076ms/CPU 2187–2265ms，从零 Conversation 重放 drain 3864–3934ms/CPU 4110–4187ms。进程读取计数包括缓存与其它 I/O，不是物理磁盘字节；缓存状态未受控，本次通过不能解释或抹除上一轮 7222ms 检查及首次 15 秒超时。

新增 scripts/benchmarks/run-document-core-ack.mjs 通过真实 Core 命令持久化 6 个 Run 版本/命令收据，五条 96,000 UTF-16 输入，总旧 DTO 1,441,316 字节，旧 1 MiB Commit 明确拒绝。使用真实 SQLite authority、收据、Outbox、生产版本 reader/interaction resolver、唯一 document Publisher 和普通 Schema-4 Projection owner。三个独立 TEMP 的 Node 子进程分别硬杀于最终 COMMIT 前、COMMIT 后 ACK 前、ACK 后；最后版本持久化状态/ACK 分别按预期 5/10、6/10、6/12，未 ACK 的 2 条事件在重开所有者后立即回收，不等待租约超时。按同一事件/命令重试仅收敛到原 C7，不重复版本或历史；后续真实 replace 推进 Run7/C8，旧 C7 完整恢复旧正文、新 C8 读取替换正文。每个原正文两块，最大响应 352,644 字节。证据 t02-run-document-core-ack-fourth.json；此结果为真实 durable Core/Publisher/Node 强杀，尚不是 Runtime ingress、Electron 或生产 keyring 验收。

脚本中间失败保留：Windows TEMP 短路径与物理完整路径比较、漏传 Core 必需空 payload artifacts、把每命令两条 Outbox 事件误算为一条。已按实际接口与收据纠正。没有伪造 aggregate、写入原始 authority SQL 或放宽 Core 内容限制。

实际 Electron 增补：在原权限拒绝 Run 等待 Decision 时经普通桥接排入五条 96k 正文，使用同 C/完整单项读端验证超大集合，并在真实 Inbox DOM 显示全部正文；保留权限拒绝与随后五次原 Runtime 强杀。独立恢复 helper 校验 Renderer reload 和 Main 重启后同一终态 Run 的五个精确 inputId/version/body。第一轮 electron-t02-oversized-core-native 已证明大正文写入/DOM，后续 crash_question 因新增界面验收切换了当前会话而违反原测试的 direct-session 归属断言，整体失败、Main 未执行。已在 UI 观察后恢复原会话并等待实际选中/范围 ready；原断言与期限不改。App 构建/三类型、78/324 与架构通过。下一轮完整 gate 待收取，不能计为通过。

剩余：确定首次慢检查原因/有界启动成本，收取当前超大真实窗口恢复结果，完成 T02 安全回收与其它按序 TODO。T09A 未开始；全部完成及 T16 通过后才删除 TODO 并直接关机，用户已再次强调不询问。

## T02 超大窗口恢复、启动回收与提交校验归属（2026-10-06）

状态：进行中，未勾选 T02。electron-t02-oversized-session-restored 与 electron-t02-oversized-reclamation 两轮完整真实 Electron gate 及 Main 重启均通过；后一轮覆盖准备回收的初始实现。五条实际 Core Inbox 输入各 96,000 UTF-16 字符，总集合 1,441,221 字节；精确身份、版本、完整正文、五个真实 DOM、终态保留、Renderer reload 与 Main restart 均验证。原 70 次 HTTPS 确定性 Provider 请求／66 响应／4 预期中断及五次 Runtime 强杀仍通过，fatalError=null、consoleErrors=[]。并非真实模型或 native IME 验收。首轮切换会话造成的失败继续保留。

已实现 RunDocumentStartupReclamation：新 Projection 所有者先完整审计，在开放查询前只回收一个 published_cursor=NULL 的准备根、最多 8 块与 8 个已无块项。事务回滚可恢复；缺失 publication marker 的已发布版本按损坏拒绝，禁止当垃圾删除；审计与回收前后的 data_version 围栏拒绝外部正文写入。存量 5.0 查询可以依赖未发布的派生准备根，所以禁止运行中／append／定时回收。重试从不变的权威记录重建缺块。正文页释放为 SQLite 可复用页，不声称物理缩库。四项 SQLite 测试验证旧 C 正文、部分回收重建、回滚、发布标记损坏和审计后外部写入；t02-final-reclamation-runtime-tests.log 为 142 文件／1,050 项通过。

保留策略：Message、Run、Decision、Diagnostic、Inference Stream 的已发布版本、原 Commit 字节、Source checkpoint、历史摘要及墓碑全部保留；快照租约和增量 C 依赖这些记录，不设静默丢弃期限。Renderer 有界淘汰只回收缓存，不删除历史。允许回收的数据限于新所有者尚未开放租约时的未发布准备区；用户历史删除／归档压缩交由 T11 的明确清理流程，不绕过权威、旧 C 或重放证明。当前保留水位为原链起点，已发布历史不压缩。

最终回收围栏构建的原容量全 gate electron-t02-final-reclamation-capacity 通过：150 Session、10k Message、82,766,850 序列化字节，baseline／首次启动及 Runtime 强杀恢复／Main 重启全部 passed 且 unexpectedRuntimeCrash=false。首次界面 11,176ms，Main 7,777ms；Runtime 首次 ready 7,308ms、强杀恢复 10,754ms、Main 7,350ms。恢复阶段另观察到 Conversation open 3,721ms，保留完整 trace；完整性检查约 478–484ms，历史审计约 2.03–2.06s，重放约 3.61–3.65s。见 t02-final-reclamation-startup.json。本次缓存不受控，不能抹除更早 7,222ms 检查导致的首次 15 秒握手失败。

只读实验 t02-projection-sqlite-cache-comparison.json 首次 2MiB 缓存检查 6,674ms／CPU 688ms，其余热样本 2／8／32MiB 约 211–250ms；t02-projection-read-ahead-comparison.json 热缓存预读总计约 256–258ms、直接检查约 214–217ms。没有证明缓存增大或预读收益，生产未启用这些调整，也未延长握手或跳过完整审计。

确实存在同一提交在 Publisher、准入和最终事务重复 Schema／安全校验。PublicProjectionContract 只对协议解析器的新 JSON 树冻结全部层级，用 WeakSet 识别已验证身份；不冻结调用者输入，不信任任意 frozen 对象，不强引用历史。StoredProjectionRecords 的 5.0 路径复用此校验；持久化行字段／canonical JSON／payload digest／history link 仍全量核对，6.0 文档证明不变。三项所有权测试与原重放／Publisher 共 21 项、类型、架构通过，最新全 Runtime 为 143 文件／1,053 项。真实同夹具 10,430 条记录重放从 3456.24ms 降到 2324.89ms；前后 Commit/C/字节保持不变，但总启动与缓存样本不能作最坏耗时保证。见 t02-conversation-replay-before-ownership.json、t02-conversation-replay-owned.json。

下一条具体操作：收取提交归属优化后的原三阶段容量 gate，再复验超大真实窗口及 Main 恢复，刷新正式证据；根据实际固定边界／升级／恢复验收收敛 T02。启动 I/O 等待仍未确定物理原因，不伪称已解决。随后按原依赖进行 T03、T04 及其它任务，T09A 保持 T09 后实施；全部完成并通过 T16 后删除 TODO、直接关机，不再询问。

## T02 当前范围验收收敛与 T03 开始（2026-10-06）

任务 ID：T02；状态：完成（当前分页／容量／升级／恢复范围）。最终构建 electron-t02-owned-commit-capacity 原 150 会话／10,000 消息／82,766,850 字节三阶段全部通过，无意外 Runtime crash；首次 UI 6,362.70ms、Main 6,439.45ms，三次 Runtime ready 6,059.41／6,017.46／6,090.20ms。重放 2,296.82–2,338.10ms，完整历史审计 2,047.58–2,077.64ms、完整性检查 482.58–502.53ms；没有扩大限制／期限、跳过审计或删已发布历史。最终超大真实窗口 electron-t02-owned-commit-native 全 gate 与 Main 重启通过；同五条 96k Inbox 正文共 1,441,221 字节，显示、精确输入投递、Renderer reload、五次原 Runtime 强杀、终态/Main 恢复均通过。最终真实 durable Core 的三处 COMMIT/ACK Node 强杀亦通过（t02-run-document-core-ack-owned.json），最大块响应 352,645 字节，原 C／历史／命令收据保留，实际 replace 推进新版本后旧正文仍可读。

已满足本项：固定 C 与作用域分页／增量、行与字节双界、分块单实体、有界 Renderer 缓存和真实覆盖、实体更新／删除与连续扫描、损坏与 reset／表示升级区别、正常 Schema 3→4 升级、唯一生产 Publisher 提交后 ACK、启动完整审计及仅未发布准备区的安全回收。已发布消息／运行／决策／诊断／推理流／墓碑保留，不压缩原链；用户历史清理仍归 T11。跨规模 append SQL／延迟已有 t02-projection-capacity.json 证据，追加只访问当前变化实体，后续目录和文档端沿相同 ledger 不执行全快照重建。搜索完善归 T13、任务总览归 T10、UI 改版归 T09A，均没有被本项完成代替。

最终验证：Runtime 143 文件／1,053 项；根集成 15／133 及类型；架构、固定九持久契约与六既有扩展通过。App 上一同接口构建及 78／324 通过，最终真实 Electron 使用该 Main／Renderer 与新 Runtime；没有声称 App 重新构建。最后截图已人工检查，Runtime 就绪，右侧 Agent 状态仍为通用列表，T09A 未优化。更早整体失败和首次慢检查留存，缓存未受控，不能保证冷缓存／系统 I/O 阻塞的最坏启动耗时；本次消除了已证明的重复校验 CPU 开销，没有伪称物理等待根因已确定。T16 必须按最终全仓构建重新验收容量和恢复，并保留这一性能限制。

整仓 verify:source-snapshot 本次明确失败：预期 npm 11.13.0，当前 12.0.2，且 Git 工作区包含用户未提交工作；证据 t02-owned-commit-source-snapshot.log。不清理用户改动或改锁定版本伪造通过，后续 T16 使用独立干净构建材料／指定工具链验证。T01 可信发布签名仍待环境，不勾选；T04 及全部其它项目未完成，不删除 TODO、不关机。全部通过 T16 后直接关机的授权继续有效，不询问。

任务 ID：T03；状态：进行中（生产链审阅完成，尚未实现／验收）。确认 Schedule／Workflow／Goal 任一 failure 由 AgentEntityHandle.assertHealthy 汇入 ComposedRuntimeIngress 的全命令准入，并被错误解释为 projection unhealthy；初始 worker.start 失败还能阻断全 Runtime ready。Workflow／Goal 扫描在单个任务异常时整体退出。下一条具体操作：建立带来源／发生时间／恢复方式的域级健康与命令依赖准入；将持久化损坏保留为受影响域不可用、已知单任务异常隔离；先保证未知命令／副作用沿原收据对账，不能清空 failure 自动重做。独立健康读端不能依赖损坏 Projection，正式诊断与 UI 沿同一健康模型呈现，再验收另一会话仍可使用、核心损坏拒绝和受控恢复。

## T03 域级准入与独立健康读端（2026-10-06）

任务 ID：T03；状态：进行中。实际 AgentEntityHealth 归属执行／投影及 Schedule、Workflow、Goal 五个已注册域。后台 start／扫描失败只锁定其域，继续其它工作器；自动启动命令按实际后台依赖拒绝，普通会话操作不因无关工作器失败而拒绝。健康记录仅含固定域、来源、发生时间、修订号、可用性、失败分类与恢复方式；未注册域没有伪造 healthy。当前执行／投影仍为共用核心准入，精细存储依赖尚未完成。

runtime.health.get 是独立只读元数据接口，在损坏投影准入与命令 Journal 之前读取；不访问业务存储，不形成命令收据。Renderer 单个物理在途请求独立轮询，重启时旧代结果丢弃，实际结束前不释放请求保留；诊断 Store 与全局状态栏沿同一读端呈现故障模块／恢复建议，未知结果显示不可读。领域 Run 状态不由该健康模型重建。恢复基础设施具备修订号核对及实际回调／健康复验，但生产恢复入口与任务收据对账尚未接通，不能声称已经可恢复。

验证：Runtime 全量 144 文件／1,062 项通过（t03-health-read-full-runtime.log）；Protocol 16／93 通过（t03-health-full-protocol-tests.log）；App 79／328 与构建／类型通过（t03-health-ui-app-tests.log、t03-health-ui-app-build.log）；架构最终通过（t03-health-ui-final-architecture.log），未提高文件边界。真实 SQLite 生产 Actor 注入单 Workflow 扫描故障时，另一 Session 可写，自动 Workflow 被拒绝，Schedule 仍健康；独立健康查询在拒绝投影与损坏 Journal 时返回安全元数据，私有异常不进入协议。Reader 测试覆盖重启跨代、一个实际在途请求及 dispose 迟到响应。

真实 Electron 正常路径 electron-t03-domain-health-ui 全 gate 与 Main 重启通过，保留原 70／66／4 Provider trace、超大 Inbox／Renderer reload／Runtime 强杀和终态恢复，fatal=null、consoleErrors=[]。这是确定性 Provider 夹具的正常路径回归，不是故障 UI 验收或真实模型验证；最终截图仍含通用 Agent 列表，T09A 未实施。该产物运行后源码又加入 pre-start 防误锁、degraded 后失败升级及终态纯函数移出 RuntimeStore；最后 Runtime 测试与架构已验证这些源码，但还须重新发射 Runtime／构建 App 后才可认为新产物验收。

尚未完成：SQLite／权威持久化错误的可信分类与域归属、单任务持久隔离、所有命令精细依赖、生产收据绑定恢复、真实故障 Electron UI 验收。不能把所有 Error 当数据损坏，不能仅清空 failure 自动重做未知外部操作。下一条具体操作：在真实 SQLite 事务所有者和三个权威适配器建立类型化完整性／不可用错误，保留原异常及未知 COMMIT 对账，接入实际源健康；再建立任务隔离与恢复。T03 未勾选。全清单通过 T16 后删除 TODO 并直接关机，无需再次询问。

## T03 权威源错误归属与命令依赖（2026-10-06）

任务 ID：T03；状态：进行中。SqliteTransactionOwner 为 execution／conversation／productivity／memory 绑定来源；只有持久化解码器明确标记的错误或实际 SQLite CORRUPT／NOTADB 才成为完整性故障，READONLY／IOERR／FULL／CANTOPEN 属于源不可用。BUSY／LOCKED、约束／CAS 冲突、普通回调 Error／SyntaxError 不凭文本或前缀升级。首次异常保持原类型及原因；失败源锁定后，已经排队但尚未执行的操作也拒绝。ROLLBACK 失败保留两个异常并锁定连接未知状态，关闭屏障仍可排空与释放。提交后普通丢失响应不误锁，仍通过原 commandId 收据读取真实提交，不自动重做。

实际 Agent 事件／Outbox／执行意图、Conversation authority／Handoff 持久行解析，以及 Productivity Goal／Workflow／Todo／Schedule／命令收据读端接入源错误证据。新健康模型增加实际 Conversation 和 Productivity 探针。已有 Directive lookup_mismatch 原来错误使用 storageCorruption：现改为引用不变量拒绝，持久正文摘要独立比对自己的持久 digest，摘要损坏仍锁定 execution。原安全断言保留；两种 Agent Outbox 损坏和两种恢复索引损坏分别用独立数据库验证，再断言后续操作被阻止，不能靠已锁定状态代替第二种损坏的检查。

AgentCommandHealthPolicy 由现有唯一 ownerTable 的 diagnosticSnapshot 编译，不维护第二套命令注册。新增 owner 没有分类时组装拒绝。Conversation 写入／消息、Projection、Run／Decision／Inbox、Productivity、LongMemory、文档和 Skill 分别按实际读取源判断，自动创建／恢复增加执行及工作器依赖；Kernel 自己的基础状态／模型／可选标题请求不访问 Agent 存储。当前已接入执行、会话、投影、生产力与三个扫描器共七个健康域。记忆源具体探针、推理／文件／Journal 健康源及全覆盖仍待下一步，不能把未注册域当已验证健康。Worker 故障不会被解释成 Projection 损坏。

验证：Runtime 全量 146 文件／1,074 项通过（t03-authority-command-health-full-runtime.log）；根集成 15／133 及类型通过（t03-authority-command-health-integration.log）；Runtime 类型与架构通过，Actor 仍在 250 行边界内。固定九持久契约和六既有扩展通过（t03-authority-command-health-persistence-contract.log），未改旧契约／数据库布局。实际 NOTADB 拒绝第一操作并阻止已排队回调；损坏实际 Productivity JSON 拒绝读取及后续覆盖写，独立 Conversation 仍可读；failed ROLLBACK 保留原异常；after-COMMIT 原收据仍可对账。四个源／命令依赖新测试覆盖来源隔离和新增 owner 拒绝。

Runtime 已直接发射并生成 manifest，没有清理 dist 或影响用户现有进程。App 全三种类型及最终构建通过（t03-authority-command-health-app-build.log，Renderer index-fCNsGpjO.js）。使用这组产物的原完整 Electron／Main gate 正在运行 electron-t03-authority-command-health，结果尚未记录为通过；先前健康路径通过仍仅对应先前产物。源文件后续如有变化必须再次发射后验收。

剩余：启动时实际权威内容审计与损坏可选源的生产组装隔离，避免通过重启仅重置内存锁；持续记忆模型失败／恢复归属；任务级持久隔离及已知业务不变量分类；修订号／原收据绑定的恢复接口；真实故障 UI。当前 Productivity 物理 Schema 2 与已释放布局保持原样。下一条具体操作：在同一 Productivity 所有者设计明确版本的任务隔离存储，冻结现有任务／命令身份及原 JSON，验证升级备份、回滚和恢复；之后让 Workflow／Goal／Schedule 只隔离经类型证明的单任务错误，未知错误／共享存储失败保持工作器暂停。任务结果未知不能伪装为 terminal failed，不能清空 failure 自动重派。源恢复必须审计并对账，当前没有完成该恢复。T03 和总体 TODO 未完成；全部通过 T16 后删除 TODO、直接关机，无需再次询问。

## T03 原桌面回归、内部派发准入与任务升级准备（2026-10-06）

任务 ID：T03；状态：进行中。electron-t03-authority-command-health 原完整真实窗口 gate／Main 重启已通过：原 70／66／4 Provider trace、超大输入、Renderer reload、Runtime 强杀、终态恢复和终端人工恢复均保留，fatal=null、consoleErrors=[]。实际数据根 AriadneSmoke-dc01e0550dda47ec822738614b0b34aa 位于 TEMP。最终 terminal-main-crash-recovery.png 已查看：Runtime 就绪、Main 中断终端提示与人工恢复可见，聊天保留未确认输入；这不等于故障健康 UI 验收。该 gate 证明 source-bound authority／命令依赖产物，未覆盖随后加入的内部派发准入。

后台 Schedule／Workflow／Goal 原来直接调用 publicCommands，绕过外部准入。已改为进入同一 AgentEntityHealth.execute，仅将准入拒绝转换为固定域错误，实际 mutation 异常仍保留原 owner／Journal 结算；不会把已执行但响应未知的变更伪称为未提交。内部 guard 五文件／56 项、类型、架构通过；最新 Runtime 全量 146／1,075 通过（t03-internal-worker-full-runtime.log），随后直接发射并刷新 manifest。App 源码及构建保持前一已通过产物。后续最终 T03 gate 应包含内部 guard，不用旧 gate 冒充覆盖。

任务隔离准备：ProductivityAuthorityAudit 按实际 Schema 2 固定物理摘要校验、完整 SQLite 检查，并逐行校验 Goal／Todo／Workflow／Schedule、Occurrence 身份、命令收据及事件绑定，计算包含原 JSON 字节的源摘要，未做规范化或删除。ProductivityTaskIsolationSchemaV3 仅定义同一数据库内新增的固定分类任务故障元数据；函数要求 Schema 2 已有事务，最终 user_version 发布由未来有备份／审计的升级 COMMIT 所有。当前生产 opener 仍 Schema 2，此 V3 准备未被调用、未启用任务隔离、未改变用户数据或释放布局基线。

准备测试 1 文件／6 项通过（t03-task-isolation-audit-tests.log）：实际带 Goal、Todo、Workflow、Schedule、Occurrence、收据与事件的 13 条源记录摘要稳定；三种绑定／收据／Occurrence 损坏在任何新表创建前拒绝；未持有事务时新增 Schema 拒绝，DDL 中断后回滚恢复同一源摘要；未知物理布局保持原收据并拒绝。类型通过（t03-task-isolation-audit-types.log）。这尚未证明离线备份、Schema 2→3 最终发布、恢复和生产接线。

下一条具体操作：完成已审计源的同库任务隔离版本升级，逐字验证备份与回滚、固定 schema 摘要、幂等重开和较新库拒写；新增明确的版本化扩展与布局声明，保留原九契约、原 Schema 2 布局和旧 JSON／收据身份。之后接入唯一 Productivity 写边界中的故障记录／查询及恢复 CAS，Workflow／Goal／Schedule 只捕获类型化任务不变量并持久隔离；共享存储、未知异常及未知外部结果不能自动重试。启动源验证／可选源隔离、记忆／推理／文件／Journal 健康源与故障 UI 仍待完成。T03 保持未勾选；所有 TODO 经 T16 验收后直接关机，无需再次询问。

## T03 任务隔离升级与同库元数据准备（2026-10-06）

任务 ID：T03；状态：进行中。已实现尚未激活的同库 Schema 2→3 准备：ProductivityTaskIsolationV2ToV3Migration 获得原数据库独占 owner lease，验证固定 Schema 2、完整性与全部业务行，生成并读回审计 VACUUM 备份；最终 BEGIN IMMEDIATE 内再次核对源摘要后添加故障表与索引，核对原业务行／JSON／收据摘要未变、完整性及精确 Schema 3 摘要，最后 COMMIT 发布版本。任何中断或验证失败回滚 DDL、同事务业务变更和版本；备份后外部源变更保持原样并拒绝升级，不能将不匹配的备份视为有效。Schema 3 重开同样校验物理布局、业务源和隔离行身份；更高版本不写。新布局摘要 sha256:975154911054ab45cb575773ceaeb87d30a40973469c23cf05b2b28a270eb783 是新扩展准备，不替换原 Schema 2 释放基线。

SqliteProductivityTaskIsolation 与独立 ProductivityTaskIsolationV1 扩展记录同一权威中的故障元数据。记录绑定原 parent owner Session 与具体任务 Session、原 create／submit commandId、messageId、源版本和源阶段；固定故障分类、发生时间、revision 和状态全部纳入记录摘要。Workflow／Goal 的来源还核对原版本不可变 execution event，Schedule 核对原 occurrence 身份；只返回不含 prompt／正文／命令身份的有界按父 Session 分页 DTO。记录要求已有事务，重复 quarantine 保留原修订与时间，回滚只撤销元数据；不改变任务业务状态，不发送请求。任务仍 claimed／running，未知 Schedule 仍 pending／attempts=0，不伪造 terminal failed。

验证：1 文件／14 项通过（t03-task-isolation-record-final-tests.log）；源类型与架构通过（t03-task-isolation-record-final-types.log、t03-task-isolation-record-architecture.log）。实际命名 TEMP 数据证明备份可恢复为当前 Schema 2 并保留同一业务源摘要；DDL 后确实通过同一升级事务修改原 Goal，再由验证失败同时回滚，不把另一连接 SQLITE_BUSY 当作数据回滚证据。外部源变化检测、备份重试验证、较新库拒写、隔离重开、原任务状态保持、元数据事务回滚、submit identity／resolved 状态被擅改时拒读、作用域隔离和两页 body-free 读取均通过。

当前生产 opener、PRODUCTIVITY_DB_SCHEMA_VERSION、schema-compatibility、database-layout 仍为 Schema 2。新升级函数与 mapper 未接生产，不注册 CLI、不触碰真实用户库；源码尚未发射为这部分新构建。T03 没有“任务已隔离”或“已可恢复”的生产验收。接下去须完成受控恢复的原收据／Saga／Run 对账及 revision CAS，激活经过验证的 Schema 3 初始化和原 2→3 正常升级（保留必要 1→2 离线维护），增加明确扩展／布局契约再接唯一 ProductivityStore 事务。随后工作器按类型捕获单任务错误、跳过已隔离任务并继续独立任务，未知异常／共享源失败仍暂停；Schedule 分页必须在 SQL 选择前排除隔离行，不能先取有限行后过滤而饿死其它任务。健康 degraded、可信诊断与 UI 需接同一元数据，最终注入实际故障验收恢复、不重复副作用和其它会话可用。启动源审计／损坏可选源组装及其它健康源仍待接线。全 TODO 经 T16 验收后删除文档并直接关机，授权持续有效。

## T03 生产任务隔离、源启动隔离与真实故障窗口（2026-10-06）

任务 ID：T03；状态：进行中。生产 ProductivityStore 已采用 Schema 3，同一 owner lease 内审计并备份原 Schema 2，然后在最终事务再次核对源摘要、添加故障元数据并发布版本；没有双重取得 lease，也不重写原业务 JSON／收据。Schema 3 重开在同一读事务校验精确布局、完整性、全部原权威行和故障行。必要的 1→2 离线维护明确以旧基线 2 为目标，之后正常 opener 再升级至 3。database-layout.json 的原 Schema 2 摘要未被覆盖，另有 productivity-task-isolation-layout-v3.json 精确声明同一路径的八张表及新摘要。旧冻结九访问契约、六既有扩展均保持。

Workflow／Goal／Schedule 只捕获 ProductivityTaskInvariantError 对应的原回执／Saga／Run／结果／取消身份冲突，写入同库故障行并继续独立任务。未知异常和共享权威损坏仍锁定整个源／工作器；单个任务的业务阶段、原 create／submit／message 身份、未知结果及尝试计数保持。所有工作器实际派发仍经 Actor 的域准入。Schedule 的待执行、在途和 claim SQL 在选择及 LIMIT 之前排除未恢复任务，过期扫描不会把隔离中的未知第八次尝试写成 failed。来源不可用的公开拒绝保持 uncertain，不误记为身份冲突。工作器从真实故障行派生 degraded 信号；恢复后无隔离任务时只清除该派生状态，不能清除更新的源／整个工作器故障。

ProductivityTaskRecovery 的内部受控恢复没有 dispatch 接口。开始与结束各用短事务，reconciling 期间仍被隔离；核对原创建／fork 指纹、原提交收据、原消息完整摘要、Saga、精确 Run 绑定与必要的投影结果，恢复 CAS 还核对当次任务源摘要。证据不全、不同 Run、恢复期间源版本改变、旧恢复完成或新故障均不能放行。异常恢复保留原异常并保持隔离。实际 SQLite 生产 Conversation 与 Worker 测试证明其它任务可继续、源阶段未伪造终态、原消息／Saga 不重复及重新打开故障元数据可校验；Run 观察是结构化夹具，这不等于真实 Provider/Core 恢复验收。该恢复类尚未注册公开命令／用户按钮，且尚无普通 commandId 绑定的持久恢复阶段收据；不能宣称用户已有可恢复闭环。下一步将恢复阶段接入同一 Productivity owner 的原收据存储，再接协议、IPC／Renderer 和真实故障／未知 COMMIT 恢复验收。

可选源启动隔离：Productivity opener 已完整校验持久内容，明确标记的损坏／不可用／需维护版本错误在连接与 lease 确认释放后隔离该源，独立 Core／Conversation／Projection 可继续。关闭失败保留原异常与 cleanup 异常并停止组装；任意编程错误／竞争 owner lease 不能被当成正常可选失败。缺席故障源没有伪报已打开 Schema 3。完整坏 JSON、原业务字节保留和其它 Session 写入经生产 Factory 验证。其它记忆／推理／文件／Journal 探针与启动关键源失败诊断仍待完成，独立健康读端目前在 ready 阶段。

验证：Runtime 147 文件／1,099 项通过（t03-task-isolation-source-audit-full-runtime.log）；后续只增加布局声明断言，任务隔离／固定布局 2 文件／24 项通过（t03-task-isolation-explicit-layout-tests.log），不虚报全量 1,100。Root integration 15／133（含类型检查）、App 79／328、App 三类类型与构建、架构、九冻结访问及六既有扩展发布契约均通过。Runtime 已直接发射并写 manifest，没有删除运行中的 dist。App 最新 renderer index-DFZvQLZj.js、Main 428.26 kB；专用验收模块 domain-health-smoke-DAf7gQrc.js。

真实 Electron 故障验收 electron-t03-productivity-source-fault-native-path：独立 AriadneDomainHealth 命名 TEMP 数据先通过原 Store 写入合法 Goal，然后注入格式错误的持久 JSON。initial 与 main-restart 两轮均通过：Runtime ready，execution／conversation／projection healthy；Productivity 及依赖扫描器 unavailable；独立健康查询成功，实际桥接 Session 写入成功，故障源命令按 runtime_productivity_unavailable 拒绝，真实 DOM 页脚显示对应警告，私有标记未进入页面；fatal=null、consoleErrors=[]。两轮后原损坏数据库 SHA-256 与注入后完全相同，未清空／修复／写坏库。截图已检查，故障提示确实可见；没有 Provider／模型调用，也没有真实输入法、通知或用户恢复按钮验收。首次两次路径检查失败完整保留，尚未启动桌面；Windows realpathSync.native 统一 NTFS 长／短路径后才接受正确 TEMP 边界，未放宽目录限制。全部验证过程结束，专用进程已关闭，真实用户数据未用于故障测试。

剩余：公开且有 commandId 持久阶段收据的任务查询／恢复、已终态源故障的恢复规则、单任务 degraded 的真实窗口验收、其余实际健康源与关键启动失败诊断、最终完整正常桌面回归。T03 保持未勾选；T09A 仍按 T09 后顺序执行。T01／T16 的签名、清洁源码工具链与其它环境门槛没有宣告通过。全部 TODO 经 T16 完成、正式文档更新、最后删除 TODO 后直接关机；无需再次询问，关机授权持续有效。

## T03 公开任务恢复、原命令引用与真实窗口（2026-10-06）

任务 ID：T03；状态：进行中。公开任务故障分页、恢复命令和恢复 claim 引用已经接入唯一 Actor、Journal、Productivity owner、实际 IPC 与 Renderer。三个新 V1 扩展单独冻结；原九访问及六既有扩展不改。恢复开始／完成收据与不可变 claim 引用使用原 productivity_commands 的同事务写边界，没有第二账本、新执行 owner 或 Schema 变化。窗口重载时按当前 claim 查询原 commandId／expectedRevision，对账原恢复意图；并发新 claim 不覆盖旧命令自己的完成回执。核对不会 dispatch 原任务。

终态源仍核对原创建／提交／消息／Saga／精确 Run 及实际结果投影；无终态证据保持 unknown，不能编造 failed。源摘要包括原 JSON 字节，同版本内容变化也拒绝放行。实际 SQLite 事务测试覆盖开始／结束 COMMIT 前后异常、关闭重开、提交后回复丢失、原回执重放、新 claim 超越旧 claim、源内容变化及已终态证据。用户组件覆盖会话切换迟到结果、单个在途操作、快速重复点击、原身份重试、安全异常、有界分页、窄窗口与任务会话导航。

最终全量：Runtime 147 文件／1,106 项（t03-recovery-reference-full-runtime.log），App 80／334（t03-recovery-reference-full-app.log），Protocol 17／95（t03-recovery-reference-full-protocol.log）；后期目标 Runtime 3／64、App 恢复 Store 6 项及架构／释放契约通过。Root 15／133 及类型对应不可变 claim 引用补充之前，不能当补充后的重跑。Runtime 直接发射并写 manifest；App 类型和构建通过，没有删除用户运行中的 dist。

真实 Electron electron-t03-task-recovery-pending-resume initial／main-restart 均通过：初始从已提交 reconciling 修订 2 使用原 task-recovery-prestarted 命令恢复核对至隔离修订 3；Main 重启后新恢复至修订 5。实际 DOM 按钮、证据不足反馈、独立 Session 写入和健康接口可用；fatal=null、consoleErrors=[]。两轮原任务业务摘要不变，原任务 Session／Saga 均未创建，原完成恢复回执两条。最终截图已查看。没有真实 Provider 推理；任务证据不足仍 unresolved。这证明持久中间状态重开，不等于恢复事务期间实际 Runtime 强杀。

原正常完整 Electron gate electron-t03-public-task-recovery-normal 与 Main 重启通过，包含五次原 Runtime 强杀；其产物早于最后不可变 claim 引用补充。源损坏窗口 electron-t03-productivity-source-fault-native-path 保留原坏库字节且独立核心继续，证据仍有效；恢复窗口不代替坏源字节保持断言。所有注入仅用命名 TEMP，专用进程均已退出。真实输入法、通知、模型和最终全功能桌面验收没有宣告完成。

剩余：记忆／推理／文件／Journal 实际健康探针，关键启动失败的独立诊断、恢复阶段实际进程强杀与最终正常全路径验收。T03 未勾选，T09A 继续按 T09 后实施；T01 签名及 T16 清洁指定工具链、其它按序项目仍待完成。全部 TODO 经 T16 验收、正式文档更新、最后删除 TODO 后直接关机；授权继续有效，不询问。

## T03 长期记忆真实源审计与可选故障隔离（2026-10-06）

任务 ID：T03；状态：进行中。LongMemory 重开不再只接受 user_version=1：同一只读事务验证冻结布局、SQLite 完整性、逐行原正文／作用域／时间／版本／墓碑／历史收据和 FTS／向量绑定。不创建迁移、不规范化原 JSON、不重建索引、不修改布局声明。持久解码只标记 memory 自己的错误；已排队但尚未执行的写入拒绝，输入／CAS 冲突不误锁。constructor cleanup 失败保留两个异常与原 fence，不伪装隔离成功。

独立 typed health service 接入原 capability → services → manifest → Actor，冻结 LongMemoryAuthority 不加成员。明确源故障且 opener 清理成功时不提供 memory authority／memory.manage，固定 Tool 文档目录保持；没有权威的工具明确拒绝。已确认的记忆源故障可省略可选记忆指令，未知错误继续抛出。记忆命令按 memory／conversation 拒绝，独立会话创建继续。实际健康域增加为八个，推理／文件／Journal 尚未注册。不把正常词法近似配置当存储坏源。实际嵌入模型失败显示 degraded；仅查询向量成功不清除失败，整次召回和结果复核完成后才清除派生降级，较新权威失败继续锁定。

验证：源审计／固定布局／原 Store／召回 4 文件／40 项通过；后期健康／capability／命令依赖 5／52 通过；最后 Runtime 全量 148／1,123（t03-memory-source-full-runtime.log），类型、架构和固定释放契约通过，原九访问及既有扩展均保持。初次模型结果状态时序与类型循环／固定 Tool 目录缺失失败留存；修正实际边界，没有抬高架构阈值或改冻结目录。Runtime 已直接发射并写 manifest，App 三种类型／构建通过，没有删除运行中的 dist。随后仅全局健康提示区分 task_quarantined 与 external_unavailable，不能把模型降级提示成任务隔离；最终构建验证继续。

真实 Electron electron-t03-memory-source-native initial／main-restart 均通过：命名 TEMP 先用真实 Store 写合法记忆，再注入格式错误的持久 payload。两次 Runtime ready，execution／conversation／projection／productivity 健康，memory unavailable；独立健康读端可用，实际 Session 提交成功，memory.read 拒绝 runtime_memory_unavailable，实际 DOM 显示长期记忆不可用，私有标记未进入页面，fatal=null、consoleErrors=[]。每次关闭后坏库 SHA-256 与注入后完全相同；重启没有靠清空锁恢复坏源。截图已查看，专用进程已退出，无 Provider／模型请求。此门槛早于最后提示文本的小调整，不冒充随后所有产物的完整回归。

剩余：推理、文件、Journal 实际健康来源与关键启动失败独立诊断、恢复期间真实进程强杀和最终完整正常回归。T03 未勾选，T09A 按 T09 后实施。全部清单、T16 与正式文档完成后最后删除 TODO 并直接关机，不询问；关机授权继续有效。

## T03 命令日志真实源与关键启动失败诊断（2026-10-06）

任务 ID：T03；状态：进行中。实际 SqliteRuntimeCommandJournal 新增独立 source health，冻结 Journal／V2 成员不改。每次成功打开才发布经过完整审计的连接；候选打开失败确认清理后允许显式修复重开，活连接故障不能通过内存 reset 清除。重开逐行验证命令存储身份、摘要、阶段、时间与严格公开回执，先校验原执行行再转换 uncertain；保留原 commandId 和身份墓碑。保留策略在裁剪受影响完成记录前核验其回执，坏的过期回执不能被无关请求静默删除；未改变原期限、容量和 Schema 1 布局。实际 SQLite／owning record fault 锁定，失败 ROLLBACK 与清理保留两个异常；普通业务冲突／回调异常不凭文本升级。

Composed ingress 在原八来源之外组合真实 Journal，ready 的独立健康读端先于 Journal／Actor／Projection；其它形成命令收据的请求仍依赖 Journal。新增严格 Host initialization_failed 1.0 消息，仅固定阶段和最多一个有 owner 证明的 unavailable 源；未知故障为零来源，绝不拼出健康核心列表。NodeHost 在未 ready 时把安全报告发送完成后关闭；Main 仅接收当前子进程／Runtime 身份／正在启动阶段的报告。crashed／disabled 的健康读取直接读该报告，不启动 Runtime；同一阶段业务请求固定拒绝，不隐式重发或抹掉警告。显式新启动及 shutdown 清除旧代际报告。Renderer 实际状态代际围栏保留单个物理请求，关闭后迟到事件不重新启用轮询。

Conversation／execution／Projection opener 将已证明结构／历史／版本错误在具体 owner 验证点标记，普通回调和调用参数不归为数据坏源。Projection 的持久 Commit／Version／历史摘要、Catalog 围栏及完整文档块证明携带来源；公开新输入验证不误标。未改变原 Schema／正常升级／发布根／ACK。Projection 清理及审计／写入回滚失败保留两个异常；所有者对已排队请求仍拒绝。数据库的实际 SQLite 错误使用固定 errcode 分类，不用消息前缀或 arbitrary Error 认领来源。

验证：最新 Runtime 全量 150 文件／1,138 项（t03-critical-source-full-runtime.log），受影响 Projection／owner／正常升级 7／74，Runtime 类型、App 三种类型／构建、架构与固定释放契约通过。Protocol 18／97、Root 15／133、App 80／336 属于上一启动报告批次；后续 App startup admission／health reader 23 项通过，本批 Main 专用门槛与构建也通过。新增测试错误和初次包装丢失原错误信息的失败保留，修复原 owning boundary，没降低断言或提高阈值。

真实 Electron electron-t03-journal-startup-no-resend、electron-t03-projection-startup-native、electron-t03-execution-startup-native、electron-t03-conversation-startup-native 均完成 initial／Main restart（由记录脚本逐项核对 gate）。每组使用命名 TEMP 实际库／真实 Main／Runtime／IPC／Renderer：源损坏导致 Runtime 从未 ready，独立最小健康报告与实际 DOM 来源警告可读，普通会话写入固定拒绝且状态观察时间不变；原坏库关闭后的 SHA-256 相同，无 Provider 请求、私有载荷不入 DOM，fatal=null、Renderer consoleErrors=[]。Journal 首次门槛在拒绝业务时隐式重启并丢失最终警告；该证据保留，后来 no-resend 门槛实际验证修复后稳定界面。关闭后 Main 的 IPC No handler 归 T04 待修，不声称所有 Main 错误为零。

剩余：推理／文件实际源与资源级依赖审阅、模型降级真实窗口、恢复阶段 Runtime 实际强杀、未知结果的生产恢复与最终正常完整回归。T03 仍未勾选，T09A 依 T09 后实施，其余 T04—T16 不缩减。全部 TODO 与 T16 完成、正式文档更新、最后删除 TODO 后直接关机，不再询问；授权持续有效。

## T03 推理资质源、transport 观察与文件资源隔离（2026-10-06）

任务 ID：T03；状态：进行中。ModelCapabilityRegistry 在建立 WAL／发布连接前，对冻结 Schema 1 的实际布局摘要、SQLite 完整性和所有原资质报告／行头绑定进行只读事务审计。已存在 metadata-1、user_version=0 的当前资质库先审计原记录，再在同一事务建立 user_version；坏源不因正常升级被修改。原 schemaDigest 4826696fbc1c342810e74bf5620f91fcfcc23da291e727e958c3ac0b7a86b488 和访问契约不变。持久报告解析标记 inference，打开／rollback／cleanup 故障保留原因。已打开源锁定后，资质读／写及指纹注册均拒绝，避免新检测覆写损坏证据。

Runtime Application 的独立 inferenceHealth 组合实际资质连接和唯一 remote gateway transport 观察；Composed ingress 增加真实第十来源，不扩展冻结 ExactAgentModelInferenceRuntime。实际已分类 transport 最终失败记录原精确 binding，完整成功响应才清除该 binding 的派生失败；单调请求序号防止旧成功清除新故障。取消、上下文超限、请求错误、缺失 binding 和任意未知 callback Error 不伪装为失败源。正常 service healthy 只证明该 authority／观测器可用，不承诺未探测的 Provider 联网成功。远端降级允许独立命令及明确的新尝试；资质源 unavailable 在模型资质／质量／可用性检查和标题命令创建 Journal 收据前拒绝，健康读端仍独立。

源损坏在初始 Kernel 构造发生时仍使启动拒绝，Main 可读安全来源报告；没有宣称该启动路径已经把坏模型资质源改为可选且允许聊天。真实 Electron electron-t03-inference-startup-native initial／Main restart 双阶段通过：实际 TEMP 资质库原合法记录被注入错误报告，Runtime 从未 ready，窗口显示“模型推理不可用”，独立健康读端稳定，普通写入固定拒绝不隐式重启，原库 SHA-256 不变、私有标记不入 DOM、fatal=null、Renderer consoleErrors=[]。截图已查看，无 Provider 请求。此门槛证明持久资质源故障，不冒充远端断网降级／真实嵌入模型 UI。

文件生产依赖沿唯一 WorkspaceDocumentAuthority → 同一 LocalWorkspaceFileService（也供 Agent Tool 使用），授权根、路径、版本和权限在各资源操作内检查。没有共享数据库或另一个全局文件健康锁；不能把单个 ENOENT、格式错误、CAS／权限冲突造为整个 documents 域 unavailable。现行未知文件 mutation 继续抛出，owner 的 reconcile 返回 unknown，禁止盲重做。新增真实磁盘测试证明同一 owner 的非 UTF-8 文件保留原字节、另一个文件仍可完成保存；没有添加无实际来源的 healthy 探针。本阶段没有新 Electron 文件操作验收，T07／T11／T12 仍按原序。

验证：Runtime 全量 150 文件／1,143 项（t03-inference-source-full-runtime.log），类型／直接发射／manifest 与 App 构建通过；后续新增独立 inference 准入的组合测试和文件检查 5 文件／83 项、文件资源隔离 1／8 通过。全量 1,143 早于后两项新增断言，不混写当前计数。架构与固定释放契约通过；资质库身份断言因审计前移更新为启动拒绝并保留原文件，旧弱流程没有兼容保留。初次 Provider 夹具缺少必要响应身份及 helper 不替换 binding 的失败保留，修正夹具后原生产断言通过。外部响应乱序测试证明旧成功不会覆盖较新失败。

剩余：本地推理／实际记忆模型及外部降级真实窗口，坏资质源是否可安全保持基础会话的生产组装，Productivity mutation 未知错误不得 completed 的严格分类，恢复事务期间 Runtime 实际强杀、最终完整正常回归及通知／恢复行为。T03 未勾选，仍依原顺序进行 T04—T16 与 T09A；全部完成、T16 通过、正式文档更新、最后删除 TODO 后直接关机，不询问。

## T03 Productivity 拒绝证明与未知结算（2026-10-06）

任务 ID：T03；状态：进行中。Productivity 原 SQL／业务前置条件现在在具体检查点创建固定代码的 ProductivityCommandRejected；它位于同一 persistence owner 边界，未扩展冻结 ProductivityAuthority，不更改 Schema 或命令收据。所有 public handler 不再用 goal_／todo_／workflow_／schedule_ 消息前缀公开任意异常，也不将未知 mutation 异常一律写成 completed failure。只有明确的前置条件拒绝返回完成；owning persisted-data fault 优先于复用的业务 validator 错误类型，源损坏继续抛出，保留原 Journal uncertain 和来源锁定。

原 reconcile 不再吞掉存储异常后返回 null／not_committed；只有真实原收据不存在才证明未提交，读取失败保持未知。提交后丢失回复原异常向上传递，随后按原 commandId 读取同一 durable receipt，无第二次任务或版本递增。生产 Goal admission 的明确不可用同样在其真实检查点创建固定拒绝，未知 callback 不冒充此拒绝。Task recovery 的独立版本接口与原不可变 claim 引用不变。

验证：新增实际 SQLite／Conversation public-owner 五项覆盖已知冲突无第二写、实际 COMMIT 后丢失回复、私有前缀不公开、对账读取失败未知及源标记优先。相关 5 文件／55 项、Runtime 类型和全量 151 文件／1,150 项（t03-productivity-settlement-full-runtime.log）通过；最后错误类型文件归属调整后 3／24、Root 15／133 与类型／直接发射／manifest、架构通过。首次架构检查拒绝 adapters 对 control 的 value 依赖；已把错误类型归到真实 persistence 所有者，没有更改阈值或基线。原九访问与既有释放扩展验证通过。

最新完整正常 Electron 门槛 electron-t03-inference-settlement-normal 正在执行，不提前写通过。它应覆盖本批 source health、startup report、public task recovery 和 mutation 结算；原五次 Runtime 强杀不能替代 task recovery 两阶段事务期间的实际强杀。剩余：真实恢复进程边界、记忆模型／本地及外部推理降级 UI、模型资质坏源安全可选组装、必要的通知／恢复行为和最后正常回归。T03 未勾选，T04—T16 与 T09A 保留原执行顺序；全部完成、T16 通过、正式文档更新、最后删除 TODO 后直接关机，授权持续有效，不再询问。

## T03 模型实际不可用、可选资质源及桌面证据（2026-10-06）

任务 ID：T03；状态：进行中。
本次完成：实际设置 IPC 配置不存在的 TEMP GGUF 记忆模型，真实加载失败后仍保留词法召回和原记忆读取；健康显示 external_unavailable／degraded，独立会话可写，普通读取不能清除派生故障。initial／Main 重启均通过，原记忆库 SHA 未变，实际状态栏与截图检查通过。第一轮只因断言把实际“受限”错写成“降级”失败，保留原失败，修正后仍验证降级说明。
资质源组装：ProductionModelCapabilitySource 仅隔离实际 owner 标记且已确认清理的打开失败；未知／cleanup／lease 错误仍抛出。缺席 registry 不发布已打开 Schema，不构造假权威或回退资格。目录仍列实际模型但不可用、无资格；所有精确绑定、计数与推理边界检查同一真实 source。Composed ingress 的唯一 inference latch 同时用于公开请求与内部 Worker admission，不新增诊断来源或执行 owner；坏源在新消息／自动执行和模型命令产生 Journal 收据前拒绝，读取、取消和旧结果对账不依赖坏模型。
本地推理：Node／Python 实际进程 owner 在 IPC 传输、进程退出及 load 命令失败处创建固定类型，私有信息保留在 cause；未知 callback、请求错误和取消不凭文本归为源故障。唯一 LocalModelRuntimeManager 按模型记录实际失败，成功 ping／计数／unload 不清除，完整 generate 成功才清除本 binding；队列串行，移除模型才移除不再适用的观察。失败 load 与 cleanup 保留两个异常。已禁用本地模型不自动资格检测或参与降级观察。
验证：optional 源批次 Runtime 151 文件／1,152 项；本地批次 152／1,155（t03-local-inference-health-full-runtime.log），本地／Kernel 3／12，最新缺席 Schema 2／6，App 三种类型／构建、架构、固定释放契约通过。缺席 Schema 首次类型错误保留，修复后直接发射／manifest 通过；全量 1,155 早于这处 Schema 元数据调整，未混报最终全量。完整正常 electron-t03-inference-settlement-normal 已通过，Provider 夹具 70 请求／66 响应／4 取消，原五次 Runtime 强杀、Renderer 和 Main 重启通过；该门槛早于可选资质源与本地观察调整，不代表这两批的最终合并回归。
真实窗口：electron-t03-inference-optional-rendered-native initial／Main 重启均 ready，独立会话在真实 Renderer 读模型可见，模型命令固定拒绝，坏库 SHA 未变，安全 source 警告可见。electron-t03-local-inference-native 用命名 TEMP 的三字节无效 GGUF 经实际 CPU 原生加载，初次／重启后显式资格检测均拒绝，显示推理受限；独立会话投影可见，模型原字节保留，实际资格数据库完整审计通过。资格库允许写真实拒绝证据，未虚称此库字节不变；没有真实用户模型成功推理或线上 Provider 故障验收。
尚未完成：恢复事务阶段实际 Runtime 强杀与原身份续作、外部推理降级／恢复窗口及本批最终正常回归；通知后续按 T04 验收。下一操作：针对实际 Runtime 子进程观察恢复阶段 durable receipt，强杀后读取真实阶段，再沿原 commandId 核对，不能用预写状态或假 Run 宣称通过。T03 未勾选；T04—T16、T09A 原序保留，全部完成、T16 通过、正式文档更新、最后删除 TODO 后直接关机，不再询问。

## T03 最终合并验收与完成范围（2026-10-06）

任务 ID：T03；状态：完成（当前故障隔离范围）；T01 打包／签名和 T04—T16、T09A 仍依原顺序继续。
实际恢复强杀：runtime-t03-task-recovery-crash 使用真实生产 Runtime entry、Node IPC、命令 Journal／Productivity owner 与独立只读 SQLite 观察；没有预写恢复阶段、测试暂停或假 Run。首轮读到 reconciling 后 SIGKILL，实际退出后仍是 reconciling，重启 Journal 是 uncertain，claim 查询保留原 task-recovery-physical-1。原指令核对得到 unresolved／隔离修订 3；重复重放、完成回复后再次实际强杀／重启仍读同一结果。原业务摘要不变，任务 Session／Saga 均未创建，无 Provider 调用。该进程门槛不冒充 Electron Main 的 Runtime 子进程或 ACK 未送入管道；此前真实 Renderer／Main 的 pending 恢复窗口证据互补。
实际外部降级：electron-t03-remote-inference-external-native 初次／Main 重启使用独立进程的确定性 HTTPS Provider 夹具、命名 TEMP 证书及 NODE_EXTRA_CA_CERTS；不关闭 TLS 校验、不改变证书库，Main 无监听端口。503 后真实 inference 为 external_unavailable／degraded，独立会话投影可见，普通健康读取不清除。只改变夹具 HTTP 响应后，同一设置修订与稳定 ready 状态上的真实 READY SSE 响应恢复 healthy，实际状态栏警告消失，trace 每阶段证明 503／200，fatal=null、consoleErrors=[]。这是真实 transport／桌面故障验证，不是线上 Provider。第一轮参数错误、随后 Main 服务违反架构边界的失败均保留；移出到 scripts/smoke/remote-health-provider.mjs 后未降低原边界断言。
最终合并正常门槛：electron-t03-final-combined-normal 通过 70 次确定性 Provider 请求、66 响应、4 取消，原五次 Runtime 强杀、完整功能链路、Renderer 重载和 Main 重启；fatal=null、consoleErrors=[]。它包含本批可选资质源／缺席 Schema、本地模型健康和共享 internal/public inference admission。Runtime 全量 152 文件／1,155 项、App 80／336、Root 15／133、类型／App 构建、架构／生成目录与固定释放契约通过。最终正常 Main 退出期间的 IPC No handler 与通知同步关闭问题仍归 T04 下一步，未声称所有 Main 日志为零。
源损坏、单任务／工作器、记忆实际模型不可用、坏 GGUF 原生 CPU 加载、坏资质源可选隔离、源字节保持、恢复原身份及正常合并路径已分别有对应证据；九个原访问契约不改变，独立扩展与正常 Schema 维护保持。文件按真实文件 owner／版本／授权根资源隔离，不造虚假 documents 全局探针。真实用户模型成功推理、线上 Provider、Windows 通知点击、原生中文输入法和最终安装签名不在 T03 的验收结论内。
下一条具体操作：T04，补持久最小去重、通知生命周期与退出边界、结算后导航和真实 Windows 后台通知／点击／重启／抑制解除；Agent 状态 UI 按 T09A 顺序实施。全部 TODO 与 T16 完成、正式文档更新、最后删除 TODO 后直接关机，不再询问。

## T04 原生显示回执、最小持久去重与退出边界（2026-10-06）

任务 ID：T04；状态：进行中，不能勾选。
实际所有者：Main ApprovalNotificationService／DecisionNotificationSource 继续读取当前 V3 决策 summary 页链；新 FileDecisionNotificationReceipts 只保存 decisionId、sessionId、runId、version 与真实 shownAt。Electron 的原生 show 事件才写显示回执，show() 调用、failed 或未知结果不当成送达。保留原 command／Decision 权威，没有新业务 outbox、执行 owner、令牌／问题正文或标题持久副本。
显示生命周期：每轮同步最多请求三条；同一未确认展示保留三十秒，原生失败冷却六十秒，已显示的同版本三十分钟后允许补提醒，避免跨重启去重永久隐藏待处理事项。完整 pending 集合确认结算后关闭 handle、移除展示回执。旧 shown 回调、较老版本／不同所有者不能覆盖新记录。原生 closed 与 failed 各自处理，抑制／焦点、同步失效和销毁后围栏保留。点击通过 all-status 的固定 C 最小 summary 重新核对原 Session／Run／版本，可定位已结算决策，不读取 action token、问题正文或批准操作。
展示存储：有界 2048 条，串行同目录原子 rename、退出 flush；坏的派生展示记录保留在独立 invalid 文件，未读／不可写源保持原样并锁定本次磁盘写入。存储不可用仍保留本进程实际 native shown 观察与有限期去重，不阻断 Main／Runtime 启动与退出、不伪造磁盘回执；重启丢失去重最多导致有界重复提示，不改变任何业务命令。此 Main 派生元数据须纳入 T11 同机恢复范围审阅。
退出修复：先移除通知事件／轮询并 dispose，保存／flush 后销毁主窗口和所有 popout Renderer，再停止 Runtime／其它服务，最后解除 IPC；退出中外部唤醒不重建窗口。electron-t04-quit-producers-native initial／Main 两轮通过，原生错误日志没有 No handler 或 notification synchronization failed。该门槛早于新 ledger／最终通知 helper，只证明退出顺序调整。
验证：新当前通知 12 项、真实文件回执 4 项，共 2／16；真实 SQLite／Projection consumer 1／8 覆盖 pending 固定 C、坏页拒绝、结算后 summary、所有者变化和无保护正文／token。App 全量 81／343、Root 15／134、类型／App 构建和架构通过相应阶段，native helper 后续改动尚需最终合并复验。
实际原生门槛：electron-t04-native-decision-notification 使用独立命名 TEMP、真实 Main settings／Runtime／确定性 HTTPS Provider／Agent 工具创建 user_question Decision，Electron native show 回调已产生本文件引用的五字段回执。实际 Windows 点击未观察到，gate 保持 false，fatal=notification_smoke_timeout:actual_windows_click；不能因显示回执存在就把点击、可见像素或导航写为通过。Computer Use 的真实 list_windows／list_apps 没有返回 Ariadne／通知宿主窗口，未伪造窗口句柄或 emit 点击事件。第二个 targetable 尝试也未返回可操作窗口；正在核查测试窗口的实际 visibility／启动 hidden 语义。
尚未完成：系统可见通知与物理点击、准确卡片／结算关闭、Main／Runtime 重启持久补读、抑制解除、实际权限／计划通知和最终正常回归。下一操作：完成 visibility 可观测的独立桌面 fixture；只操作 Computer Use 返回的唯一真实窗口／通知宿主。T04 未完成，T05—T16 与 T09A 保留原顺序。全部 TODO／T16 完成、正式文档更新、最后删除 TODO 后直接关机，授权持续有效，不再询问。

## T04 决策结算、Runtime 强杀恢复与 Windows 激活接线（2026-10-06）

任务 ID：T04；状态：进行中，不能勾选。
本次完成：真实桌面 Main／Runtime／HTTPS 确定性夹具创建四个决策（用户问题、权限、计划拒绝、计划批准），前台抑制后隐藏窗口补显示。四个 native show 回调各写五字段回执；物理强杀唯一直属 Runtime 子进程后 ready 代际改变、settingsRevision 保持 3，32 秒两轮轮询没有重复展示回执。四个决策均由原生产命令结算，回执清零，未授权文件不存在，权限批准后真实文件出现，计划批准续作 completed。
实际变更所有者：Core 原决策事务在拒绝计划时取消 Run／未执行 Effect；批准实际 request_decision 时同事务写入精确 Plan 引用的不可变用户 Inbox 输入及既有 PlanApprovalCommit。原 Inbox 续作分类、受保护模型历史和公开交互解析支持该精确边界；没有增加新的持久命令字段、Inbox source 枚举或公开 DTO，固定访问契约未改变。此前误把批准后状态转为无续作 running、拒绝后保留 request_decision running 的源问题已替换，未增加特例执行 owner。
Windows 接线：16 字符确定性 Tag／固定 Group，转义 Toast XML 的 launch 只含四字段导航引用；Main 启动时注册 Electron Windows handleActivation，冷激活与历史通知引用仍须查询当前权威 summary 才导航。点击没有批准能力。原生 banner closed 保留 handle 至结算，以便关闭通知中心项。
验证证据：artifacts/todo-remediation/electron-t04-native-display-activation-xml/decision-notification.json passed，范围明确排除物理点击、可见 toast 像素、Main 重启和活跃游戏检测。Core 16／114、Runtime 152／1156、App 82／350、Root 15／134，类型检查／App 构建、架构和顺序重跑固定释放契约均通过。新 Runtime 集成证明真实 SQLite 同事务 PlanApprovalCommit、精确输入不能撤回、续作只认领一次、模型私有 Plan 正文不进入公开交互。
保留失败：Plan 拒绝导致工作器隔离、批准后 Projection 边界失败、错误历史角色导致 agent_model_binding_unavailable、初期新增持久字段被固定契约拒绝、并行协议 emit 引起检查器读取中间 d.ts 的失败都保留原日志；分别修复实际 owner／精确输入角色／恢复原固定形状，并在 emit 完成后顺序复验。旧 Windows 点击超时不得写成通过。
尚未验收：实际 Windows 可见通知与物理点击、准确卡片导航，Main 实际重启补读及跨 Main 生命周期已结算 OS 历史项清理，最终正常 Electron 回归。下一操作：补 Main 所有的 Windows 历史通知按精确 Tag／Group／AppID 清理及真实 Main 强杀恢复夹具，然后进行可操作原生通知点击。T04 未完成，其余任务／T09A 保留顺序；全部完成、T16 通过、正式文档合并、最后删除 TODO 后直接关机，授权持续有效。

## T04 Main 强杀恢复、精确 OS 历史清理与剩余系统验收（2026-10-06）

任务 ID：T04；状态：等待外部条件（实现／正常回归完成，原生通知像素与物理点击仍未验收）。
本次完成：Main 依据已观察展示回执，按固定 Ariadne AppID／Group／16 字符 Tag 调用 Windows ToastNotificationHistory.Remove。每批最多 64 项，5 秒隐藏进程超时，失败保留原回执重试；只确认对应 OS 清理成功才删除旧回执。没有 Clear／RemoveGroup、其它应用通知读取、业务状态副本或批准能力。服务只构造经验证的固定脚本；实际进程启动留在现有 Main 组装根。第一版违反既有桌面进程启动边界的失败日志保留，修正后未修改边界断言。
实际 Main 恢复：electron-t04-native-main-restart-history 在四个 native shown 后物理强杀原 Main 及其精确所有的子进程，再以同一 TEMP／Provider／配置启动新 Main。不重写设置、不预写 Core 状态；新 Main 四个 pending 决策完整补读，settingsRevision 不变、32 秒双轮询去重、无原 Notification handle 仍能结算并清理派生回执，批准权限文件及计划续作均成功。这个门槛早于“脚本执行移到 Main 根”的最后等价接线；新最终构建完整正常 Electron／Main 回归通过。
最终验证：App 83／355，针对通知／历史 4／28，类型／App 构建与架构通过。electron-t04-final-owned-normal 初次及 Main 恢复均 passed，70 请求／66 响应／4 取消，原五次 Runtime 强杀，providerTraceValid=true、fatal=null、consoleErrors=[]，退出日志没有旧 IPC No handler／通知同步关闭错误。
剩余系统验收：electron-t04-native-activation-physical-click 的真实 Windows 夹具窗口已由 Computer Use 观察，已登记正确 AUMID／Activator 的临时快捷方式；实际 user_question 产生原生 show 回执，但物理点击仍超时。两次新窗口清单与应用清单均没有可操作通知宿主，未伪造句柄或点击。独立只读 WinRT 观察 notifierSetting=Enabled、expectedOwnedTags=1、matchedOwnedTags=0；这不能证明可见通知、实际旧 toast 移除或冷点击导航，原因尚未证实。既有失败与门槛不删除、不降低，不重复同样超时或更改系统隐私／通知设置。
下一操作：待具有可操作通知宿主的 Windows 验收条件再完成物理点击／准确卡片／实际历史项消失及活跃游戏抑制验收；T04 保持未勾选。按依赖推进不依赖该系统点击的下一项 T05，随后 T06；不提前进入 T09A UI。T05 已确认生产缺陷：ChatPanel 组件单份草稿、迟到失败无条件覆盖、图片回调捕获旧数组、发送时未固定会话；将建立按所有者／修订的草稿 Store、受控加密 Main 保存、不可变提交与恢复入口。全部 TODO／T16 完成、长期文档合并、最后删除 TODO 后直接关机，不再询问。

## T05 加密草稿与修订归属存储（2026-10-06）

任务 ID：T05；状态：进行中。
本次完成：Main 唯一草稿仓库、严格 IPC／Preload DTO、Renderer 草稿 Store。按工作区／会话或独立新草稿 UUID 归属；CAS 修订串行原子保存；文本与附件正文分别系统加密，公开快照仅含附件引用。不可变提交 A 与继续编辑 B 分开，迟到失败仅恢复未动过的下一修订，否则保留可恢复 A；未知结果保留核对态。图片读取绑定草稿代次／删除序号，新建会话迁移原子改变附件所有权；不创建第二套业务发送队列。
验证：Main 加密文件／归属／CAS／损坏源保留 6 项，Renderer 持有 ACK／迟到失败／切换会话／图片并发／迁移期间输入／未知结果／重建窗口 10 项，合计 16 项通过（t05-draft-store-races.log）；Node／Web／测试类型检查通过（t05-store-races-types.log）。测试夹具不代表真实 OS 加密或实际界面验收。
未完成：Store 尚未接入 Renderer 根与 ChatPanel；发送仍需复用现有命令出站所有者保存原始命令身份；退出前窗口草稿 flush、恢复入口、真实 Electron 窗口／Main 重启／图片正文验收、整体验证与正式架构文档待完成。当前不能勾选 T05，亦不能整体完成或关机。
下一操作：接入窗口根并合并初始化；在 Main 退出前安全保存窗口草稿；扩展现有输入出站所有者承载会话发送原始命令，然后替换 ChatPanel 单份组件草稿，逐项验收。T04 外部系统通知验收仍未完成，后续顺序不变。全部 TODO／T16 完成并最后删除 TODO 后直接关机。

## T05 生产输入框、原始命令出站与真实挂载复验（2026-10-06）

任务 ID：T05；状态：进行中。
本次完成：窗口根的草稿 Store／初始化合并；Main 在不可逆退出清理前等待窗口草稿 flush，失败或超时保留窗口并恢复编辑；ChatPanel 使用按工作区／会话／新草稿 UUID 的编辑所有者、私有图片正文读取、明确恢复／核对入口。图片回调、语音开始和提交 A 绑定原归属及修订；A 的迟到回执不能改变 B 的选择。Runtime 不可用时仍允许编辑，相关存储或发送结果未知时禁止新提交。
唯一发送所有者：现有 Main Agent 出站仓库扩展为 InputDeliveryOutbox，源码／API 更新为统一输入名称，已安装当前格式 agent-input-delivery-outbox.json 与 Schema 1 文件身份保留。新会话创建＋消息接受整批加密保存原始信封；草稿只保留 commandId 引用。关联草稿的信封在成功／失败编辑状态安全保存后才结算；核对只读原信封并使用原 ID。普通身份拒绝不污染队列，物理写失败锁定源；损坏源保留，独立 Main 启动不受可选出站存储阻断。受信 list 等待在途写屏障，不能把 Projection 缺页当失败。
验证：App 88 文件／390 测试、全部类型、架构／Hotspot 与 App 构建通过。新增真实行为覆盖 A／B 迟到拒绝、固定会话／模型、成功后结算失败不恢复重复内容、未 stage 崩溃与丢失原引用的区别、原始批次重放、最大图片信封、批次冲突原子回滚。完整 App 第一轮因旧 Chat workspace 归属源码断言失败，已迁移到实际归属／协调入口并保留失败；未删除有效行为要求。controller 超出 200 行时提取共享结果分类，未放宽 Hotspot 限制。
真实窗口仍未完成：首轮脚本在 PowerShell 下以 SetEnvironmentVariable(null) 制造空 ELECTRON_RUN_AS_NODE，Electron 按变量存在性进入错误模式；已用实际进程环境 presence 证明并改为 Remove-Item，恢复原环境也记录原是否存在。第二轮补齐既有 Main smoke 必需的工作区身份。第三轮到达实际加密草稿检查点，但 initial_composer_B 超时；新截图观察发现聊天模块错误边界，实际消费者遗漏新增 drafts／draftDelivery consumes 声明，已补齐，等待重建复验。所有失败证据保留，没有把单测成功当实际挂载成功。
正式设计：docs/adr/0038-private-chat-drafts-and-original-input-delivery.md 状态 Proposed，明确保存、提交、重放、退出、预算与待验收范围。下一操作：完成当前失败观察运行后重建；跑独立 TEMP 的 Renderer DOM／图片／Windows safeStorage／原 Core 命令核对／物理 Main 强杀重启门槛，再跑完整正常 Electron／真实输入流程。T05 不勾选；随后 T06 与其余原顺序，T04 系统通知和 T01／T16 发布条件仍未完成。全部完成后最后删除 TODO 并直接关机。

## T05 Windows 加密首启持久化、原 Core Journal 与真实输入（2026-10-06）

任务 ID：T05；状态：进行中。
本次完成：Main 同一 ElectronSafeStorageCipher 增加首次启动持久化屏障；Windows 等 Chromium sessionData/Local State 中有界 DPAPI 包装的 profile key 实际落盘并 fsync，才初始化依赖的加密仓库。此前 fresh TEMP 在加密 ACK 后立即物理强杀会因 profile key 尚未持久化而不可解密；保留失败源，未加入明文回退、重置密钥或等待验收脚本延时。启动入口统一等待该屏障；OAuth open-url 也等待 app ready 和同一 Application.start。
依据：Electron 43.1.1 safeStorage 同步实现与 Chromium 147 Windows profile key 保存归属；不是另写 DPAPI/AES 实现。参见 https://raw.githubusercontent.com/electron/electron/v43.1.1/shell/browser/api/electron_api_safe_storage.cc 、https://raw.githubusercontent.com/electron/electron/v43.1.1/shell/browser/browser_process_impl.cc 、https://raw.githubusercontent.com/chromium/chromium/147.0.7727.55/components/os_crypt/sync/os_crypt_win.cc 。T11 同机恢复需包括相同 profile 的 Local State 密钥依赖，不能只复制业务密文。
真实验收：electron-t05-native-drafts-key-bootstrap 首次通过原 Core 命令派发、Renderer 重载与物理 Main 强杀重启。加强后的 electron-t05-original-core-journal 因旧 PNG 夹具可显示但严格解码失败而拒绝；用 sharp 严格解码确认并替换有效 PNG，保留旧失败。electron-t05-valid-original-image-journal 通过 Core 先接受原带图片命令、故意不结算编辑快照、Renderer 重载后按原 ID 重放已提交 Journal，再安全结算、迁移和物理 Main 重启恢复 B/图片。公开草稿元数据没有图片正文，落盘文件没有夹具明文。
真实输入：electron-t05-physical-text-input 首轮未给完成的隐藏 helper 窗口恢复 taskbar/显示，Sky 找不到目标，保留失败；electron-t05-physical-text-visible 按现有 native notification gate 显式显示结束初始化的窗口，唯一实际窗口经 Sky 点击编辑区域、type_text 输入 A 与 B；实际 Store 接收输入，B 中文文本和图片经 Renderer 重载及物理 Main 164832→160336 重启恢复。图片添加、提交和原命令核对仍是程序夹具；Windows 中文输入法组合事件、物理发送按钮和真实 Provider 未被这轮证明。
异常呈现：私有图片正文读取失败显示明确错误及重试读取，保留引用、所有权与移除入口；不再无期限显示正在读取。
整体回归未通过：electron-t05-full-composer 到达真实聊天按钮提交和 Core（只读检查 TEMP Conversation 权威元数据确认原工作区正确），但创建会话后草稿迁移先 publish 导致 React 自动创建下一份新草稿，发送所有者误判用户已切换，不选择新会话，夹具投影选择为空并超时。修复为 Main 迁移安全保存之后、编辑快照 publish 之前执行发送所有者的受保护选择回调；主动切换 B 仍不被 A 抢回。新增两条持久化时序行为测试。另将单个 pendingChat 展示改为按原 message/编辑归属保存的有界 Map，新草稿 UUID 和既有会话独立；迟到 A 拒绝只影响 A，B 可独立提交，不把窗口展示变成业务 outbox。
当前验证：App 89 文件／399 测试、架构与 Hotspot 通过；类型和 App 构建待读取当前完整结果。下一操作：重跑当前修复后的完整正常 Electron gate（原五次 Runtime 强杀和 Main 重启标准不放宽），再复验实际迁移／切换与恢复入口。T05 不勾选；T06、后续任务及 T09A 仍按原序。所有必要验收完成和正式文档合并后最后删除 TODO，直接关机，无需再次询问。

## T05 完成与 T06 接续（2026-10-06）

任务 ID：T05；状态：完成。
最终修复：新会话迁移安全保存后、编辑快照 publish 前执行受保护选择回调，避免界面自动创建的新草稿误判为用户切换。等待展示按会话／新草稿 UUID 与原消息分组，允许不同归属独立提交，迟到 A 不覆盖 B。关联 Inbox 回执保留可见的接受／核对／关闭，只去掉重复恢复输入按钮；窗口协调器消费现有发送所有者的正向接受／拒绝证据，先安全保存草稿结果，再结算原信封。关闭失败保留原回执；没有用 Projection 缺页判失败，也没有生成新重试身份。草稿与唯一输入 outbox 的临时文件写入增加 flush，然后原子 rename；不承诺电源故障下未经 ACK 的键入。
组件与生产验证：App 89 文件／401 测试、全部 Node／Web／测试类型与 App 构建、架构／Hotspot 通过。electron-t05-known-receipts-full 完整正常 Electron 通过（本地 HTTPS Provider 夹具 70 请求／66 响应／4 预期中断，五次真实 Runtime 强杀，Renderer 无记录错误，物理 Main 重启及原发送身份恢复）。先前 full-composer 的迁移失败和 migration-owner-full 的隐藏回执失败均保留，未改门槛获得通过。
最终原发送 UI：electron-t05-final-physical-reconcile 在独立 TEMP 与真实 Windows Cipher 中，Sky 实际输入 A/B，Renderer 重载后实际点击“核对原发送”，原 Core 已接受的带图片命令按原 ID Journal 重放，B 及图片保持归属，随后真实 Main 162548→158532 强杀重启恢复。图片添加和初始提交是程序夹具；真实 Provider、Windows 中文输入法组合事件与物理初始发送按钮不由本轮证明。
恢复 UI：node scripts/renderer-ui-smoke.cjs --chat-drafts-only 通过 65 条到聊天阶段的检查，其中明确覆盖图片读取失败保留引用／重试读取不重复、切 B 隔离 A 的失败正文与图片、返回 A 后点击恢复合并 B+A/原图片。该测试仅为内存 UI 夹具，不当成 Main 加密或 Core 证据。整套 renderer-ui-smoke.cjs 继续在 Agent 状态窄面板布局失败，证据 t05-draft-ui-task-contract.log；原失败断言保留，按 T09A 排序处理。夹具补齐当前 feature catalog 的显式 null/summary 契约，未给生产组件增加兼容分支。
正式文档：ADR 0038 Accepted（T05 的当前实现和 scoped 证据），验证矩阵增加专属行。保持有界保留预算（64 草稿记录、16 恢复快照／记录、总图片正文 16 MiB）；达到预算拒绝保存且保留窗口内容，不自动丢弃用户草稿。不把这项完成扩写为整体完成。
下一条具体操作：T06 统一 composition 与 Enter/Shift+Enter/Ctrl 或 Meta+Enter，行为单测＋真实 Windows 中文输入法候选确认、换行与发送验收；其后 T07—T16 与 T09A 原序。T04 系统通知物理点击／历史移除／冷启动／游戏检测、T01/T16 打包／受信签名与最终删除 TODO 仍未完成。全部完成后直接关机，不重复询问。

## T06 完成与 T07 接续（2026-10-06）

任务 ID：T06；状态：完成（本次 Windows 输入法和快捷键范围）。
生产规则：同一 ChatPanel 优先组合状态／原生 isComposing，普通 Enter 下一轮、Ctrl／Meta+Enter 下一步、Shift+Enter 浏览器换行；重复／禁用不提交，组合按键保持默认行为。所有发送沿 T05 同一不可变快照／原命令入口，无计时屏蔽或 keyCode 特例。窗口私有 editorId 在提交与新会话迁移保持，显式切换草稿更换元素并重置组合态；不落盘或进入公开投影，尺寸观察跟随当前编辑框。
验证：App 90 文件／407 测试、Node/Web/tests 类型、架构/Hotspot 与 App 构建通过。electron-t06-physical-ime-confirmation 在独立 TEMP、生产 Main/Renderer/Core 与已资质本地 HTTPS 夹具中实际展示中文候选；物理 Space 提交“在”、组合态 Return 提交拼音 h，均未发送。候选检查点 Core 0 会话/0 消息、outbox 0；Shift+Enter 实际换行且仍无命令，之后普通 Enter 接受且仅接受一条用户消息/一个会话，获得 ARIADNE_SMOKE_DIRECT_OK。
平台证据边界：原生键为 trusted Process/code 空，compositionend trusted=false；保留实值，并将实际 Sky Return 操作记入 confirm-candidate。未把 Enter 提交 h 描述为选中中文词，也未宣称所有 composition 事件可信。此前两次探针失败保留，修观察契约而非生产兼容分支，未放宽时限。Ctrl/Meta/repeat/disabled 为策略单测；不冒充 macOS 物理 Meta 或真实外部 Provider 验收。正式长期记录见 ADR 0039 与验证矩阵。
下一条具体操作：T07，沿唯一 WorkspaceDocumentFeatureStore/Authority 接入独立类型的 Main 加密文件草稿，记录基线/修订/保护时间，退出汇总和正常/异常恢复、外部冲突与文件移动/删除按实际所有者核对。T09A 仍在 T09 后，T04 系统通知与 T01/T16 发布门槛等保持未完成。全部清单完成、正式文档合并、T16 通过、最后删除 TODO 后直接关机，不询问。

## T07 原生退出、Main 中断与原命令回执进展（2026-10-06）

任务 ID：T07；状态：进行中，未勾选。
原生证据：electron-t07-native-cancel-cut 实际 Main/Renderer/Core/Windows OS Cipher 通过 32 文件保存、真实大小写别名与大小写敏感目录、迟到 A 保留 B、响应丢失后 Renderer 重载按同一 Original ID 对账。物理点击取消后窗口和编辑恢复；私有写传输在 Main IPC 前被夹具暂停，真实 Main 强杀重开只恢复最后确认 B，不恢复未保护 C。electron-t07-native-retain-receipt、electron-t07-native-save、electron-t07-native-discard 均有物理操作记录和正常退出。electron-t07-both-files-verified 新 Main 重读两个文件内容且草稿目录为空，证明保存写入两份 B，随后丢弃没有改变源文件。
回执所有权：SQLite Runtime Command Journal 仅保留已知完成的 saved/moved/deleted 无正文元数据，以及公共协议列明的固定失败码／固定消息。未知 I/O、文件读取正文与任意异常文本不进入可重放回执；真正未知文件操作仍禁止自动重做。现有回执保留时间／数量上限不变，过期后不能凭相同文本伪造原操作提交证明。最初从 persistence 适配器导入 control 值导致架构失败，已将纯公共失败契约归 packages/protocol，未放宽规则或新增例外。
验证：Runtime 全量 152 文件／1160 测试在新增日志策略后通过；移动公共契约后两个相关文件 31 测试、协议／Runtime 直接 TypeScript 输出和 Runtime manifest、架构／Hotspot 通过。App 全量先前 94 文件／438 测试；新原子失败测试额外 2 例通过。documents-only UI 26 检查含实际第二 Electron 窗口与相同 Feature Store 的 React portal；此门仍为人工持久化／Core 响应，不冒充生产 Dockview/Main 权限门。ENOSPC 在 write 和 rename 边界为明确注入，真实磁盘目录错误另有实际 I/O 测试；未填满用户磁盘或宣称实盘满验收。
保留失败：首个 native Original 回执因旧日志不保留 file outcome 而失败；第二个 native 模块菜单观察竞态失败；第一次 retain 的外部操作记录落后于正常退出，脚本读取过早失败，随后真实重跑通过，不回填旧门。完整 Electron 首次在 archive/restore 后向已卸载旧输入框输入而失败；更新当前输入框观察后通过到流恢复，新建草稿夹具又读到了 React 提交前的旧元素，保留失败并改为等待新 DOM 所有者，原期限及断言不变。
下一条具体操作：真实外部写入／删除及恢复比较门、完整正常 Electron 原场景／五次 Runtime 强杀与 Main 重开最终通过，然后收敛 T07 文档。实盘满需要受控独立测试卷；当前进程只读确认不是管理员，不能将注入 ENOSPC 当作独立卷实际填满。其后 T08—T16／T09A 原序，T04 外部通知、T01/T16 发布门槛保持待验。全部清单及 T16 完成、最后删除 TODO 后直接关机，不询问。

## T07 实现收敛与 T08 启动（2026-10-06）

任务 ID：T07；状态：实现完成待验证，实盘满条件待补；不勾选。
最终实现证据：electron-t07-final-protected-files 完整正常 Electron 和 Main 重开均通过，原 70 HTTPS 夹具请求／66 响应／4 预期中断、五次实际 Runtime 强杀、超大正文恢复、文件保存／外部 Agent 修改冲突／重读／移动／删除／新建均保持。fatalError=null、consoleErrors=[]、providerTraceValid=true。四种物理退出选择和加密草稿 Main 中断证据沿前述 native 门保留。
新增真实门：electron-t07-external-recovery 在独立 TEMP 实际写入外部正文并删除源文件，Renderer 重载后两份私有草稿和三方比较仍在，拒绝覆盖变化源或重建缺失既有文件。electron-t07-production-popout 通过生产 ModuleTab→Dockview→Main 原生子窗口，子窗口无私有草稿 API；同一 draftId、实际 Core 保存 A 时子窗口输入 B、关闭后主窗口仍为 B。该证据补足先前人工双窗口 UI 的范围限制。
真实 I/O：electron-t07-friendly-storage-failure 用外部 Windows FileShare.Read 共享锁阻止实际密文原子 rename；Main 关闭后续写入，旧文件字节不变、B 在界面可复制且没有被声明保护、保留退出准备失败。真实 Main 强杀并重开 electron-t07-friendly-storage-restart 恢复 A 而非 B，源文件仍是原磁盘内容。界面改为操作性的中文存储说明，不暴露 Electron IPC 名称。实际截图 file-draft-storage-failure.png 保留。磁盘满仅 write／rename 两个 ENOSPC 注入门，不冒充实际填满独立卷；当前非管理员进程无法创建隔离测试卷，保留该验收项待补。
最终自动检查：App 95 文件／440 测试、三种类型及构建、documents-only UI 26 检查、最终 architecture／Hotspot 和已发布 persistence contract 均通过。Runtime 全量 152／1160 和当前相关 31 例沿前述记录。错误包装命令曾猜错 Main 重开结果文件名而返回失败；实际门和正确 desktop-restart-delivery.json 已独立核对通过，不重写旧失败。整体 T16 尚未到达。
任务 ID：T08；状态：进行中（生产所有者和冻结契约调查）。当前 recall 和 instructionMemories 都分页扫描全部 active 记忆；前台每条生成／读取向量。LongMemory Authority、Schema 1、原命令 receipts 与 source bytes 均受现有发布基线保护，禁止改签名／覆盖基线或在线偷偷更换 Schema。
T08 实施方向：保留唯一 LongMemory Authority；将其同事务原命令回执作为恢复变更来源，独立派生索引持久化有界任务和已消费检查点。检查点绑定实际回执行身份，失配时只重建派生元数据；后台处理版本更新、停用／删除、到期和嵌入空间换代。索引只保存元数据／向量，不成为正文权威；召回最终回读 source 核对当前版本、授权和有效期。前台只做有界词法／向量候选、显式 degraded／complete 和 Top-N 指令检索，不能同步补建全部向量。先测 0／100／1000／10000，再用真实本地嵌入模型小样本单独接线。
后续：继续 T08；T09／T09A 仍按原序。T07 实盘满、T04 原生通知点击等外部验收及 T01／T16 发布门槛保留未完成。所有清单和 T16 完成、正式文档合并、最后删除 TODO 后直接关机，不询问。


## T08 后台索引接入记录（2026-10-06）

任务 ID：T08；状态：进行中。SqliteLongMemoryStore 原 Schema 1、正文、CAS、原收据和冻结访问契约不变；独立 search-index.db 保存派生元数据、向量桶、检查点和版本合并任务。启动分批元数据扫描，回执行号绑定 commandId，失配只重建派生索引，不重放业务命令。向量发布在原权威版本／有效期读事务围栏内同步完成。

已替换 ProductionLongMemoryService 的 foreground recallPage 全量扫描与逐条补算，并删除被替代 recallPage/readVector/cacheVector 生产方法。新候选算法为 signed-sparse-lsh-v1:4x12x16，52 桶探针，最多 128 向量／131072 坐标；先限制身份集合再读取向量，候选截断明确 complete=false。指令检索使用作用域有序 Top-N，再回读原权威验证。新派生存储故障不归类为正文权威损坏；未知格式保留并禁用，已验证派生向量坏行重建，正文坏源仍拒绝。

后台元数据同步与单个原生模型计算分离。刚审核的指令记忆等待有截止时间的元数据同步，不被慢模型遗漏。任务合并版本、持久退避，并有全模型失败暂停；旧空间分批清理。前台查询五秒截止，取消结束调用方等待，但未结束原生工作仍占容量、关闭仍等待真正结束后释放资源。

证据：t08-single-search-path-tests.log 7 文件／44 测试通过；加入查询取消／截止／坏权威测试后的首轮完整 Runtime 为 155 文件／1173 测试通过、1 项指令装配同步失败，原失败保留在 t08-full-runtime-initial-tests.log。归属层拆分元数据工作器后，t08-independent-metadata-worker-tests.log 服务／实际生产 Manifest／索引针对性通过，t08-independent-metadata-worker-types.log、t08-background-architecture.log、t08-background-frozen-contract.log 均通过。最初源测试误用绝对停机截止与旧前台补算测试失败均保留，未修改发布基线或生产验收超时。

尚未验收：新增并发偏好更新测试、最终完整 Runtime 回归、0／100／1000／10000 实测与预算统计、真实后台崩溃／恢复、真实本地嵌入模型小样本、完整 Electron 接线与界面。当前没有为 T08 源码发射 dist／重建 Runtime manifest；不能将源码测试称为桌面已验收。T08 不勾选。下一条具体操作：完成规模基准和后台恢复测试，再发射、构建并进行真实模型／桌面验收。之后 T09／T09A 依原序，完成全部 T16 后最后删除 TODO，直接关机不询问。

## 后续目标模式启动文本

> 以项目根目录 TODO.md 为实施与验收清单，持续完成其中 T01—T16 及 T09A。首先彻底清理另一套 Agent／会话系统及其代码、测试、依赖、构建产物入口和文档；不保留退役格式历史数据导入能力，不删除现有用户数据。按文档中的架构边界、依赖与步骤逐项实现，完成生产接线、异常恢复、实际验证和正式文档更新。持续维护进度、证据与下一步，不把未验证事项勾选完成。全部事项完成且最终验证通过后，删除 TODO.md 与临时引用。


## T08 规模／后台恢复／真实模型证据（2026-10-06）

任务 ID：T08；状态：进行中，生产 Electron 终验待完成。t08-preserved-contract-final-runtime-tests.log 为 158 文件／1182 测试通过；App 95／440、全部类型和构建通过，Runtime 已直接发射并重建实际 build manifest。t08-preserved-reasons-frozen-contract.log 通过。尝试扩大 reason 枚举触犯原 RuntimeCommand／LongMemory 冻结契约，失败保留并已撤回，未改基线。候选截断／忙碌／超时准确返回 complete=false、degraded=true、reason=null；只有实际索引未就绪使用 index_rebuild_required，界面显示不完整与重试建议。

规模：t08-memory-scale-measurements.json 四档实际 SQLite 0／100／1000／10000 全部 passed，使用确定性同向向量制造最坏桶碰撞，不能作为真实语义质量。最终全量并发测试中 10000 条后台建索引约 16968ms，暖查询约 568ms，指令 Top-N 约 1.2ms；80 词法正文＋256 前台 scoped get，查询期间后台正文读取 0、查询嵌入 1，不随记录数逐条读正文。1000／10000 达到 128 候选上限明确 complete=false；SQL 标量桶分组仍会随碰撞规模增长，不承诺常量耗时。65536 维真实存储预算测试只解码 2 向量／131072 坐标。两轮旧调度失效保留在 t08-scale-and-version-fence-tests.log、t08-yielding-scale-and-version-fence-tests.log 和各自 partial JSON；修正为 referenced setImmediate 处理待办批次、idle 轮询 unref，原测试时限未放宽。

恢复：t08-background-owner-crash.json 实际启动独立 Node 生产索引所有者、确认持久 leased 后 OS 强杀，重开同一原权威／派生库补齐 3 向量，原 3 receipts 和 version1 未重放。该计算用确定性适配器，进程中断和 SQLite 恢复是真实的。新增模型计算期间 V2 偏好立即进入指令、旧 V1 不发布；源到期立即不可见，随后物理清除派生向量／任务；坐标／取消／截止／坏权威／崩溃针对门均通过。

真实模型：t08-live-local-embedding.json passed，下载官方 Nomic 固定 revision 的 Q4_K_M 84,106,624 字节并核对官方 SHA-256；实际 node-llama-cpp CPU 构建 3 个 768 维向量约 7751ms，语义首命中正确约 92ms，删除后立即不召回。只证明使用所需 task-prefix 的英文小样本真实接线，不宣称中文／全面检索准确率；真实用户词法配置和现有 Models 不修改。模型资源仅在 artifacts 验收目录。

UI：t08-scoped-memory-ui-tests.log 15 项生产组件／人工数据 Electron 夹具检查通过，包括审核 CAS、删除、分页、会话切换迟到拒绝、窄面板和新受限说明；退出时 Chromium GPU 诊断保留，未记为生产模型／存储通过。默认完整 UI 的 Agent 状态已知失败未删除／弱化，T09A 仍按顺序。electron-t08-bounded-memory-final 真实完整 Main／Renderer／Runtime／HTTPS 夹具／五次 Runtime 强杀及 Main 重开正在运行，尚无最终结果。下一条具体操作：核对该门和实际长期记忆编辑／Agent 工具／指令证据，再复验记忆坏源／模型失败健康原生门，收敛 T08 文档后按 T09、T09A、T10…顺序推进。全清单和 T16 完成、正式文档合并、最后删除 TODO 后直接关机，不询问。

## 后续目标模式启动文本

> 以项目根目录 TODO.md 为实施与验收清单，持续完成其中 T01—T16 及 T09A。首先彻底清理另一套 Agent／会话系统及其代码、测试、依赖、构建产物入口和文档；不保留退役格式历史数据导入能力，不删除现有用户数据。按文档中的架构边界、依赖与步骤逐项实现，完成生产接线、异常恢复、实际验证和正式文档更新。持续维护进度、证据与下一步，不把未验证事项勾选完成。全部事项完成且最终验证通过后，删除 TODO.md 与临时引用。


## T08 最终验收与 T09 开始（2026-10-06）



任务 ID：T08；状态：完成。长期记忆仍由原 Schema 1／冻结接口的唯一 Source 管理，后台增量索引使用独立派生库；原命令收据是同事务变更来源。前台不逐条生成文档向量，候选和指令 Top-N 有界，最终核验作用域、版本、审核与有效期。

本次完成：持久任务／模型空间／代际围栏／取消与真实原生调用占用／查询截止时间／损坏重建／源损坏严格隔离。多文档故障不会被另一个成功清除；计算期间重建不会删除新代际任务。新派生库专用失败任务索引消除了每轮全任务扫描；SQLite 执行计划使用该索引和元数据主键。

验证：最终 Runtime 158 文件／1185 项通过，App 95／440、类型与构建通过；架构、原九项固定契约通过。当前 Runtime 已发射并更新构建清单。正常 Electron gate electron-t08-failed-job-index-final 全部通过，含原 70／66／4 请求链、五次 Runtime 强杀、Main／超大 Run 重启及实际 Renderer 创建／审核／编辑／忘记和 Agent 记忆工具／指令上下文。缺失嵌入模型与源数据损坏在 electron-t08-indexed-failures-final-memory-model／memory 的初次及 Main 重启均通过，原源字节保持。

规模：实际 SQLite 0／100／1000／10000、同向量最坏碰撞夹具通过；最新 10000 条后台构建 18341ms，暖查询 601ms，指令 1.6ms。该查询 80 个词法正文、256 次 Source 读取、零后台正文读取及一次查询嵌入；128 向量／131072 坐标预算，65536 维实际最多解码两向量。碰撞 SQL 标量开销仍可随规模增长，候选截断明确 complete=false，不承诺穷尽最近邻。

恢复与模型：实际 Node 后台持久租约强杀／同库重开保留三条原收据和版本，无业务重放。独立真实 native Nomic 768 维 GGUF 小样本语义命中及删除不可见通过，只证明英文任务前缀样本接线，不宣称中文／通用品质；真实用户配置与 Models 未改。15 项记忆生产组件 UI 夹具通过，完整模块 UI 的 Agent 分页问题仍归 T09A。

限制与历史证据：更早失败、未知格式保留、近似候选限制均留存。86055ms 故障检查退化的原共享 JSON 被后续规模运行覆盖，t08-failed-job-index-regression-observation.json 只记录此前工具读到的 10000 条一行；名称含 before 的 JSON 实为改后中间样本，不作为退化原始文件。首轮普通 native 中的通知同步警告保留，不等于真实通知点击已验收。后台超时不释放仍在运行的原生模型所有权。

任务 ID：T09；状态：进行中（先审阅已确认）。当前 Productivity Authority／SqliteProductivityStore／版本化 todo.snapshot.replace 是唯一写入所有者；已拒绝自依赖、环、悬空依赖及修改运行中冻结任务。沿既有命令补齐编辑／删除／依赖，保留目标和验收草稿、显示版本差异，配置折叠、进度／阻塞／结果优先，不增加第二套业务状态。

下一条具体操作：重写 Renderer 草稿与快照耦合逻辑，补齐生产力待办操作和语义状态映射，再验证 CAS、运行中锁定、窄面板和键盘。T09A 随后实施；T01／T04／T07 的环境门槛及 T10—T16 仍未完成。全部验收与正式文档完成后最后删除 TODO 并直接关机，授权持续有效。



## T09 草稿、待办编辑与阶段验收（2026-10-06）

任务 ID：T09；状态：进行中。生产力主视图已调整为进度／阻塞／待办／真实工作流结果，目标、自主推进和调度参数折叠；空隔离记录缩成可展开提示。版本化草稿保留背景刷新期间的本地字段，显式显示当前差异、重新载入或采用当前版本，拒绝后保留输入。既有 todo.snapshot.replace 实现编辑、依赖调整和删除影响确认；运行中引用项保持冻结。

实际所有者／接口：Productivity Authority 与原 SqliteProductivityStore 未改；Renderer useRevisionDraft、ProductivityGoalEditor／Todos／TodoDialog 沿原 goal.put／todo.snapshot.replace 写入。usePanelAction 可选格式器读取实际 PublicResultError.code，不解析 Runtime 的通用英文消息代替业务状态；未知码保留原错误。未增加协议／存储 Schema 或业务状态权威。

验证：3 文件／38 个 Runtime 权威测试通过（原依赖／结果／取消及新编辑、悬空删除拒绝、显式解除关系、冻结标题／删除、修订冲突）。58 项生产组件明确夹具检查通过，含背景标题／验收／期限／并发保留，双版本绑定、依赖环错误、删除影响、消失的已选依赖可取消、可信 Enter 事件、Escape 恢复焦点及 280／360／900 宽度。最新完整 App 95／440、node／web／tests／新增全部 TSX 夹具类型及构建、架构、九冻结契约通过；没有把类型检查或夹具称为实际 Source/Provider 验收。源码 App 已构建，真实完整 Electron gate electron-t09-versioned-editing 正在运行，增加 actual Renderer/Main/Runtime/SQLite 编辑场景并保持所有原 gate 条件和期限。

历史失败保留：最初夹具未提供已发布决策分页字段，补上合法 null 初始目录；第一次和聚焦后 Enter 都失败，确认原驱动仅发 keyDown/up，补真实 Enter char 顺序后可信 keypress/click 和弹窗聚焦通过。完整 TSX 类型检查暴露缺失 correlationId，夹具已补正式错误结构，新的 typecheck:ui-fixtures 纳入 App 例行检查。原完整 UI 所有模块断言未删除或放宽，T09A 的 Agent 分页问题未提前修补。

下一条具体操作：收取真实 Electron 编辑／Agent／Main 重启结果并检查实际截图，必要时修正归属层问题。T09 暂不勾选；随后按顺序进入 T09A。用户全部完成后直接关机的授权继续有效，未完成前不关机。


## T09 首次原生验收失败与夹具修复（2026-10-06）

任务 ID：T09；状态：进行中。electron-t09-versioned-editing 的实际 Renderer/Main/Runtime/SQLite 编辑、依赖环拒绝、显式解除前置关系、工作流、自主推进和记忆场景已通过，但完整 gate passed=false，fatalError=smoke_fixture_session_limit，WorkspaceDocuments 未执行、Main 重启未执行；67 请求／63 响应／4 中止不能作为原 70／66／4 全链通过。

归属原因：新增编辑验收创建额外会话，超过独立 projection-probe 夹具原有 32 会话上限。编辑验收改为复用原 gate 已拥有、且查询确认目标／待办／工作流为空的隔离会话；不删除会话、不清空数据、不提高上限、不跳过旧断言。真实用户目录未使用。截图捕获前等待两次 animation frame，确保折叠状态已绘制。

App 新构建 t09-reused-fixture-production-build.log 已通过。保留 electron-t09-versioned-editing 原失败 JSON、stderr 和截图。electron-t09-reused-fixture-final 正在以原完整期限和五次 Runtime 强杀／Main 重启重验，不提前记为通过。下一操作：核对所有必需结果和实际截图，完成 T09 后才修改 T09A。


## T09 最终验收与 T09A 开始（2026-10-06）

任务 ID：T09；状态：完成。保留 Productivity 单一权威、既有双版本 CAS／依赖图验证／冻结执行上下文；Renderer 主视图与参数配置分离，版本草稿显式处理刷新冲突，增加待办编辑、依赖调整和有影响确认的原子删除。业务状态文案区分提交与执行结果。

最终验证：electron-t09-reused-fixture-final 完整真实 Electron gate passed=true，原 70 请求／66 响应／4 预期中止、五次 Runtime 边界强杀及 Main 重启全部保留；fatalError=null、consoleErrors=[]。实际目标后台 V2 冲突保留本地输入、采用当前版本保存 V3、待办编辑修订 V2、循环依赖拒绝且 Source 不变、显式解除前置边删除修订 V3 均通过。真实并行工作流、冻结前置结果／父会话上下文、自主目标重规划与实际 Tool 取消 join、长期记忆及文件场景通过；Main／超大 Run 恢复通过。Provider 是明确 HTTPS 验收夹具，不宣称真实模型质量。

58 项生产组件夹具检查、3 文件／38 项权威针对性测试、App 95 文件／440 项测试及 node/web/tests/全部 TSX 夹具类型／生产构建、架构与九冻结契约通过。最终生产截图 productivity-editing.png 已查看，目标配置和自主推进均折叠；截图捕获时隔离记录仍在读取，不能拿它证明该记录已稳定为空。稳定空隔离、待办主视图和 280/360/900 宽度分别有 ui-t09-final-missing-dependency 的生产组件截图及断言证据。初次 native 会话上限失败与原始截图保留，不改原限制。

任务 ID：T09A；状态：进行中。优先审阅并修复 Agent 状态全局目录／当前会话详情的范围和布局，随后审阅其他现有模块。全模块旧夹具审阅 t09a-original-full-ui-audit.log 在文件页失败：其未提供 T07 已引入的 documents 服务，尚未到 Agent 页面；这不是生产文件服务失败。先补合法夹具服务，保留全部旧断言，再进行真实可见状态审阅。用户全清单和 T16 完成后直接关机的授权保持，不询问。


## T09A 现有模块审阅与实施顺序（2026-10-06）

任务 ID：T09A；状态：进行中。审阅覆盖生产组件、现行服务、既有独立 Electron UI 夹具；不把夹具当真实 Source。文件树夹具补入生产 WorkspaceDocumentFeatureStore 后，原完整 UI 到 Agent 处明确失败，顶部空目录／分页在面板外，底部操作超过可视高度。重建同一布局容器后原 Agent 操作、计划、终端、生产力、Dockview、记忆、模型及文件断言通过；完整驱动 exit=0，但弹出窗口关闭时仍有 innerWidth 空窗口异常，不能作为无错误全模块验收。

逐模块问题及顺序：

| 顺序 | 模块 | 已确认的问题／当前证据 | 实施范围 |
| --- | --- | --- | --- |
| 1 | Agent 状态 | 原截图通用任务难区分；全局目录与当前会话详情混排；真实组件窄面板底部操作被挤出 | 同一有界布局、目录与详情各自滚动、公开任务 ID／会话／时间、当前项、范围与真实作用域分页、空态 |
| 2 | 执行计划／权限 | 计划未加载目录时把未知数量显示为 0；缺当前会话目录分页入口；权限全局目录与当前会话详情未分别标范围 | 正确加载／部分页文案、复用现有目录分页、明确各段范围；不改变决定权威 |
| 3 | 长期记忆 | 编辑器 key 包含当前版本；刷新读取新版本会重挂载编辑器并丢掉本地字段（源码路径确认，新增交互验收待执行） | 捕获编辑基线、保留草稿、显式版本冲突处理；沿原记忆 CAS |
| 4 | Dockview 弹出窗口／共享控件 | 全模块关闭 popout 时出现 Cannot read properties of null (reading innerWidth)，尽管旧驱动 exit=0 | 捕获原始堆栈，修复实际生命周期所有者；完整 gate 不忽略 Renderer 错误 |
| 5 | 文件／工具输出／日志／终端／聊天／设置与模型 | 现有树键盘、异步详情、草稿、窄面板、设置分类与模型不可用、终端确认已由原组件夹具覆盖；文件页夹具缺当前服务已修正 | 补充关键状态／浅深色／截图审阅，仅修复确证问题；模型能力 T15、文件审查 T12 保持原序 |
| 6 | 生产力／自动化 | T09 已完成默认折叠及草稿／真实编辑；自动化目前属于生产力调度入口 | 检查现有折叠管理与结果展示，自动化新增能力仍归 T14 |

有界与隐私：现行公开 Run 标题由 Publisher 提供静态 Agent run／SubAgent task，目录不能从受保护输入推导摘要。采用公开稳定任务 ID、已在有界会话目录中的真实会话名与时间；未加载会话使用 ID，明确不声称这是任务目标。当前会话筛选使用现有 sessionRunDirectory 及同所有者分页，不在 Renderer 扫全历史或过滤一页假装完整目录。

证据：t09a-original-full-ui-audit.log（文件夹具失败）、t09a-current-file-service-full-ui-audit.log（原 Agent 布局失败）、t09a-contained-agent-full-ui-tests.log（原断言通过但 popout 异常）、t09a-agent-scope-initial-types.log（全部类型通过）。T09A 五个完成框保持未勾选，真实目录、多页／迟到请求、完整无错误 UI 与实际 Main/Runtime 截图仍待验证。


## T09A 有界目录、版本草稿及窗口生命周期实现（2026-10-06）

任务 ID：T09A；状态：进行中。Agent 目录使用原全局／当前会话有界查询，公开标题、会话、实际状态、时间与稳定 ID 后八位区分任务；页内后缀冲突保留全 ID。选择沿实际 Session／Run 打开，晚于其他选择返回的旧请求不能覆盖新会话。目录与详情各自滚动，长标题两行，空详情紧跟列表。计划复用当前会话分页且未知数量显示加载；权限明确全局目录与会话详情。

记忆编辑不再按后台版本重挂载。共享 RevisionDraft 保留字段、明确重新载入／采用当前版本，保存绑定原记忆 ID 和明确版本。删除后保留可复制输入并阻止隐式新建。原生产力 58 项 UI 检查仍通过；记忆 21 项、Agent 最终 16 项 UI 检查通过，覆盖完成／失败／待权限、空列表、长标题、分页、键盘、迟到选择及浅深色 280/360/900 像素。

实际 SQLite 130 条 A 与 1 条 B 的分页测试通过，有界每页 128，迟到 A 不覆盖 B。初次根集成 9 项中 2 个订阅隔离失败，确认投递控制器每次复制同一 receipt 数组；新派生 View 按不可变源及草稿关联复用引用，最终 9 项全过。控制器 195/200 行，前两次 207/202 的边界失败保留；最终完整架构通过，未提升限制。

完整严格 UI 初次失败捕获 Dockview resize 回调访问已关闭窗口 innerWidth。上游 7.0.4 包同函数也缺释放，不以无关升级掩盖问题。固定当前 7.0.2 四文件原始哈希，在监听器所有者内取消 timer；仓库 postinstall／App prebuild 可重复安装并拒绝未知版本。实际发布 helper 两项生命周期检查通过；完整 UI 保留全部原断言并增加 resize 后立即关闭，200 项通过，Renderer error 使验收失败。App 最终 95 文件／440 项、九冻结访问契约及版本化扩展全部通过。

首轮真实 electron-t09a-agent-directory-memory 全门通过（五次 Runtime 强杀、Main 重启保留），Agent Source 查询／精确导航／终态无取消通过；但查看实际截图发现 Agent 位于可视范围外，原布局断言只检查底边，不能认定视觉验收。保留该组 JSON／错误截图。加强水平边界及 checkVisibility，使用原模块最大化入口，electron-t09a-visible-source-lifecycle-final 正在原期限内验收；尚未收取最终结果。之后 ID 后缀与新增真实记忆刷新冲突／删除副本检查需要再次构建及真实门，不能把正在运行的旧构建当新源码证据。

正式边界／操作说明已写入 ui-architecture.md 与 Proposed ADR 0043。T09A 未勾选，尚需实际可见 Source 截图、记忆新场景及窗口恢复结果。下一操作：收取当前门，诊断实际失败（若有），完成最终 Source 构建和可见验收后收敛矩阵；随后 T10—T16 原序。T01／T04／T07 环境验收保持原状态，全部完成后最后删除 TODO 并直接关机，无需询问。

主要证据：t09a-identifiable-task-id-ui-tests.log、t09a-memory-refresh-editing-ui-tests.log、t09a-shared-draft-productivity-ui-tests.log、t09a-final-delivery-paging-integration.log、t09a-directory-memory-full-strict-ui-tests.log（原失败）、t09a-compact-final-full-strict-ui-tests.log、t09a-dockview-lifecycle-tests.log、t09a-final-ui-app-tests.log、t09a-final-ui-architecture.log、t09a-final-persistence-contract.log。


## T09A 原生可见性与记忆驱动失败记录（2026-10-06）

任务 ID：T09A；状态：进行中。electron-t09a-visible-source-lifecycle-final 在原 Main 五分钟边界前未完成，未产出 Agent 验收结果，不能认定通过。保留该目录及独立 TEMP。新增每阶段的窗口边界／可见性／目录行数诊断，不记录私有正文；目录等待逐次读取当前 Source ID 与 DOM ID，不锁住刷新前的旧数组。

electron-t09a-phase-diagnostics-memory 明确失败：memory_smoke_timeout:production_refresh_conflict。原真实记忆创建／审核／Agent 读写／忘记已通过，新增场景刷新仍在 pending 时点击了禁用列表行，原 reviewed Memory 保持 V1，界面没有打开详情，随后等待编辑入口超时。不是记忆内容被覆盖，也未执行新 CAS。修正驱动：等待该真实行 !disabled 后点击，与用户可执行动作相同；保留全部原断言和 60 秒截止时间。

将 Agent 原生 UI 检查移动到生产力编辑后、目标／记忆长场景前，以便及早记录实际失败；原五次 Runtime 强杀、70 请求／66 响应／4 预期中止和 Main／超大 Run 重启仍全部要求。Root npm test 纳入实际 Dockview helper 的两项生命周期检查；不运行会清理当前 Runtime dist 的根构建。最终修复构建 t09a-enabled-native-memory-controls-production-build.log 通过，electron-t09a-enabled-source-memory-controls 正在独立 TEMP 验收。

新增实际记忆场景复用原已审核夹具记录：编辑本地标题／重要性，后台 V2，刷新保留输入并阻止旧 CAS；显式采用 V2 后应保存同 ID 的 V3；随后真实删除，刷新保留可复制正文且不隐式新建。尚无最后通过结果，不勾选 T09A。


## T09A 可见导航、布局恢复与验收驱动修正（2026-10-06）

任务 ID：T09A；状态：进行中。模块入口现在沿生产 Workspace 激活目标；停靠组因其他组最小宽度而被挤出视区时展开该组，切换组解除原最大化。恢复布局时把当前模块宽度传给 Dockview 构造器；旧 panel.api.setConstraints 不更新构造约束，原源码字符串测试未发现此问题。新增真实 Workspace 冷恢复检查，保留持久面板身份／参数并替换旧宽度。

验证：t09a-current-constraints-production-build.log 通过；t09a-canonical-cold-layout-full-ui-tests.log 203 项、t09a-cold-layout-app-tests.log 95 文件／440 项、t09a-cold-layout-fixture-types.log 和 t09a-current-navigation-architecture.log 通过。冷恢复初次夹具给错 layout.load 的响应包装，后一次 null 包装也不合法；失败日志 t09a-restored-constraints-full-ui-tests.log、t09a-cold-layout-full-ui-tests.log 保留。最终驱动使用真实 nullable {layout} 契约，没有屏蔽 Renderer 错误。

原生独立 Source 诊断 electron-t09a-current-source-navigation 通过，实际 Runtime／SQLite／投影目录、精确 Session／Run 和终态动作已核对；1000／1600 CSS 像素截图已查看，Agent 位于视区，使用正常模块入口，没有手工最大化。使用既有隔离 TEMP 数据且不发新任务；这是只读页面复验，不代替完整 Provider／恢复门。electron-t09a-natural-visible-module-revisit 原失败实际宽度为 234.67、全部在视区，旧驱动错误要求内容宽度 >240；改为正尺寸、可见性和完整视区边界，保留失败证据。主驱动恢复原模块／会话／窗口边界。

计划组测试初次 moveTo 参数错误，后一次 panel setter 不生效：t09a-module-navigation-full-ui-tests.log、t09a-valid-group-navigation-full-ui-tests.log、t09a-navigation-geometry-full-ui-tests.log 保留；最终使用真实 group API 设置两个组约束，等待实际超界再验证入口展开。生产恢复采用构造约束，二者职责不同。构建初次 contentComponent 可选类型错误 t09a-constructed-constraints-production-build.log 保留，修正为可选字段检查。

当前完整门 electron-t09a-natural-source-final 使用原五分钟 Main 期限、原五次 Runtime 强杀及原 Provider 请求限制；正在收取记忆 V2 刷新冲突／V3 保存／删除副本与桌面重启，尚不能标完整通过。T09A 五项继续未勾选。下一步：核对完整门结果与实际截图，更新 ADR／矩阵后才进入 T10。全部清单完成、正式文档归档及最后删除 TODO 后直接关机，不询问。


## T09A 最终模块验收与后续顺序（2026-10-06）

任务 ID：T09A；状态：完成。已按既定模块审阅顺序完成 Agent 目录／详情、计划／权限范围与分页、记忆版本草稿以及 Dockview 生命周期与可见导航修复。其他既有文件、工具、日志、终端、聊天、设置／模型、生产力／调度页面使用原组件交互验收；其新增业务能力保持 T10—T15 原序。

最终完整原生门 electron-t09a-settled-source-final passed=true，fatalError=null、consoleErrors=[]；原 70 请求／66 响应／4 预期中止、五次 Runtime 强杀和 Main／超大 Run 重启全部保留。Agent 实际全局／当前会话有界目录、精确 Session／Run、终态动作、无选中范围与正常模块入口通过。原 1600 截图在 resize 后两帧尚未结算，内容留在旧组位置；该截图不能作为正确布局证明。之后加强所属内容区边界及三个稳定采样，等待 Dockview 实际布局一致，electron-t09a-stable-owner-final 在同一完整门隔离数据上复验通过；1000／1600 CSS 像素实际截图已查看。此后只有捕获驱动改变，产品 Source 未改变，不把后来的截图嫁接进旧门。新记忆场景以原 Authority／SQLite 验证后台 V2 更新保留本地字段、显式采用后同 ID 保存 V3、删除后保留副本且不创建替代条目。原实际 Agent 记忆工具、审核、读取／忘记、完整目标／工作流／文件／模型夹具场景仍通过。HTTPS Provider 是确定性验收夹具，不证明真实模型质量或签名安装包／硬件外部门。

完整 UI 203 项通过，保留原断言，新增立即 resize 后关闭 popout、两个受约束组裁切导航、真实冷布局恢复。Agent 16 项、记忆 21 项、生产力 58 项组件检查；实际 SQLite 130 A／1 B 目录分页与迟到选择根集成 9 项通过。App 95 文件／440 项、所有类型和生产构建、架构、九冻结持久契约及既有扩展通过；没有提高旧限制或改业务存储版本。完整门构建 t09a-shared-memory-case-production-build.log；捕获驱动最终构建 t09a-stable-owner-capture-production-build.log。UI／类型／App／架构证据沿前条记录。

失败保留：electron-t09a-natural-source-final 未在原五分钟到达 Main 边界。其原记忆 Tool 场景已有实际 60／56／4 trace 和候选删除 V4，但已审核记录仍 V1，新步骤在刷新后选择处未完成；不能当作完整通过。驱动先等待两帧渲染及刷新结算，避免在 React 提交 pending 禁用前立即点击旧按钮。共享同一真实刷新／CAS／删除场景，electron-t09a-settled-source-memory-revisit 在保留隔离 TEMP 上通过；随后完整门通过。独立复验只修改明确验收记忆，不创建新会话、不碰真实用户数据，也不替代原 Provider／重启要求。初次不可见截图、手工最大化阶段、错误宽度阈值、错误夹具响应包装和原依赖回调异常仍保留，最终可见性和错误收集条件没有放宽。

正式说明、ADR 0043 与验证矩阵已更新。T01／T04／T07 外部门保持原状态；T10—T16 尚待完成，整体仍未完成。下一操作：T10 沿原 Productivity／Projection／Conversation 权威实现授权只读任务聚合和分页，接入精确导航与原操作所有者；不修改九个冻结访问接口、不建立第二业务状态。全部清单及最终验收完成后，归并正式文档，最后删除 TODO，再直接关机，不询问。


## T10 跨会话任务中心开始（2026-10-06）

任务 ID：T10；状态：进行中。T09A 已完成后按顺序开始。确认原 SqliteProductivityStore 的 Goal／Workflow／Schedule／Occurrence、Projection 有界目录及 Conversation 稳定引用为来源；现行 ProductivityAuthority 和 PublicProjectionCatalogQueryStoreV3 已冻结，不修改它们的方法形状。新任务查询为同一所有者的版本化只读扩展，派生快照可重建，不保存新的执行状态。

已记录 Proposed ADR 0044：复合来源 ID、层级关联、授权过滤、有界批次、快照分页、水位／部分覆盖及精确版本导航。调度投递不等于 Run 完成，结果正文不进入目录；旧 Source 更新后不静默取消较新版本。提醒沿原 Main 所有者和偏好去重，T04 物理验收仍单列。

下一操作：实现严格列表／查询契约与 Productivity 只读扩展，接入 Runtime 授权聚合和可重建分页快照；以实际多工作区 SQLite 测试验证来源、版本和分页，再接 Renderer 模块与原导航／恢复入口。三个 T10 完成框保持未勾选，T11—T16 维持原顺序。全部完成后最后删除 TODO 并直接关机的约定保持。


## T10 只读来源与严格查询契约（2026-10-06）

任务 ID：T10；状态：进行中。新增 ProductivityTaskCatalogReadV1 由原 SqliteProductivityStore 同连接、同读事务委托实现，未改变原九个冻结访问接口或数据库 Schema。仅查询白名单元数据与关联 ID，不导出提示词、私有执行上下文或结果正文。Goal／Workflow／Schedule 的原版本和 Occurrence 的尝试次数／来源状态分别保留；submitted 不伪装为执行成功。

严格任务契约包含复合 ID、来源总关联数与有界摘要、工作区／会话／状态／时间过滤、三来源水位、最终一致性与精确决策 ID／版本。大关联可沿来源版本分页读取，变化返回 stale。实际 SQLite 六项测试覆盖 130 条分页、多工作区隔离、原执行提交状态、40 个明确标为合成的关联 Run、版本变更与关闭重开；合成引用不证明真实 Core 执行。

证据：t10-productivity-source-read-tests.log 六项通过；t10-scoped-navigation-read-contract-tests.log 七项通过；t10-productivity-read-extension-types.log、t10-initial-read-extension-architecture.log、t10-source-read-frozen-persistence-contract.log 通过。最新导航字段尚未构建，Runtime 查询路由、派生稳定快照和 Renderer 尚未接通，不能声称桌面通过。三个 T10 完成框仍未勾选。

下一操作：实现有界派生快照、授权聚合与导航前原版本核验，接通生产命令及任务中心界面后进行实际窗口验收。全部清单完成、最终验证和文档收敛后最后删除 TODO，再直接关机，不询问。

## T10 生产只读接线、固定分页与界面实现（2026-10-06）

任务 ID：T10；状态：进行中。同一 Productivity 所有者提供元数据与版本化关联读取，Conversation 同一事务所有者增加只读消息身份扩展；任务目录不读消息正文、私有提示或决策令牌。可重建 task-query SQLite 索引由独立派生资源租约管理，生产 Agent 服务启动有界后台采集，退出先等待采集结束，原关闭屏障失败时不释放新租约。三个来源的水位与部分覆盖明确显示，调度 submitted 没有 Conversation/Core 执行证明时仍可查看，但标 unknown；恢复导航回原 Productivity 所有者。

派生快照限 16 个、五分钟有效；页按行数及 2 MiB 双重约束，第一页同样有 HMAC 游标，返回上一页仍读取同一固定版本。授权和完整筛选摘要绑定游标，新增精确来源查询用于关联定位。导航重读原 Core/Productivity/Conversation 的所有权、归档与期望版本，结果只返回已核实的不可变消息引用；点击后原详情接口才访问正文。新 tasks.center 模块提供范围、来源、状态、更新时间、归档筛选、覆盖说明、分页、元数据与关联入口，保留有界页面、选择与滚动；原操作仍由原模块执行。

验证：此前完整 Runtime t10-preserved-owner-fences-full-runtime-tests.log 为 161 文件/1209 项通过；后续 unknown、精确来源及第一页游标修改的最新相关 SQLite/聚合/结果导航复验 t10-fixed-reference-source-tests.log 为 3 文件/28 项通过。App 四套类型检查 t10-canonical-panel-types.log 通过，交互 Store t10-filter-bound-feature-tests.log 六项通过。失败日志保留：原完整 Runtime 两项失败分别为派生唯一键回滚错误地锁故障及测试漏关新增派生租约，已修正并复验；新界面初次引用未导出的类型、首轮 Store 夹具将不匹配筛选的行传入严格页契约，失败记录同样保留。证据在 artifacts/todo-remediation/。

尚未验收：最新全量回归、原生任务中心实际导航/像素、大关联的公开分页入口、待确认项准确聚焦及完成/失败偏好提醒。当前类型/夹具与实际 SQLite 结果不代替真实桌面或 Provider/Core 验收；三个 T10 框保持未勾选。下一操作：补齐严格关联查询和导航焦点，再用实际 Source 数据接入桌面验证；随后 T11—T16 按原顺序推进。全部完成、正式文档收敛和最后删除 TODO 后直接关机，不再确认，授权持续有效。

## T10 有界任务界面、来源关联分页与正式 Profile（2026-10-06）

任务 ID：T10；状态：进行中。任务中心已使用既有 SelectMenu，明暗主题 280/360/900 像素、键盘选择、精确导航调用、固定第一页返回、状态未知的原恢复入口、过期拒绝以及返回筛选/滚动共 21 项组件夹具检查通过；长标题经过实际截图检查后限制列表两行、详情三行并提供全文展开。TaskCenterFeatureStore 保留一页和有界历史，关联另保留一页；tasks.relations 按原 Productivity 版本、Occurrence 尝试及来源状态前后双重校验，授权后核实原 Conversation 子会话/Core 绑定，再返回可访问关联。来源关联总数不等同于已核实运行数。

原 Projection Repository 的 selectedDecisionId 已暴露为只读展示选择，权限/计划原卡片在模块自己的滚动容器内聚焦；不引入任务操作令牌或第二决策状态。RuntimeSnapshot 定义及精确决策动作校验职责拆出，原热点限额不放宽。派生库验证精确表/索引/约束格式，未知触发器同样保持原文件而不重建。ProductivityTaskCatalogReadV1 与 ConversationMessageIdentityReadV1 已单独冻结基线，九个原契约和所有既有扩展未覆盖。

最新证据：t10-source-relations-full-runtime-tests.log 161 文件/1213 项通过；t10-shared-select-full-app-tests.log 96 文件/446 项通过；t10-task-center-full-renderer-ui.log 原有加新增共 224 项通过且无 Renderer 错误；t10-child-session-relation-tests.log 12 项通过（实际 SQLite/Conversation，Core 结构观测明确为合成）；t10-preserved-trigger-snapshot-tests.log 8 项通过；t10-new-read-port-baselines.log、t10-source-relation-focus-architecture.log、生产类型/构建均通过。

真实桌面首轮 electron-t10-task-center-source-first 超时，后续 electron-t10-task-center-source-phases 精确诊断为正式桌面 Profile 未包含新模块，模块菜单没有任务中心。两轮失败保留，不冒充桌面通过。生产 UI_COMPONENT_IDS 已加入 tasks.center，Profile revision 从 5 升至 6；预览专属 review.visual 仍保持隔离。正在构建并重跑原生门。首次关联夹具把执行引用绑定到父会话，原授权核验正确拒绝；改为读取来源的实际子会话并在独立 SQLite 创建对应会话后，40 个可访问关联全部到达，一个错误 Core 工作区引用仍被拒绝。所有失败和构建日志位于 artifacts/todo-remediation/。

尚未验收：真实 Task center Source/结果 DOM/返回位置、原权限/计划焦点与大关联 UI，完成/失败偏好提醒及完整桌面重启门。T10 三框继续未勾选，T11—T16 保持原顺序；T01/T04/T07 的外部门未伪造通过。全部完成、正式文档合并、最后删除 TODO 后直接关机，无需询问。

## T10 实际来源目录与 Main 终态提醒（2026-10-06）

任务 ID：T10；状态：进行中。实际 Electron Source 验收 electron-t10-task-owner-source 已通过 53 条原 SQLite/Core/Projection 记录、五类来源、两页固定游标、精确 Core v15 与不可变结果消息、过期拒绝和返回位置，1000/1600 像素布局与截图已核对。前一轮实际来源读取成功但采集器按面板 DOM 祖先寻找 Dockview owner，因 portal 关系导致布局门失败；现按所属 module-tab 定位 group/content，未改变产品布局或放宽边界。

完成/失败提醒新增偏好入口，共用 Main 原 ApprovalNotificationService、唤醒合并、三次展示预算和后台/游戏抑制规则。只消费授权终态 Run 元数据，完成须有已核实结果；展示/点击分别重读原所有者与精确版本，不复制正文或批准令牌。Main notification-delivery.db 保存开启时间和实际 native shown 回执，不按数量/年龄淘汰导致重发；未知格式保持原文件并暂停终态提醒。首次开启不补发旧历史，已开启边界及送达回执跨 Main 重启保留。T11 必须覆盖该显示账本和原 decision-notifications.json。源偏好切换使迟到页/展示失效，原审批提醒仍独立可工作。

验证：t10-terminal-reminder-full-app-tests.log、t10-original-decision-full-app-tests.log 为 99 文件/458 项通过；新增真实 SQLite 回执4项与终态读取/原通知所有者4项、Windows activation严格2项通过。所有 App 类型与生产构建、架构通过；t10-terminal-reminder-full-renderer-ui.log 226 项通过，t10-relations-reminder-ui.log 26项组件夹具通过，含45条关联的32/13页与版本拒绝。电子 Source electron-t10-terminal-preferences-source-ps51 实际偏好保存及原目录/结果/布局通过，不产生新 Provider 请求。

修正用户问题导航归属：原任务中心错误地导向没有输入卡片的 Agent 状态，现打开原聊天卡片，所有原卡片只在可见时聚焦所属滚动容器。t10-question-original-navigation-runtime-tests.log 12项通过，Runtime 已直接发射及重建 manifest。完整原桌面脚本已加入既有 question 和 workflow permission 在未结算时的精确 UI 焦点检查，正在执行 electron-t10-original-decisions-full；仍保留原请求数、五次 Runtime 强杀与超时要求。前置失败保留：模块采集脚本使用 PowerShell5.1不支持的HashData，已改为可移植SHA256实例；完整脚本第一次相对输出路径被原前置校验拒绝，已使用绝对路径重跑。

尚未验收：完整桌面新焦点/重启门、原计划卡片实际焦点、终态通知真实 native shown/重启/点击、最终新版全量合并回归和正式文档收敛。系统通知物理点击/历史删除/活跃游戏仍属于 T04 未完成门；三个 T10框不提前勾选。T11—T16按原顺序继续，全部完成后最后删除TODO并直接关机，无需再次确认。

## T10 最终任务中心与终态提醒验收（2026-10-06）

任务 ID：T10；状态：完成。授权只读聚合、来源复合身份、三来源水位、稳定分页与筛选、关联分页、原版本导航、结果窗口、待确认卡片及完成／失败偏好均已接通原所有者。T04 的 Windows 物理点击／历史消失／冷激活／活跃游戏验收保持未完成，不将 native shown 回执写成物理点击。任务中心不建立执行状态或重复通知服务。

完整原生门 electron-t10-durable-decision-evidence-full passed=true、fatalError=null、consoleErrors=[]；保留 70 请求／66 响应／4 预期中止、五次 Runtime 强杀、Main 重启和超大 Run 恢复。实际来源目录 33 项、五类来源、两页，三来源水位 ready；精确原 Core v12／不可变结果消息、过期拒绝、会话范围与返回筛选／位置通过。原 permission 和 user_question 未结算时的真实 Core／Decision 版本、原卡片可见与焦点通过；1000／1600 CSS 像素所属容器布局与截图已查看。此目录规模与先前独立 Source 门的 53 项分别记录，不混用。外部 HTTPS Provider 是确定性验收夹具，不代表真实用户模型质量。

electron-t10-native-completed-failed 使用原 Main／Runtime／SQLite 和原 Provider/Core 链路，四个 pending Decision native 回执、实际 Runtime 强杀／同版本去重／四决策结算、权限副作用和批准计划完成均通过。权限及两个计划卡片精确聚焦通过。实际 completed v7 和 failed v3 收到 Windows native shown 回执；失败由原引擎拒绝夹具的空白模型输出产生，不直接写失败数据库。electron-t10-terminal-main-reopen-settled 在同一隔离数据上从 Main PID 169720 重开至 163888，核验三 completed／一 failed 的原 Core 版本，保持两类偏好开启时间及全部送达账本不变；后台观察 35000 ms 后没有新增展示尝试。该门是实际干净 Main 重开，不冒充物理强杀或系统点击。

最终类型／生产构建 t10-native-restart-single-refresh-build.log、架构 t10-terminal-reminder-final-architecture.log 通过；完整 Renderer t10-final-full-renderer-ui.log 229 项通过。App 最近完整门 t10-original-decision-full-app-tests.log 为 99 文件／458 项，Runtime 最近完整门 t10-source-relations-full-runtime-tests.log 为 161 文件／1213 项，随后唯一 Runtime 产品变化 user_question 原导航归属通过 t10-question-original-navigation-runtime-tests.log 12 项并直接发射／更新 manifest。实际 SQLite 40 个授权关联／一错误 Core 归属拒绝、跨工作区、部分故障、取消、归档、变化版本、原 pending Decision、稳定快照和迟到选择均在各级所有者测试中验证。新增实际 native 夹具及 Main 重开观察器不改变产品领域逻辑。未重复完整 Runtime/App 门冒充新增真实模型覆盖。

历史失败保留：electron-t10-original-decisions-full 的取消驱动未恢复父会话；修正原驱动导航范围后，electron-t10-restored-parent-full 因 question 证据仅保存在会被 reload 清空的 Renderer 全局而失败，现通过首次 Main observation 保留实际原验证结果。Main 重开首轮在来源尚 building 时过早断言；第二轮每次 refresh 重新触发构建而超时，现首次刷新后只观察已发起构建，不提高原超时或放宽 Core／回执比较。三轮重开各自输出独立保留。提醒文字删除没有实际通知政策支持的锁屏承诺，实际规则仍为后台／游戏。

正式 ADR 0044、ui-architecture.md 和验证矩阵已收敛。T10 三项已勾选；T01／T04／T07 原独立外部门保持状态，整体未完成。下一操作：按 T11 原步骤审计精确存储清单、Main／Runtime 一致冻结边界、同机密钥材料及恢复切换，再接入用户界面并完成独立恢复演练。全部清单和最终验收完成、正式文档合并、最后删除 TODO 后直接关机，不询问，授权持续有效。

## T11 受控维护与备份基础开始（2026-10-06）

任务 ID：T11；状态：进行中。按 T10 完成后的顺序进入。清单沿实际 Main constructor、DatabasePaths、Owner Lease、Conversation attachment 与 safeStorage 建立，确认文件名为 file-drafts.json；同机恢复必须包含 sessionData/Local State、Agent 密钥环及两个通知账本，不递归打包 userData、模型或工作区原文件。备份 Manifest 使用封闭来源／路径白名单、精确文件大小／摘要与 SQLite 元数据；可选文件缺失必须显式记录，重复、路径逃逸、退役格式和缺失密钥材料被拒绝。

原 RuntimeSupervisor 停止路径允许强杀后正常返回，不能作为备份一致边界。新增 withOfflineMaintenance 在同一生命周期所有者内阻止新请求／启动／配置，必须观察 shutdown_complete 和真实干净进程退出才进入离线操作；关闭未确认时不调用复制，失败后恢复原 Runtime，不重放备份操作。原普通退出／重启行为没有被备份要求替代。Main 的后台写入／IPC 冻结与全部队列 flush 尚未接通，不能声称完整维护窗口已完成。

Runtime 备份适配器先取得七个现行所有者的全部租约，再用 SQLite VACUUM INTO 捕获提交 WAL，并校验 quick_check、user_version、实际 schema 摘要和文件字节摘要。附件仅接受原 v1 内容寻址对象，核验摘要及前后文件身份；未发布临时附件单独计数。失败只清理本次已完成输出文件，不修改源数据。Main／Runtime 私有协议共享原固定数据库路径，九个冻结业务访问接口未变。新增 storage-maintenance-process 为仅存储的辅助子进程，不启动第二 Agent／调度／推理主干；Main 桥接要求绑定响应及实际辅助进程正常退出。原 Runtime 的维护交接集成验收正在执行，不提前写通过。

文件封装使用 Node AES-256-GCM、128 KiB 缓冲和独占创建；认证绑定备份 ID、来源身份、大小、摘要与物理 SQLite 元数据。错误密钥、被替换身份、密文损坏和源摘要变化都拒绝；失败输出被移除，原文件和既有目标不覆盖。随机备份数据密钥直接采用 Windows CurrentUser DPAPI 包装，避免使用需要先恢复 Local State 的 Chromium profile 密钥来打开备份本身。固定系统操作通过 stdin 传字节，不把密钥放入参数／日志／明文临时文件；实际 Windows 往返及损坏拒绝已通过。这不证明完整草稿／受保护载荷恢复或跨机迁移。

验证：t11-maintenance-manifest-owner-tests.log 24 项通过，含实际生产 Runtime 正常关闭／恢复；t11-current-owner-layout-tests.log 8 项通过；t11-authenticated-backup-object-tests.log 7 项通过，含 Windows DPAPI 和真实文件加密／损坏／既有目标保护；t11-offline-sqlite-owner-backup-tests.log 12 项通过，含进程退出后已提交 WAL、全部七租约、附件损坏和源文件保留。t11-backup-foundation-app-types.log、t11-backup-foundation-runtime-types-fixed.log、t11-backup-foundation-architecture.log 与 t11-backup-foundation-frozen-contracts.log 通过。首个 Runtime 类型门因 buckets 隐式数组类型失败，已声明 Dirent[]，失败日志保留。私有 Worker Protocol 已构建，Runtime 使用直接 tsc 发射及 manifest 更新，未清理活跃产物；新 Source 交接门结果另记。

尚未完成：Main 完整冻结／flush、加密 manifest／原子备份发布、隔离恢复与原 Runtime 只读验证、可恢复目录切换、导出／统计／清理预览、桌面 UI 及完整独立恢复演练。ADR 0045 保持 Proposed，T11 四框保持未勾选。下一操作：核对正在执行的原 Runtime／私有 Snapshot Worker 集成门，随后接 Main 写入冻结、受控快照和备份封装，按原步骤完成恢复／UI。T12—T16 与原独立门保持顺序和真实状态。全部完成、正式文档收敛、最后删除 TODO 后直接关机，不询问；整体尚未完成，不提前关机。

## T11 原所有者冻结、加密目录与只读恢复校验进展（2026-10-06）

状态：进行中。MainMaintenanceGate 已接入 Application 全部当前持久化所有者、变更 IPC、设置事务及 MCP connect/send/callback。原通知消费者可暂停／恢复；延迟 shown 不写冻结账本；PTY 退出和窗口位置事实延迟落盘。DataBackupService 等待已接受事务，使用原 Runtime 正常关闭与辅助进程实际退出、Main 队列 flush，并通过原 Main SQLite 连接快照通知账本。原 Runtime 恢复后加密私有副本；加密认证 manifest 与所有对象全部同步后同卷目录发布。隔离解包拒绝身份／密文损坏、错密钥、额外对象；失败清理只针对本次私有目录。

实际 Windows DPAPI 和目录往返门 t11-encrypted-bundle-isolated-extraction-tests.log：4 文件／10 项通过。t11-original-owners-encrypted-backup-integration-tests.log：8 文件／66 项通过，含真实原 Runtime 七数据库、Main 状态／通知 SQLite、清理／不发布及必需文件缺失后的恢复；Renderer／通知 hooks 与密钥文件字节为夹具，不能作为完整 Electron 恢复证据。t11-original-owners-backup-integration-app-types.log、t11-main-snapshot-coordinator-architecture.log 通过。原私有 Worker 交接 t11-hidden-private-storage-worker-tests.log 4 文件／29 项、原 Protocol 全量 t11-strict-storage-root-full-protocol-tests.log 20 文件／106 项均实际完成，不再是正在执行。

只读布局辅助进程复用原七所有者 schema／authority 校验，全部只读业务连接并取得原租约，不启动 Actor／调度／推理／工具，也不执行迁移。隔离七库前后字节比较一致；旧 Agent schema 7 被拒绝并保留，活跃原 Runtime 租约拒绝离线验证。t11-original-readonly-layout-validation-tests.log：3 文件／29 项通过；t11-private-readonly-layout-protocol-tests.log 实际仅1文件／3项通过；t11-original-readonly-layout-app-types.log 与 t11-private-layout-validation-protocol-build.log（含直接 Runtime 发射／manifest）通过。

原 Agent 密钥锚校验已提取只读入口，允许真正空库但不安装锚；已有锚的代次和活动密钥错配均拒绝，遍历保护载荷键不再一次载入整个结果集。原计划和 directive 解码器移入共享所有者读路径；新逐条恢复审计复用原 checkpoint／Turn input／Effect input/result／计划／委托／directive 读者和 AES codec，返回计数而不外传解密正文。实际原 Core 生成的加密响应可以经只读连接审计，错密钥拒绝，原表内容不变。t11-original-readonly-key-payload-audit-tests.log：6 文件／71 项通过；t11-shared-recovery-readers-runtime-types-fixed.log 通过。前置类型失败因少传 digester 与 Effect result 未收窄已按原接口修正，失败日志保留。

该逐条载荷审计尚未接入私有恢复辅助进程或真实 Electron 隔离 profile 解密。尚未完成：完整 Main 格式／密钥验证、实际同机受保护载荷和附件恢复、可恢复目录切换 journal、Settings IPC／UI、Session 导出、占用／清理预览、独立完整恢复演练。ADR 0045 Proposed，T11 四项不勾选。T12—T16 和原独立门按顺序继续；全部完成后收敛正式文档、最后删除 TODO，再直接关机，不询问。

## T11 独立原生加密备份与只读恢复验证（2026-10-06）

状态：进行中。私有 validate-recovery 请求复用原密钥环契约并绑定本操作 ID；原七所有者租约保持到逐条保护载荷审计结束，密钥 Buffer 和 AES codec 在释放前清零／销毁。Conversation 恢复复用原不可变消息解析与正文摘要校验、Saga 行读取以及原图像存储的大小／摘要／媒体格式检查。Main 原所有者增加不初始化、不迁移、不修复的现行格式只读入口，原通知 SQLite 同样只读检查 Schema 和每行身份／时间／尝试状态。

隔离 Electron 子进程使用单独的 Local State 副本和原 safeStorage cipher，不将待恢复目录作为 Chromium 可写 profile；全部私有响应绑定请求并等到实际进程关闭。正常退出先等待已准入备份操作完成，避免提前关闭原通知连接／Runtime 或摧毁 profile。Main／Runtime 进程桥接留在原 Main runtime 边界；未修改桌面结构规则或架构基线。

原生独立证据：t11-native-protected-backup-source-acknowledged-delivery.json 使用真实 Windows 安全存储密钥、生产 Runtime 和原 Core／Conversation 命令的明确合成输入，原 DataBackupService 正常冻结／恢复并原子发布 18 文件、1092240 字节的认证加密备份。独立 t11-native-authenticated-protected-profile-recovery-tests.log 一项通过；对应 JSON 核验九个 Main 文件、五个保护载荷和一张正规化消息图像。真实 Electron 解密成功；有效恢复文件与源文件字节不变，损坏的 OS 密钥环密文及 Agent schema 7 被拒绝并保留。验证期间未启动 Actor／工具／调度，没有物理操作。源夹具的 Renderer／通知维护 hooks 没有窗口；不将其写为生产交互维护或真实模型质量验收。

回归：原 Runtime 全量串行 t11-original-readonly-full-runtime-serial-tests.log 163 文件／1220 项通过；App 全量串行 t11-main-current-owners-full-app-serial-tests.log 106 文件／487 项通过（在后续原生 validator 和退出等待改动之前）。最新 t11-private-recovery-and-quit-owner-targeted-tests.log 六文件／41 项，t11-current-protected-recovery-final-protocol-tests.log 20 文件／108 项、原生夹具类型与架构均通过。原并行全量的 SQLite／大账本默认时限失败，隔离及串行复验通过；没有加长源测试时限。较早类型错误、TEMP 8.3 映射和原生失败日志全部保留。

早期 T10 开发 profile 在恢复密钥锚阶段正确拒绝：它使用 strict-json-v1、没有生产密钥锚，不能作为加密恢复证据。新原生合成 Core 夹具首次在 Electron 主机直接调用 Node Core，后移回 Node 所有者；未链接 Saga 的终态 Run、未确认的合成 handoff 送达分别被原冷启动边界拒绝。现通过原 Saga 请求／链接及原精确 outbox claim／ACK 完成夹具事实，再由实际 Runtime 重开并处理结果，未改产品检查放行失败样本。

尚未完成：可恢复目录切换／中断选择／切换后完整重启读取，Settings 交互入口、会话导出、占用统计和版本化清理预览。ADR 0045 保持 Proposed，T11 四框不勾选；T12—T16 及 T01／T04／T07 原独立门仍待完成。全部完成后收敛正式文档、最后删除 TODO，再直接关机，不询问。

## T11 受控目录切换、恢复预览与占用统计进展（2026-10-07）

状态：进行中。Main 现有数据库、持久化队列、Renderer 草稿 barrier 和原 Runtime 正常 shutdown/ACK/实际退出已接入恢复提交。切换辅助进程单独打包为 Node CJS，保持 detached 生命周期，必须获得原 Main 实际进程退出码 0、一次 arm 和原目录独占 OS lease 后才能校验并切换。取消、非零退出、未知关闭结果保留原目录与恢复证据。释放自己的 Windows 持锁进程时等待实际 close，随后才重启应用。

切换 journal 记录确切 inode/dev 身份、候选/保留目录、认证 Manifest 摘要和阶段；处理 rename 与记录之间的进程崩溃，不删除或合并目录。正常启动发现未结算记录时，先切换到独立恢复选择 profile，不启动原 Application/Actor；只能选择原目录或再核验摘要的新目录。该启动选择的完整原生交互尚待验收，不能把 journal 单元测试视为真实物理断电耐久性证明。

真实原生进程门使用当前格式 18 文件备份：Electron 退出 7 时辅助进程退出 1、原目录不变；退出 0 时辅助进程实际完成切换、18 文件摘要匹配、原目录保留。该门未创建完整 ApplicationController 或 Renderer，原所有者 shutdown 另由 Runtime/Main 集成门覆盖；完整应用冷启动读取与原生选择器验收仍未完成。

严格恢复核验发现 ready 所报 Public Projection 版本仍是基础 3，而实际原数据库已正常升级为 4。已修正原 AgentEntityHandle readiness 的版本来源，DataBackupService 发布前核对七个数据库实测版本与 Runtime 冻结边界；旧不一致备份保持原样并拒绝，重新生成当前 Schema 的独立原生测试备份。13 项原 Runtime readiness 检查通过。

Settings 已接入 Main 原生备份/恢复选择器、严格 preload/IPC、15 分钟一次性恢复票据、范围预览、默认聚焦取消的恢复确认、忙碌防重复以及卸载后迟到预览回收。Main 保留路径/解密暂存所有权；取消、到期、过期提交与正常退出清理本操作暂存。候选组装失败消费票据并保留失败候选证据，不关闭原所有者。原生服务生命周期门单独通过，涵盖实际 OS 密钥保护/原 Main 读取/Runtime 只读载荷校验；UI 夹具不代替完整 Main 交互。

数据占用沿原封闭文件清单统计数据库及 WAL/SHM、消息图像、私有数据、未发布附件临时文件的逻辑长度。明确这是运行时采样，非分配簇大小或一致性快照；不遍历整个 userData/工作区，不统计兄弟恢复目录。三个文件系统测试核对精确分类/总和、必需文件缺失、未知对象和 junction 拒绝。初次第三项测试使用 rm 删除空目录失败，改为 rmdir 后三项通过；原失败日志保留。

验证：App 最新整套串行回归为 108 文件/504 项通过、3 个 opt-in 原生门跳过；该回归在占用统计加入前，不能冒称统计也经整套验证。新统计单独 3 项通过，数据页 14 项隐藏 Electron DOM 检查（包含 1000/360 布局）通过，截图已生成；此前两种恢复预览截图已审阅。最新包含等待 lease 释放和占用的 App 类型/构建通过；架构门在占用统计加入前通过。原生恢复生命周期及 13 项 OS lease/journal 检查通过；无架构例外或超时放宽。

尚未完成：完整应用的已恢复数据冷启动/历史、附件、受保护状态与不重复副作用演练；中断恢复选择实际门；会话导出；按类别和精确版本给出影响预览并执行清理；完整窗口/原生 picker 与安装包资产验证；最新全量/冻结契约复验。T11 四框仍未勾选，ADR 0045 保持 Proposed，T12—T16 按原顺序保留。全部任务与最终验收完成后收敛正式文档，最后删除 TODO，再直接关机，不询问；当前不关机。

## T11 授权会话正文导出进展（2026-10-07）

状态：进行中。会话侧栏菜单新增“导出会话正文”，先明确 JSON Lines 从新到旧、正文与图像引用范围、排除图像字节/工具详情/推理过程/私有执行载荷/系统凭据，且正文导出不能用于应用数据恢复。确认默认聚焦取消，Main 原生 Save Dialog 选择新文件；Renderer 仅发送严格 Session/Workspace/scope/format，不能指定源文件或目标路径。

Main 沿原授权 Public Projection Session Catalog 固定 C 获取消息元数据页，再读取原 Body Reference 或逐块验证并组装单个 Run interaction。完整 Message/Metadata/Chunk/Merkle/顺序证明仍由原协议验证器核验；拒绝跨 scope、失效快照、摘要损坏和空页继续。逐条流式写出，不缓存整个 Session/Run；最多 100,000 条/512 MiB，超限整次失败，不发布截断文件。发布前同步私有同目录临时文件，用 exclusive hard link 生成新目标；现有或并发生成的目标不会覆盖，不支持硬链接的文件系统明确失败。失败只清理确切 inode/dev 的本操作暂存；Main 退出等待正在进行的导出。

四项原已发射 SQLite/RunDocumentPlan 集成门通过：260 条跨页正文，导出过程中原消息更新/新增仍读取原 C；外国 Session 排除；1.2 MB 中文 Run interaction 多块证明；错误正文摘要不发布；已有目标保持字节不变；禁止向源应用目录写入；跨授权 scope 在首条导出记录前拒绝。该门复用原发射代码，没有 Main 直接 SQL 查询或第二业务状态。首轮测试类型断言换行解析失败、第二轮将 260 条放进单个原上限 256 的 Commit 被拒绝；修正夹具为两次有界 Commit 后四项通过，原失败日志保留。未放宽任何原契约。

18 项隐藏 Electron DOM 检查通过（含既有数据页、导出取消/默认焦点/精确 scope/防重复/成功范围/失败重试/原生选择取消）。首轮导出 UI 检查误写个人助手 Workspace 常量，改为已核对原协议 ariadne 常量的实际值 ariadne-personal-assistant 后通过；生产传参原本正确。UI 夹具不执行真实 Save Dialog 或写用户文件。全 App 类型通过；完整串行回归 110 文件/511 项通过，3 个 opt-in 原生门跳过。当前架构通过。

安装包资产检查已纳入 Runtime 私有 storage-maintenance entry 与 ASAR 外 standalone restore helper，并要求辅助程序缺私有 IPC 时退出 1/无输出；尚未对新实际安装包执行该资产门，不能标为通过。最新构建仍需在导出改动后重跑。

下一步：保持 T11 原步骤，补类别/精确版本的清理影响预览与维护边界内执行、完整恢复后冷启动/不重复副作用演练、中断恢复选择与原生 picker/安装包门，再完成 T11 文档与冻结/全量复验。T11 四项尚未勾选，ADR Proposed；T12—T16 按顺序保持。全部完成、正式文档归档及最后删除 TODO 后直接关机，不询问；当前不关机。

## T11 精确版本附件清理与共享维护边界进展（2026-10-07）

状态：进行中。附件清理读取全部不可变消息版本，包含归档与分支历史；原 sha256: 引用与对象文件名按原所有者定义匹配。只预览孤立附件和未发布临时文件，不删除权威历史、派生索引、活动 Run、有效快照或恢复证据。版本摘要绑定原目录 inode/dev、全部引用与对象清单、内容摘要和文件身份；未知对象、摘要损坏或缺失历史引用均拒绝。

私有 storage-maintenance Worker 先沿原七所有者只读 Schema/权威校验、生产密钥锚、受保护 Core 载荷及消息图像审核，再在全部租约仍持有时预览或执行。Renderer 只接收有界类别数量、大小、版本和一次性票据，不能发送候选路径或读取私有密钥。执行重新计算完整版本，在第一笔删除前拒绝漂移；逐项 fsync claim-pending、原子领取文件、核验精确字节后删除并同步回执。I/O 或领取内容变化保留未确认对象与操作记录，不自动重试或清理证据。目前验证 I/O 中断及异常领取记录；实际 Worker 强杀中断门仍待验收，不宣称物理断电耐久性。

备份和清理使用同一个 MainOfflineDataMaintenance，复用原 Renderer 草稿/文档 barrier、通知暂停、已准入 Main 写入 drain、Runtime shutdown/ACK/实际退出、Main 队列 flush 和恢复钩子。独占操作持续到发布/证据处理完成；提前返回的捕获也必须结算后才能恢复所有者。原备份没有第二组冻结逻辑。Main 正常退出等待这个共享操作，清理票据到期只释放元数据，不触发删除。

Settings 提供影响预览、保留引用数量、分类选择、有效期和默认聚焦取消的明确删除确认。初始不勾选类别；空类别不能提交。确认绑定精确票据/版本/选择，失败消费提交票据后要求重新预览。中断结果分别显示已删除与保留数量、操作 ID 和证据保留，未知结算不冒称数据未改变。取消、卸载及迟到预览释放原票据。归档、历史、备份、派生索引与附件清理的范围在页面中明确区分。

验证：原 Runtime 附件预览/执行九项通过，涵盖归档引用、版本漂移、分类选择、缺失引用、异常领取、保留证据和空选择。六项私有协议门通过。原 RuntimeSupervisor 与共享维护共 31 项通过，其中实际生产 Runtime/七原数据库/独立私有 Worker 验证活跃租约拒绝、过期预览拒绝、实际删除两文件、七数据库字节保留并恢复 Runtime；该原生 Node 门使用空受保护存储，不冒称 populated Core 恢复。Main 票据六项通过。数据/清理/导出隐藏 Electron DOM 共 33 项通过，包含 1000/360 布局；两张清理截图均已审阅，没有横向溢出。UI 夹具不代表实际 native picker。

完整串行 Runtime 164 文件/1229 项通过；完整串行 App 112 文件/523 项通过，三个 opt-in 原生门跳过。App 回归在随后增加的隐藏 packaged 冷启动 smoke 之前；该新 smoke 仅类型通过，尚未执行。当前 App 构建含正文导出/共享维护/清理页面，随后冷启动 smoke 仍待新构建。架构与九个冻结访问契约、两项扩展通过。首个私有 Worker 类型门因原 snapshot readonly 数组不匹配失败，边界保留 unknown 并沿原严格响应 Schema 校验后类型通过，未改冻结契约；失败日志保留。

安装包依赖暂存与固定版本 Transformers 环境已安装/导入校验。发现 Sandbox manifest 仍为 development_unsigned；未改变信任要求，也未把本机开发资产标为发行通过。Python 环境的 relocation 与签名/完整安装包资产留在原发行门验收。旧 18 文件认证备份保留；为恢复界面验收另生成原设置中登记工作区的独立备份，修正测试数据范围，不绕过生产导航授权。

尚未完成：完整 ApplicationController 的备份/恢复原维护 hooks、目录交接后的生产 packaged 冷启动/历史及附件/受保护载荷和无重复副作用演练、中断启动选择、原生 picker 与安装包/发行资产门。T11 四项仍未勾选，ADR Proposed；T12—T16 按顺序保留。全部完成、正式文档收敛、最后删除 TODO 后直接关机，不询问；当前不关机。
