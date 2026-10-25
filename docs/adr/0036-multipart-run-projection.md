# ADR 0036：Run 的不可变分块表示

状态：当前 T02 范围已验收。正常 Schema 4、唯一文档 6.0 Publisher、固定 C 分页与显式正文、精确 Inbox ACK、超大 Core/COMMIT/ACK 强杀、最终超大 Electron/Renderer/Main 恢复与原容量三阶段通过。启动前有界未发布准备回收保留全部已发布历史；内部不可变提交仅校验一次，Runtime 143/1,053 与根集成 15/133 通过，容量首次 UI 6.36s、Main 6.44s。缓存未受控的物理等待根因及最坏启动时间不作已解决承诺，T16 再验最终构建。整仓工具链／干净构建／签名、故障隔离和其它 TODO 仍未完成。

## 问题与边界

`PublicRunProjection` 的 Inbox、interactionMessages 和 toolActivities 位于一个 DTO，Commit 限制为 1 MiB，既有 Message DTO 正文限制为 100,000 字符。Core Inbox 可有 1,000 项，受保护交互解析器允许单项 1,048,576 字符。合法领域数据可能在提交或 DTO 校验前失败；全应用分页不能独自解决。

旧 DTO、5.0 Commit 和九个固定持久契约保持原义和上限。不能用空数组或截短正文冒充完整详情。新表示进入同一 Projection 所有者和权威 Outbox，不建立第二套运行状态或业务库。

## 已实现的表示

document 1.0 根包含真实 Run 摘要和三个集合的 itemCount、leafCount、Merkle root；根有域分离摘要。叶描述符绑定 Run ID／版本、集合、逻辑项 ID／序号、完整项字节数／摘要、块序号／覆盖字节数、块摘要及集合内叶位置。Merkle 路径绑定完整集合；奇数末节点按规范复制，缺节点或额外节点拒绝。

canonical UTF-8 项分成最多 256 KiB 原始字节的块，IPC 使用 canonical Base64，每叶整包最多 512 KiB。分割可以落在 UTF-8 字符内部，只有完整连续项才解码。单项受 8 MiB 分配保护，新交互字段保留原解析器的 1 MiB 字符边界；旧 DTO 未改。Tool／Inbox 沿用原安全 Schema。写端编码前、读端恢复后都校验明文 Schema、安全载荷和归属，编码不能逃过凭据／路径检查。

`RunDocumentPlan` 保留当前 Run 的项身份、字节量和 Merkle 哈希，不复制完整正文作为分块缓存；逐项再生成叶，数组长度、内容或摘要元数据变化拒绝。准备索引元数据仍随这一 Run 的项／块数增长，尚未声称生产索引恒定内存。`RunDocumentItemAssembler` 只组装一个明确请求的项，未读齐不得呈现半个 JSON，没有完整 Run 拼接器。

叶还绑定独立 `itemMetadataDigest`，元数据证明核对同一 Merkle 路径和公开 Schema。Inbox 的 ID／版本／delivery／state／source 可以不读取 content 就被精确验证；交互元数据继续校验引用、归属与时间，不能把无正文的 metadata 当成完整 Message DTO。组装完整项后再次核对从正文派生的元数据摘要，目录与完整项不能分别漂移。

`projectAgentRunV3` 和 `projectAgentRunDocumentV1` 使用同一 Core 校验、公开映射、脱敏、稳定身份和时间语义。旧表示仍严格拒绝超出旧 Schema 的内容；新表示可以准备更长交互。生产 Publisher 仍调用旧表示，未暗中启用新发布链。

## 候选 SQLite 准备区

`RunDocumentDbSchema` 仅对调用者已经持有 Projection 所有权的连接提供 3 → 4 候选升级。生产打开器仍是 Schema 3，固定布局清单未改。升级在同一 `BEGIN IMMEDIATE` 中先校验当前 Schema 与完整历史，再增加 documents／items／leaves 三张表、迁移记录和 user_version；错误一起回滚。既有五类历史表与 3 版迁移记录不改写。

