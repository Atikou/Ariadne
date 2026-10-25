# ADR 0035：固定边界投影分页与命令结算边界

日期：2026-10-05。

状态：查询、持久化所有者和生产 Renderer 组合已接入；Main 通知已消费最小 Decision 目录分页。UI 消费者和验证夹具迁移仍在实施；大数据桌面与单条过大详情拆分尚未验收，T02 未完成。

## 查询所有权与代际

`AgentProjectionComponent` 是唯一查询命令所有者，`AgentProjectionQueries` 只路由到同一个 `SqlitePublicProjectionStore`。没有新增会话权威、业务写入路径或独立通知状态库。

`projection.snapshot.begin` 固定 `snapshotId`、`streamId`、边界 Cursor／Digest、Scope 和五分钟有效期。进程最多保留 64 个代际的元数据。每次 `projection.snapshot.page` 从现有不可变 `projection_versions` 读取边界 C 以前的最新实体版本，按 Feature 和 Aggregate ID 排序；页游标经过进程私钥 HMAC 校验。每页最多 256 行且不超过 2 MiB。分页不保留跨请求的 SQLite 事务或完整快照对象。

Scope 分为目录、指定工作区／会话、待处理 Decision 和 Run 任务读模型。目录不含消息正文。通知 Scope 的快照只返回 pending Decision；会话 Scope 包含该会话的消息、Run、Decision 和推理流。删除实体保留版本和墓碑，其归属从最后一次非空版本读取。

消费者用 `PublicProjectionPageChain` 验证相同清单、页顺序、跨页实体顺序和页摘要。各页先进入消费者自己的 staging，完整后才能发布；第二页失败不能让第一页替代可见完整状态。过期、恢复后历史边界不同、范围不符和进程重启会明确 reset，重新建立代际。

## 选择性元数据和消息窗口

`projection.view.begin/page` 使用独立的 2.0 只读契约，在同一个代际所有者内固定排序、唯一且属于 Scope 的 Feature 选择。V1 的已发布类型不变；V1 页请求不能访问 V2 代际。会话元数据可只读 Run、Decision 和推理流，消息正文不再随该元数据请求全部返回。

`projection.messages.window` 在同一个 V2 清单的 C 读取最近消息、锚点之前消息或锚点附近消息。每个窗口最多 128 条且整包不超过 2 MiB；返回更早／更晚消息标志和独立摘要。锚点必须是该会话在 C 可见的稳定 Message ID；删除、缺失或其他会话的锚点返回 `anchor_unavailable`。消息按创建时间、角色、二进制 Message ID 排序，协议、SQL 和 Renderer 使用相同的排序，避免相同时间及大小写 ID 的定位差异。

`anchor_unavailable` 必须与请求的 snapshotId 一致，且只能用于包含锚点的请求；最新窗口不能返回该状态。独立 staging 同样执行此验证，不能将错代的迟到响应解释成当前锚点已删除。

`ProjectionScopeStaging` 独立校验元数据页链和窗口；会话只有两者均完整时才可发布。完成的对象深度冻结。`ProjectionScopeRepository` 为每个 Scope＋Feature 选择保存自己的扫描 Cursor／Digest，合并相同 Scope 的并发扫描；无相关变更仍推进水位。相关变更将缓存标为 dirty，完整的新 C staging 才替换其可见正文。扫描失败或迟到扫描不能改变新快照的水位，传输正文不积累在扫描记录中。

Repository 的默认缓存预算为三个会话、八个总条目、24 MiB DTO，单次 staging 不超过 8 MiB，正在读取的 staging 数量也有上限。LRU 淘汰不删除持久历史；选中范围受保护，无法满足预算时拒绝新发布并保留原状态。每个范围和生命周期有独立请求票据，迟到结果被丢弃。不同 Runtime Stream 必须经过显式生命周期失效才可接纳，避免旧请求把缓存切回已离开的 Runtime。以上预算是展示缓存的内存保护，不是数据库容量或旧标量快照阈值的调整。

`RuntimeStore` 已使用 `RendererProjectionRepository`，不再调用全局 snapshot／commits 或将完整 Run 的交互消息再次合并回消息窗口。目录、任务、待确认目录和当前会话各自保存清单、水位和有界缓存；展示对象的标量 Cursor 仅指目录扫描水位，不宣称其他范围已经消费同一位置。当前会话只加载一个 Message 窗口、所需推理流、主 Run／明确打开的 Run，以及有界且明确读取的 Decision 详情。详情批次完整验证后替换，换会话、生命周期变化和明确打开详情均取消旧视图发布。

