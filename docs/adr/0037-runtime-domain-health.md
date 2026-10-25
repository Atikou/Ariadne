# ADR 0037：Runtime 域级健康与故障隔离

状态：Accepted（T03 的域级故障隔离）。发布签名、系统通知、输入法及其它整改任务仍按各自门槛验收。

## 健康和准入的所有者

AgentEntityHealth 组合实际 execution、conversation、projection、productivity、memory 及 Schedule／Workflow／Goal 三个后台工作器，共八个 Actor 来源；Composed ingress 另组合真实命令 Journal，再由 Application 组合真实 inference 来源，共十个已注册来源。命令依赖从唯一 ownerTable 编译；未知 owner 必须先明确依赖。所有外部和内部工作器派发都经 Actor 准入。工作器失败不会伪装为 Projection 损坏，独立操作不因无关工作器失败被拒绝。推理权威和 transport 分别为 source unavailable 与外部 degraded；文件按实际授权根／文件版本／操作隔离，不造无来源的全局 documents 健康锁。

runtime.health.get 在 ready 阶段先于损坏投影／业务准入及命令 Journal 读取，只提供固定来源、时间、修订、状态、分类和恢复建议，不读取业务正文，也不形成业务收据。Renderer 使用独立单个物理在途读请求与重启代际，状态栏呈现同一安全元数据。不可读显示未知，不把上一次健康数据当成当前健康。关键启动失败由严格 Host initialization_failed 1.0 提供最多一个 owner 证明的故障源，未知异常不标源。Main 仅保留当前启动子进程的报告，在 crashed／disabled 可独立读取；诊断和普通拒绝请求不隐式启动，显式新启动／关闭清理代际。

## 权威源错误

SqliteTransactionOwner 绑定来源。只有 owning decoder 标记的持久化错误及实际 SQLite CORRUPT／NOTADB 证明完整性失败；READONLY／IOERR／FULL／CANTOPEN 为不可用。BUSY／LOCKED、约束、CAS、普通 callback Error／SyntaxError 不按文本或前缀当成损坏。首次异常保留，后续及已经排队的请求被源锁定。ROLLBACK 失败保留两个异常并锁定未知连接，关闭屏障仍可排空。普通提交后丢失响应不误锁，也不自动重做未知操作。

Productivity 启动完整审计数据后，只有明确归属的可选源错误可隔离。失败 opener 必须确认关闭连接与 lease；cleanup 失败、未知错误或竞争 owner 会停止组装。缺席源不谎报已打开 Schema。独立 Conversation／Core／Projection 能继续，坏源原文件保持。execution／conversation／Projection 的关键启动失败已接 owner 来源证明与 Main 独立报告，实际 TEMP 双阶段窗口验收见下文。

LongMemory 的唯一 SQLite owner 同样在重开读事务中核对冻结 Schema 1 布局、SQLite 完整性及逐行原记录／收据／FTS／向量绑定。解码只标记自己的持久记录；输入／CAS 错误不误锁。原记录正文、墓碑、历史回执和物理布局保持。constructor cleanup 失败保留原错误与关闭错误，不被当成成功隔离。

生产 capability 以独立 health service 提供真实 memory 探针，不给冻结 LongMemoryAuthority 增加成员。确认的可选源故障不发布 memory authority 或 memory.manage 能力，保留固定 Tool 文档目录；没有绑定权威的 Tool 明确拒绝。记忆指令贡献只在确认该源故障时省略，未知异常继续抛出。记忆命令依赖 memory／conversation，独立会话不依赖坏记忆源。已打开的存储错误锁定到重启／审计；嵌入模型失败是可用性 degraded，保留实际词法证据。T08 后查询嵌入成功仅清除查询模型故障，仍失败的文档增量任务按实际持久队列保持故障；另一条文档成功不提前解除。实际失败任务恢复、被新版本取代或失效后才清除其任务标记，较新的权威故障永不被模型成功清除。派生索引坏行只重建已验证的派生格式，不修改正文权威。正常词法近似配置不当成存储失败。详见 [ADR 0041](0041-incremental-memory-search-index.md)。

## 同库任务隔离与存储升级

生产 Productivity 使用 Schema 3。它在已有独占 lease 内审计固定 Schema 2、完整原记录与收据、创建并读回 VACUUM 备份，最终事务再次核对源摘要后添加故障表／索引。原记录摘要与布局／完整性核对后才发布 user_version=3。任何中断回滚整批 DDL 和同事务变化；外部源变化保持并拒绝不匹配升级。Schema 3 重开在一个读事务中检查布局、全部业务记录及故障身份。必要的 Schema 1→2 离线维护保留，之后由正常 opener 升级至 3。旧冻结九访问契约、原 database-layout.json Schema 2 基线和旧 JSON／收据不被替换；新物理声明见 runtime/config/productivity-task-isolation-layout-v3.json。

ProductivityTaskIsolationV1、ProductivityTaskRecoveryAuthorityV1 与 ProductivityTaskRecoveryQueryV1 分别冻结在独立扩展声明中。故障绑定 parent owner Session、具体任务 Session、原命令／消息身份、源版本及阶段。元数据包含固定分类、时间、修订和状态，完整摘要及原不可变版本事件可验证。公开故障分页不含 prompt／正文；恢复引用读端只提供原恢复命令身份和修订，不泄露原任务正文。它不改变任务业务结果，也不另建执行 owner。

三个工作器只把类型化任务身份冲突隔离，继续独立任务。共享源及未知异常暂停整个来源。Schedule 的 SQL 在 LIMIT 前排除隔离行，过期 claim 不把隔离的未知尝试写为失败。Worker 派生故障数量映射为 degraded，证据核对完成后才可能恢复该派生状态；更新的源／整个工作器故障仍锁定。