`SqliteRunDocumentPreparation` 在同一库中保存根、无正文项元数据、叶描述符／Merkle 路径和最多 256 KiB 的 BLOB。一个完整项完成 Schema、明文安全与证明校验后才在短事务内持久化；重试核对同一 Run／版本／根和每个已存在项／叶的精确内容，不覆盖冲突。preparing／prepared 仅表示准备状态，准备器不会推进 Commit、版本、Source 水位或 ACK。候选表的 nullable `published_cursor` 由最终事务单独设置，外键绑定原提交链。准备期间外部 SQLite 提交由 data_version 拒绝，包括只改正文、不改哈希字段的写入。

显式读取重新核对根、项元数据、索引与叶证明；范围外返回空，已声明覆盖内缺项／缺块按不完整存储拒绝，不能把损坏解释成不存在。读取 Inbox 身份证明不选择 BLOB。准备仍可保留一个最多 8 MiB 项及其编码／校验缓冲，不声称恒定总 heap 或生产所有消费者已迁移。

八项实际 SQLite 测试验证三提交／三版本／墓碑与水位原样保留、恢复 Schema 3 副本后由原生产 Store 重开、迁移回滚、中断后重开续写、重复无新副作用、篡改、索引漂移、缺覆盖和外部写入拒绝。基准 `t02-run-document-sqlite-fence.json` 独立候选库保存 6,003,812 字节模拟源，27 叶／18 项完整恢复，最大叶 350,381、BLOB 262,144 字节；准备持久化／验证约 429.9 ms，读取／恢复约 859.3 ms。它只有异常注入与关闭重开，没有进程强杀、Core 权威写入、最终公开提交、IPC、模型或窗口验收；恢复副本与库均保留在具名 TEMP 目录。

## 候选最终事务与双表示审计

独立 Commit 6.0 第一项是真实 Run 文档根，Source cursor 与 Run 版本、时间一致；其余项只允许同一 Run／Session 的 Decision，禁止重复实体。旧 5.0 Commit 及完整 DTO 未改，Commit 字节界仍为 1 MiB。

`SqlitePublicProjectionStore` 的普通 append 和候选 `SqliteRunDocumentPublication` 共用同一个最终事务函数，借用唯一所有者的连接，不再复制普通提交事务。文档先完整验证所有项／正文／元数据／索引／Merkle，data_version 拒绝验证与事务之间或后续版本之前的外部写入。短最终事务一起写 Commit、Run／Decision 版本和 Head、Source checkpoint 以及 published_cursor；回滚全部可见产物，准备块保留重试。提交后响应丢失重用原 cursor，不增加版本。原 5.0 未 ACK 事件必须从完整旧 DTO 派生出完全相同的新根、相同 Decision 与事件字段，才返回原提交；原字节、摘要、C 和水位不改写，也不把派生准备根伪装成新 6.0 发布。

完整历史审计识别 5.0／6.0，在验证全局链、版本、Head、Source 的同时，逐项验证每个已发布文档的正文与 publication link，最多组装一个 8 MiB 项。浏览器异步 SHA 与 Node 同步 SHA 驱动同一验证步骤，没有第二套 Merkle／解码安全算法。旧 scalar read 遇到 6.0 明确 reset；旧 snapshot／详情无法表示文档时明确升级错误，不返回空数组或把不支持标记为存储损坏。实际 Store 测试证明该错误后模型 Head 与 Source 读取仍可用；其他生产消费者仍待迁移。