`projection.features.window` 的独立 1.0 只读契约给 models、diagnostics 和 inference_streams 提供同 C 的至多 128 条／2 MiB 窗口；推理流可按 streaming 或明确 Run ID 集合筛选，避免历史 terminal 流全量进入会话缓存。结果保留 `hasEarlier` 和描述符；不把有界窗口宣称成全部元数据。与 V2 清单同一代际、Scope、Feature 选择和摘要必须匹配。原固定契约不变，新增 `PublicProjectionFeatureWindowQueryStoreV1` 独立冻结基线。

Message 窗口在现有版本历史上合并独立 Message 与 Run 内的交互消息。独立 Message 权威身份优先，包含墓碑，不能由旧 Run 正文复活删除的 Message；派生行验证原 Run 的持久 Payload Digest 和准确身份，不另建消息权威。Run 更新也使对应会话窗口标 dirty。

输入 outbox 结算按同一个 Run、Session、inputId 和 delivery 核对已验证的 Inbox；当前窗口缺席不能证明接受。跨会话未结算输入用一个新任务清单按明确 ID 逐个读取证明，不缓存这些 Run 正文，也不为每条记录创建新的代际。Decision 结算同样读指定 ID 的新 C 详情，包括 terminal 状态，而非用目录缺席推断。

## 最小目录与显式详情

`projection.catalog.begin/page/detail/read` 使用独立的 3.0 只读契约。目录、任务和决策均由同一 `SqliteProjectionSnapshotReader` 管理代际，V1、V2、V3 合计最多 64 个、有效期五分钟；没有新增跨 IPC 的读事务、全量正文缓存或业务状态所有者。

目录选择绑定 Scope、单一 Feature 和合法状态过滤。Session 返回会话摘要；Run 只返回身份、状态、时间、进度和工具／Inbox／交互消息数量；Decision 只返回公开标题、引用、类型、状态、版本和时间。Run 的完整 Inbox／工具活动／交互消息、Decision 的问题和选项、批准令牌不进入总览。需要这些内容时，详情接口按同一代际的实体 ID 和 Scope 显式读取。详情不受总览的状态过滤限制，允许在同一范围内核查已结算实体，但不能跨工作区或会话。

每页返回固定 C 的总数、状态数量和 Decision 类型数量；这些统计描述整个所选范围，而非当前可见页。页摘要和 `PublicProjectionCatalogPageChain` 校验同代际、页序、跨页排序、统计一致性及完整结束数量。Session 按置顶、更新时间降序、二进制 ID 排序；Run 按活跃状态优先、更新时间降序、ID 排序；Decision 按待处理优先、请求时间降序、ID 排序。页游标继续使用该进程的 HMAC，不能用于其他代际。

目录增量扫描保留所有连续全局 Cursor，只传递该目录的摘要更新或 remove。删除、关闭 Decision 和退出当前状态过滤都会 remove，不能误留在 pending／active 列表。目录自己的完整信封也受 2 MiB 限制；即使原 Scope 批次可容纳，目录信封超限时仍从实际最后返回 Cursor 续读，不能跳过最后一项。

Main `DecisionNotificationSource` 已只消费 V3 pending Decision 摘要。它验证完整分页集合后发布，正文和 Action token 不进入 Main 通知读取响应；点击仍由精确 Decision 重新核对。持久通知去重和实际 Windows 生命周期验收尚未完成。

`ProjectionCatalogRepository` 每个选择只保留一个当前页，默认八个选择、4 MiB 总量、2 MiB 单页和四个物理在途请求。淘汰保护选中范围；失效后仍统计尚未结束的请求，防止迟到 staging 越过预算。页深度冻结，相同选择和生命周期的票据拒绝迟到发布；新 Runtime Stream 需要显式失效。前进使用已接受页链的 fork，验证或预算失败不改变原链，允许重试；回退在同一 C 重读并验证前面的页，逐页丢弃而不累积正文。目前回退的查询开销会随页号增长，仍需性能优化。

各目录有独立扫描 Cursor／Digest。无关提交推进水位；相关更新标记 dirty，完整新 C 才替换可见页和统计。导航和扫描合并重复请求，旧导航、旧扫描、reset、摘要错误或预算失败都保留最后可信页。生产组合已接入；读取租约 reset 保留最后可信展示与本地覆盖层，实际 Stream 变化才递增展示 resetEpoch。完整性失败取消在途发布，并锁定详情导航，刷新不能静默清除。Node 集成仍不代替真实桌面验收。