## 受控恢复的边界

内部 ProductivityTaskRecovery 没有 dispatch 能力。开始／结束为短事务，reconciling 仍禁止扫描；核对原创建／fork 指纹、提交收据、消息摘要、Saga、精确 Run 及必要结果，再通过修订和当次源摘要 CAS 放行。证据缺失、不同 Run、恢复期间任务变化或新故障保持隔离，不生成假终态。取消拒绝的活跃 Run 不能仅清除故障后再取消。

公开 productivity.task_faults.query、productivity.task.reconcile 与 productivity.task_recovery.claims.query 经同一 Actor／命令 Journal／Productivity owner 接入实际 IPC 和 Renderer。开始事务在原 productivity_commands 中原子记录 commandId、请求指纹、当次源摘要、恢复阶段与不可变 claim 引用；结束事务通过同一阶段及源／修订 CAS 写完成回执。原恢复 commandId 的重试读取自己的结果；旧恢复被新 claim 超越时完成自己的 superseded 回执，不改新故障。不新增账本、执行 owner 或物理 Schema。

窗口重载看到 reconciling 时，先按父 Session、faultId 和 claimRevision 查询原命令引用，再用原 commandId／expectedRevision 对账。不能根据当前故障修订构造新的恢复意图。历史引用也指向原命令的已完成回执。用户按钮仅请求证据核对；缺失／不匹配仍显示隔离，原任务不会重派。组件覆盖单个在途操作、会话切换丢弃迟到结果、失败重试身份保持、有界分页和任务会话导航。

终态源也核对原身份绑定。执行结果必须同时匹配实际 Run 的状态／版本、Saga 的结果投影和实际结果消息摘要；没有终态证据保持 unknown，不能凭任务结束生成 failed。源码中的实际事务测试覆盖开始／结束 COMMIT 前后故障、关闭重开、丢失回复、并发 claim、源内容变化与原回执重放。真实窗口覆盖已持久化恢复中间状态启动和 Main 重启。另一个真实生产 Runtime／Node IPC 进程在观察到 COMMIT 的 reconciling 后物理强杀，退出后阶段仍保持；重启按原命令完成核对，再次强杀和重放不新增业务副作用。该门槛没有假 Run、预写阶段或测试暂停；不将父进程未观察到 ACK 当成证明管道尚未送出 ACK。

## 推理与文件依赖

ModelCapabilityRegistry 保留原 Schema 1 与布局摘要，在打开发布前逐行验证实际报告及绑定。只有 owner 证明且已确认清理的可选打开失败才省略 Registry；未知／cleanup／lease 错误停止组装。缺席源不发布已打开 Schema，不创建假资格权威。目录保留真实模型但显示不可用及无资格；精确绑定、计数、资格、推理的所有入口检查同一源。唯一 Composed inference latch 同时保护 public 与内部 Worker admission；读取、取消和结果核对不要求可用模型。

Remote gateway 对精确 binding 记录真实 transport 结果并用请求序列防止旧成功清除新失败；只有完整成功响应清除该 binding 的派生失败。实际 Node／Python local process owner 类型化 IPC／退出／load 失败，未知 callback 和取消不凭文本认领来源。LocalModelRuntimeManager 按实际模型保持观察；ping／计数／unload 不清除，完整 generate 成功才清除；移除模型才删除不再适用的记录。禁用模型不参与降级或自动检测。存储源锁定与外部依赖降级分别处理。

文件操作由 ProductionWorkspaceDocumentAuthority 与原 LocalWorkspaceFileService 按授权根、具体文件、版本和操作判定。普通资源拒绝不关闭所有文档；未知写入仍按原命令对账，不清除错误后重写，不给没有真实 owner 的 documents 伪造全局健康来源。

## 验收与限制

2026-10-06 合并验证：Runtime 152／1,155、App 80／336、Root 15／133、类型／App 构建、架构与固定释放契约通过。证据和早期失败保留在 docs/remediation-verification.md 与 artifacts/todo-remediation/。

实际 SQLite 审计／事务／Worker 测试覆盖单任务继续、源拒读、COMMIT／回复丢失、source fence、claim CAS 与恢复原身份。真实双阶段 Electron 源故障门槛：Productivity、Memory、Journal、Execution、Conversation、Projection、可选 qualification Registry；坏源原字节保留、安全 warning 与相应准入验证。记忆不存在的 GGUF 实际加载失败保留词法证据与原 DB；三字节 GGUF 经真实 CPU 加载被拒绝，模型字节保留且合法新增的拒绝资质库完整审计。

外部 transport 门槛 electron-t03-remote-inference-external-native 使用独立 HTTPS 夹具进程，真实 503 降级与同 binding READY SSE 响应恢复、独立会话、DOM warning 消失在 initial／Main restart 均通过。保留 TLS 检查，不写系统证书库，Main 无服务器。runtime-t03-task-recovery-crash 是真实生产 Node IPC Runtime 物理中途终止；electron-t03-task-recovery-pending-resume 是原 durable 阶段在真实 Renderer／Main 的续作，二者范围分别记录。

最终 electron-t03-final-combined-normal 正常链路与 Main 重启通过，70 次确定性 Provider 请求、66 响应、4 取消、原五次 Runtime 强杀、Renderer 重载，fatal=null、Renderer consoleErrors=[]。Main 退出 IPC／通知清理归 T04，真实 Windows 通知／输入法、线上 Provider、用户模型成功推理和安装签名分别保持未验收；本 ADR 不替代 T16。