九项文档发布测试与四项协议测试覆盖原子 Run＋Decision、提交前／后故障、同事件重试、5.0→6.0 等价重放、漂移／Source gap、正文全审计、跨版本外部写入与旧读取边界。`t02-run-document-publication.json` 在具名独立 Windows TEMP 候选库对两个真实 Node worker 分别在 COMMIT 前／后 SIGKILL：重开为零／一个可见提交，重试都保持 C=1，再写版本 2，旧已发布正文仍完整可读。模拟源 6,003,818 字节，最大叶 350,381 字节；没有 Core 权威写入、Outbox ACK、Runtime/Main、公开 fixed-C manifest、模型或窗口验收。

## 后续生产接线要求

message-metadata-query 1.0 使用同一精确 Session／all Run Catalog manifest，将独立 Message、当前 5.0 Run 内交互和已发布 6.0 文档交互合并为最多 128 条／2 MiB 元数据窗口。latest／before／around 保留时间、角色、二进制 ID 排序、已证明锚点和前后覆盖标记；请求与否定结果都绑定原 manifest／窗口。只要独立 Message 在 C 前曾出现，它就拥有该消息身份；最新墓碑或其他 Session 归属会隐藏文档副本，不能比较数值版本后复活副本。不同有效 Run 的同 ID 交互没有独立 Message 权威时按歧义拒绝，不任意选一个父 Run。

独立 Message 的正文引用由同一 SnapshotReader 签名，绑定 C／摘要、Session、Message／版本、原 Commit、原 change digest、projectedAt 和元数据摘要；显式 body 读取恢复原小 DTO，客户端同时验证正文派生元数据、原完整 change digest 和包摘要。文档交互返回根／引用及项元数据证明，正文使用既有单块接口及单项组装器；一条超 100,000 字符交互不被塞回旧 Message Schema。SQL 在排序及返回前剥离正文，新文档候选不选择 BLOB；仅所选旧 Run 可在这次请求内保留最多四个受原 1 MiB Commit 上限保护的父文档。窗口完成后不保留父文档缓存，不声称 SQLite 排序、全历史启动审计或整机内存问题已解决。

准备未发布或墓碑父 Run 不进入新窗口；文档声明的索引覆盖／publication link 不完整时，即使是空窗或找不到锚点也拒绝。所选项证明失败按持久化损坏锁存，不能变为空结果。读前后 data_version 仍拒绝外部正文修改。生产 Schema 3 可读取当前 5.0 历史，不新增表或改历史；候选 Schema 4 才使用文档元数据索引。旧正文窗口遇到所选 Session 的非空 6.0 根明确 contract_mismatch，不静默漏掉交互，也不把契约升级误判为损坏；模型 Head 读取仍可用。新消息端口与文档端口尚未冻结／加入公共命令，旧九固定加六扩展基线不改。

候选 document-query 1.0 在现有 Catalog 快照租约上提供文档根、连续元数据页、精确 Inbox 与单个正文块，借用同一所有者连接及 data_version 围栏，不建立另一组代际或正文缓存。仅允许 Session 范围的未过滤 Run manifest；根绑定所选 C 下的 Run 版本、publication link 与 documentDigest。正文与页游标由当前 SnapshotReader 签名，绑定快照、C／摘要、Run／版本／文档摘要及集合续页位置。跨快照、跨 Session、版本漂移、伪造或过期游标明确 reset；新版本或 Session 工作区变更不改变旧 C 的结果。

元数据页最多 128 行、整包最多 2 MiB，证明只选择元数据／描述符／Merkle 路径，不选择正文 BLOB；完整页链验证连续覆盖，不能把未加载项解释为缺失。精确 Inbox 返回身份、版本、delivery、state、source 证明；只读请求不得将无正文项伪装成完整 DTO。正文查询只选择一个至多 256 KiB 原始块，已声明范围内缺块拒绝，范围外明确 item_unavailable。客户端在 Schema、请求绑定、根／证明及整包摘要校验后使用结果；否定结果也核对原请求身份。