## 连续作用域扫描

`projection.scope.read` 读取 C 之后的有界日志批次。每个被扫描的全局 Cursor 都返回一个条目，即使其 `changes` 为空，因此无相关事件也能推进订阅水位。实体正文只来自订阅范围；更新、关闭 Decision 和删除墓碑也必须返回，不能按 pending 状态过滤增量而遗漏结算。

Runtime 先验证原始 Commit、持久 Payload Digest 和连续 History Digest，再过滤所属范围。条目包含原始 Payload Digest 与 History Digest；客户端验证连续全局链和整个过滤批次的摘要。范围过滤由可信 Runtime 所有者完成；原始 Commit 的平面摘要不是部分实体的 Merkle 证明。批次摘要用于检查传输和 staging 内容漂移，不能作为客户端自行修改数据的授权。

传输批次不超过 2 MiB。内部日志读取仍使用原有的最多 8 MiB 有界批次；若过滤后的结果遇到传输上限，返回实际最后扫描 Cursor，下一请求继续读取剩余提交。不会将原批次末尾误作已消费水位。

## 写入和启动校验

追加只检查当前 Commit、Source Cursor、每个受影响实体的现有 Head／历史最新版本，以及事务内版本和摘要约束，不再构建全应用快照。总历史大小不会导致写入回滚。

启动审计逐个读取 Commit 及其版本，校验全局链、来源顺序、每项变更的持久工件、连续实体版本、最新 Head 和 Source Checkpoint。内存不保存所有历史 DTO 的 Map；SQL 索引提供前驱和最新版本定位。全局数量检查仍检测缺失工件、Head 和 Checkpoint。分页每行也验证持久摘要，不能绕过完整性检查。

启动审计复用固定 SQL 语句集合，不能随每个 Head／Source 重复编译查询。Head 与最新版本的全部九个持久字段直接精确比较，已 canonical 的 `dto_json` 不再为比较而重复转义／复制；之后仍逐项验证 Schema、安全载荷和原摘要。实际 257 个 Head 的审计编译不超过 16 个语句，原损坏检查保持。仅容量 smoke 可以从同一生产启动路径记录最多 128 个固定阶段点及数字内存／耗时；它不改变握手时限、重放策略或完整性准入。10,000 消息的实际阶段证据表明审计和重放是主要启动开销，详见正式验证记录；减少语句编译不等于启动内存问题已解决。

持久版本行直接验证 Change Schema、安全载荷、字节约束和原持久摘要。不得为该行制造带较长虚拟事件 ID 的 Commit 后再验证；该虚拟包会误拒绝接近 1 MiB 上限的合法原始提交。合法原始 Commit、分页和重启审计使用同一实体内容，包上限没有提高。

原标量 `projection.snapshot.get` ABI 和 8 MiB 上限保留。过大的标量读取先检查字节量并拒绝分配全部正文；生产消费者必须迁移到分页，不能靠提高此上限解决容量问题。

当前不压缩 Commit、版本或墓碑，也不删除权威会话历史。此保守保留政策确保所有未过期快照与重放请求仍可读取。后续压缩必须先提供有效代际与客户端扫描水位，只有所有使用者都越过回收点后才能回收派生版本；未知旧边界必须 reset。尚未实现的回收不能宣传为容量优化。

## 版本化持久边界

新增公共结果暴露了 V1 命令 Journal 接口把所有业务 DTO 当成持久化 ABI 的耦合。保留原 V1 已发布结果集合和九个固定契约基线，不更新它们以掩盖漂移。生产改用 `RuntimeCommandJournalV2`：持久化边界接收中性的未知结算对象，SQLite Adapter 按当前公共 Response Schema 校验写入，Ingress 在每次 replay 前再次校验。

物理 Journal Schema、命令身份、重试 Digest、未知结果恢复证明和敏感结果保留规则没有因此改变。V2 不会将新查询结果自动变成可持久重放的正文缓存。

`PublicProjectionPagedQueryStoreV1`、`PublicProjectionScopedQueryStoreV1`、`PublicProjectionViewQueryStoreV2`、`PublicProjectionCatalogQueryStoreV3` 和 `PublicProjectionFeatureWindowQueryStoreV1` 是独立只读边界。新基线分别保存在 `persistence-extension-contracts-v1.json`、`persistence-scoped-read-contract-v1.json`、`persistence-projection-view-contract-v2.json`、`persistence-projection-catalog-contract-v3.json` 和 `persistence-feature-window-contract-v1.json`，与既有九个固定契约一起检查。Journal V2 及五个只读接口合计六个扩展契约。已初始化的基线不得覆写；未来改变这些读模型需显式增加版本化契约。