当前系统已发布的 5.0 小 Run 在所选 C 从原完整 DTO 派生同一文档；旧交互可选 runId 缺省时由明确父 Run 归属推导，已经提供的其他 Run 归属仍拒绝。派生只在这次请求内保留，受原 1 MiB Commit 边界保护，不写准备表、升级 Schema 或改历史。6.0 根的 Catalog 摘要可在现有 metadata cache 中读取，缓存仍保持 4 MiB／4,096 项；Catalog 增量直接扫描同一 5.0／6.0 原提交链的摘要，消息窗口／文档公共命令／Renderer 尚未迁移。新查询端口仍是未冻结候选，九固定加六个既有扩展基线不改。

`SqliteProjectionCatalogCommitReader` 替换目录原“完整标量读取 → 范围过滤 → 再剥离 DTO”的路径。每次固定当前 C，仅保留最多请求数（不超过 256）和 2 MiB 的目录项；流式解析一个受原 1 MiB Commit 界限保护的原提交，6.0 根不加载文档块。返回原 payloadDigest／cursorDigest／Source／事件与全部连续位置，包括没有本目录变更的提交。目录协议是独立摘要格式，不能将原 6.0 提交伪称为 5.0；客户端用原 payloadDigest 验证相同历史链。标量旧接口遇到 6.0 的 reset 仍保留。

当前实体属于目录时返回符合选择条件的真实摘要；转出原 Session／工作区／过滤条件或出现墓碑时向原目录发出 remove，完全无关的所有者不泄露摘要。旧归属由有界元数据缓存读取不可变前版本。Session 工作区迁移／删除／恢复会改变未同时更新的所有 Run／Decision 成员，这类依赖目录明确 scope_mismatch，重取快照；恢复判断读取直接前版本的墓碑，不能借更早的非空版本把恢复误判成“归属未变”。目录 Session 本身移出工作区仍返回单实体 remove；全局无工作区的任务目录继续推进。读前后外部写围栏、游标／摘要／连续性及原历史链接全部验证，目录与标量／审计共用同一链接校验函数。

1. 七个公共查询及其唯一 owner／校验客户端已接通，继续接生产 Publisher／Outbox ACK 与所有页面读端，再接入当前 Projection 的正常 Schema 升级流程，明确双版本迁移账本和完整启动审计。候选最终事务及独立副本已验证，但不代表生产 Schema 已激活；在生产升级与故障验收完成前不改固定布局清单。
2. 分块准备与最终可见提交分离。内容和索引验证成功后，同一最终事务推进 Run 版本、Source 水位、全局 C 和文档根；部分写入、崩溃或重试不能让半个新 Run 可见。Outbox ACK 在持久提交之后。新 Commit 显式版本化，不把摘要塞入旧完整 Run Schema。
3. 文档查询固定于既有 C、Run 版本与 documentDigest，提供集合窗口、精确 Inbox 项和交互项。每页行数／字节双界，单项连续可验证。旧 DTO 可以在同 C 下派生同一表示；原记录、摘要、事件身份保留，重复 Outbox 不得产生新副作用／新版本。
4. 目录、通知、统计只消费摘要。Renderer 明确部分范围和覆盖，未加载项不能当作不存在；结算必须核对 Inbox ID／版本／delivery／source。消息窗口、附近定位、工具活动和详情各接新查询并保持缓存限额。
5. 旧接口无法表示新数据时明确升级／reset，不能归为存储损坏，也不能用空数组通过旧 Schema。重建、旧游标失效与保留水位配套实现。

## 当前证据

Runtime 132 文件／966 项、协议 10 文件／74 项和根实际 SQLite 集成十文件／87 项通过。新表示五项加同一 Core 映射的相关 22 项验证完整恢复、变更、块序／重复／缺块、字节／Merkle 篡改、归属／版本、空集合、Inbox 精确计数，以及恶意发送端重算摘要后仍无法绕过安全校验。

Node 模拟基准 `artifacts/todo-remediation/t02-run-document-plan.json`：源 6,003,812 字节、根 845 字节、17 个 Inbox 加一条约 2.6 MB 交互正文，共 27 叶，最大叶 350,286 字节，18 项完整恢复；准备约 26.9 ms，逐项恢复约 433.4 ms，采样不是连续峰值。此基准没有 Core 权威写入、SQLite、IPC、模型或窗口验收，不代表生产超大实体通过。正式范围见[整改验证记录](../remediation-verification.md)。

补齐元数据证明后的最新检查为 Runtime 967 项、相关 23 项、协议 74 项、SQLite 集成 87 项。独立新 JSON `t02-run-document-plan-metadata.json` 保留旧基准：最大叶 350,381 字节，准备约 27.2 ms、恢复约 485.7 ms，27 叶／18 项仍完整恢复；规模、根大小及验收范围不变。

候选 SQLite 准备区与外部写入边界的最新相关检查为三文件／31 项，根实际 SQLite 集成仍为十文件／87 项；Runtime 构建、架构、Runtime 独立性与九固定加六扩展契约通过。App 此前完整构建已包含 node／web／tests 三项类型检查，未将其计为新分块窗口验收。

固定 C 查询阶段最新验证：Runtime 135 文件／991 项、协议 12 文件／81 项、相关六文件／47 项、App 76 文件／318 项、根实际 SQLite 集成十文件／87 项与类型／Runtime 构建通过；架构、独立性 746 文件及九固定加六扩展守卫通过。七项实际 Store 查询验证多块旧正文完整恢复、后续 Run／Session 变更下旧 C 不变、140 Inbox 分页与完整页链、metadata SQL 不选择 BLOB、精确 source、篡改／重算包摘要后仍拒绝、跨 Session／快照／集合、TTL、缺块、未发布准备不可见、外部正文修改及 Schema 3 原历史保留。协议三项独立验证根摘要、否定结果身份和空集合完成。证据使用 `artifacts/todo-remediation/t02-run-document-query-*`；没有新 Runtime IPC、Provider、Main 强杀或窗口验收，不覆盖上一阶段 Node 强杀的范围。

目录增量阶段最新 Runtime 136 文件／998 项、App 76／318、根实际 SQLite 集成十／87、Runtime 构建／类型、架构、独立性 747 文件与九固定加六扩展守卫通过。新增七项 Store 测试涵盖 5.0／6.0 混合原摘要、连续无关位置／分页／过滤移除、多兆存储正文不读块／不进入响应、Run／Decision Session 转移、工作区迁移／删除后同工作区恢复重取依赖目录、原文档墓碑、游标差异、外部正文写入与共用历史链损坏锁存。证据为 `artifacts/todo-remediation/t02-document-catalog-*`；协议与 App 接口没有改动，保留上一阶段协议 81 项及应用类型／构建证据，不将 Store 测试计为新 Runtime IPC 或真实 UI 验收。

合并消息阶段最新 Runtime 137 文件／1,008 项、协议 13／85、相关五文件／42 项、App 76／318、根实际 SQLite 集成十／87、Protocol／Runtime／App 构建、应用三项类型、架构、独立性 751 文件与九固定加六扩展守卫通过。新增十项 Store 与四项协议验证 140 交互窗口／旧 C／独立 Message 版本及墓碑／跨 Session 隐藏、排序和空边界／原 change digest／重算包摘要后的证明或正文漂移拒绝、跨快照引用／TTL／外部正文写入、旧 5.0 无写入派生／缺覆盖／坏证明／重复身份。一条 900,000 个 UTF-16 单元、1,080,000 字节纯正文的模拟交互通过单块完整恢复，窗口及元数据 SQL 不读取 BLOB；证据位于 `artifacts/todo-remediation/t02-message-metadata-*`。没有新 Runtime IPC、Core 权威 ACK、真实模型、Main 强杀或新窗口验收。

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