## 验证与未完成范围

单个 Run 超过 DTO／提交限制的分块表示见 [ADR 0036](0036-multipart-run-projection.md)。基础读模型已验证，事务存储、升级和生产消费仍未接入，目录与窗口验收不能替代那一项。

实际 Headless NDJSON 验证分页和作用域扫描经真实命令所有者返回。根项目跨工作区测试验证 Main staging、Renderer 客户端解析与该查询所有者；Runtime 单元测试继续保持工作区隔离。数据库测试包含混代、乱序、重复、丢页、字节截断、摘要漂移、过期、旧流与重启。

`node scripts/benchmarks/projection-capacity.mjs` 创建独立临时数据：100 个会话、10,000 条消息和超过 64 MiB 的展示 DTO，记录追加 SQL、返回行数、延迟、内存、固定边界并发写入与重启。该基准验证存储／查询，不代替 Renderer 会话切换、消息窗口、搜索定位或大规模真实 UI 验收。

`node node_modules/tsx/dist/cli.mjs scripts/benchmarks/projection-scope-cache.mts` 复用经路径和数据库身份检查的同一 TEMP 夹具，验证 Renderer Repository 的 24 次会话窗口加载、有界淘汰、淘汰后的锚点定位、无变更水位扫描和 Runtime Store 重开。它在 Node 中运行当前 Renderer 模块，没有真实 Electron DOM／渲染耗时结论。

`node scripts/benchmarks/projection-catalog-capacity.mjs` 创建独立临时库，包含 100 个会话、512 个有大段交互消息的 Run。验证固定 C 摘要目录、显式详情、结算 remove 和重开；`node node_modules/tsx/dist/cli.mjs scripts/benchmarks/projection-catalog-cache.mts` 在经 TEMP 路径和数据库来源检查的同一夹具上验证一页缓存、前进／回退、无变更扫描和重开。早期 JSON 统计／排序约 500 ms；后续有界元数据扫描结果见下节。以上 Node 基准不代替 Electron 窗口验收。

## 目录元数据查询与物理布局

`SqliteProjectionCatalogMetadataCache` 只保存由已校验不可变版本剥离的目录摘要、完整持久 Header 绑定和大小；最多 4 MiB／4,096 项。缓存不保存 Run Inbox、interactionMessages、工具正文、用户问题或批准 Token。启动流式完整性审计通过的当前 Head 和成功提交之后的版本可以进入缓存；失败事务不发布。淘汰后按精确版本重新读取与校验，不改变持久历史、快照 C 或物理 Schema。

目录查询流式扫描同 C 的最新持久 Header，以已验证摘要统计、判定所有权并维护最多 `limit+1` 行／2 MiB 的有序候选集合；不会组装全目录数组。临时工作区所有权 memo 最多 128 项。缓存命中仍逐项核对 Header；查询前后核对连接的 SQLite `data_version`，检测独占所有者之外的写入立即触发持久完整性拒绝，避免返回旧摘要。显式详情继续校验完整正文，启动仍完整审计所有工件。

该优化未增加表／索引或修改固定物理布局与九个访问契约。512 个大正文 Run 基准的热页约 39—43 ms，摘要缓存约 272 KiB，完整 DTO 缓存未增加。超过缓存范围的冷查询会产生按版本校验的 miss，仍有全范围 Header 扫描成本；不能承诺所有规模都保持该延迟。具体证据见 [整改验证记录](../remediation-verification.md)。

`npm run test:electron-capacity` 另经当前会话和消息权威生成超过 64 MiB 的 10,000 条消息，然后实际操作生产 Electron 目录、历史窗口、目录外搜索锚点和 24 次切换。在持续写入时验证固定 C，强杀 Runtime／Main 后重开。仅记录请求元数据、DOM 数量、JS heap 与实际进程工作集，不保留额外正文缓存。此验收发现并消除观测适配器启动时的标量全历史读取，改为最多 512 个经持久摘要校验的观察诊断 Head。具体数据与仍未完成的查询开销、Runtime 启动内存、详情拆分、更多窗 UI 和回收策略见 [整改验证记录](../remediation-verification.md)。通过窗口验收不改变上述保留政策。
