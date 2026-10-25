import { readFile, writeFile } from 'node:fs/promises';
const heading = '## T11 授权会话正文导出进展（2026-10-07）';
const progress = `${heading}

状态：进行中。会话侧栏菜单新增“导出会话正文”，先明确 JSON Lines 从新到旧、正文与图像引用范围、排除图像字节/工具详情/推理过程/私有执行载荷/系统凭据，且正文导出不能用于应用数据恢复。确认默认聚焦取消，Main 原生 Save Dialog 选择新文件；Renderer 仅发送严格 Session/Workspace/scope/format，不能指定源文件或目标路径。

Main 沿原授权 Public Projection Session Catalog 固定 C 获取消息元数据页，再读取原 Body Reference 或逐块验证并组装单个 Run interaction。完整 Message/Metadata/Chunk/Merkle/顺序证明仍由原协议验证器核验；拒绝跨 scope、失效快照、摘要损坏和空页继续。逐条流式写出，不缓存整个 Session/Run；最多 100,000 条/512 MiB，超限整次失败，不发布截断文件。发布前同步私有同目录临时文件，用 exclusive hard link 生成新目标；现有或并发生成的目标不会覆盖，不支持硬链接的文件系统明确失败。失败只清理确切 inode/dev 的本操作暂存；Main 退出等待正在进行的导出。

四项原已发射 SQLite/RunDocumentPlan 集成门通过：260 条跨页正文，导出过程中原消息更新/新增仍读取原 C；外国 Session 排除；1.2 MB 中文 Run interaction 多块证明；错误正文摘要不发布；已有目标保持字节不变；禁止向源应用目录写入；跨授权 scope 在首条导出记录前拒绝。该门复用原发射代码，没有 Main 直接 SQL 查询或第二业务状态。首轮测试类型断言换行解析失败、第二轮将 260 条放进单个原上限 256 的 Commit 被拒绝；修正夹具为两次有界 Commit 后四项通过，原失败日志保留。未放宽任何原契约。

18 项隐藏 Electron DOM 检查通过（含既有数据页、导出取消/默认焦点/精确 scope/防重复/成功范围/失败重试/原生选择取消）。首轮导出 UI 检查误写个人助手 Workspace 常量，改为已核对原协议 ariadne 常量的实际值 ariadne-personal-assistant 后通过；生产传参原本正确。UI 夹具不执行真实 Save Dialog 或写用户文件。全 App 类型通过；完整串行回归 110 文件/511 项通过，3 个 opt-in 原生门跳过。当前架构通过。

安装包资产检查已纳入 Runtime 私有 storage-maintenance entry 与 ASAR 外 standalone restore helper，并要求辅助程序缺私有 IPC 时退出 1/无输出；尚未对新实际安装包执行该资产门，不能标为通过。最新构建仍需在导出改动后重跑。

下一步：保持 T11 原步骤，补类别/精确版本的清理影响预览与维护边界内执行、完整恢复后冷启动/不重复副作用演练、中断恢复选择与原生 picker/安装包门，再完成 T11 文档与冻结/全量复验。T11 四项尚未勾选，ADR Proposed；T12—T16 按顺序保持。全部完成、正式文档归档及最后删除 TODO 后直接关机，不询问；当前不关机。
`;
for (const file of ['TODO.md', 'docs/remediation-verification.md']) {
  const previous = await readFile(file, 'utf8'); if (previous.includes(heading)) throw new Error('Text export progress already recorded.');
}
const matrixPath = 'docs/verification-matrix.json', matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
const row = matrix.rows.find(item => item.module === 'same-machine-backup-and-recovery');
if (!row) throw new Error('Backup matrix row missing.');
for (const source of ['app/src/main/data-management/session-text-export.ts', 'app/src/main/data-management/session-export-service.ts',
  'app/src/renderer/src/modules/chat/ConversationSidebar.tsx', 'scripts/verify-packaged-runtime-assets.mjs']) if (!row.source.includes(source)) row.source.push(source);
for (const name of ['t11-public-session-export-current-owner-tests.log', 't11-session-export-renderer-ui-corrected-tests.log',
  't11-complete-text-export-ui-types.log', 't11-usage-text-export-full-app-serial-tests.log', 't11-session-export-architecture.log',
  't11-native-awaited-lease-root-switch-tests.log', 't11-native-awaited-lease-root-switch.json', 't11-owned-usage-architecture.log']) {
  const file = 'artifacts/todo-remediation/' + name; if (!row.evidence.includes(file)) row.evidence.push(file);
}
row.notes += ' Text-only authorized same-C Session JSONL export is now implemented with explicit attachment-reference/private-data exclusions and exclusive new-file publication. Original emitted SQLite/RunDocumentPlan export tests 4 pass; hidden data/export DOM 18 pass; current App types and full serial 110 files/511 tests pass (3 opt-in native skips). Native current standalone helper/root-switch rerun passes and usage architecture passes. Cleanup/full restored Application cold start/native UI/package acceptance remain unfinished.';
matrix.generatedAt = '2026-10-07';
await writeFile(matrixPath, JSON.stringify(matrix, null, 2) + '\n');
await writeFile('artifacts/todo-remediation/t11-text-export-progress.md', progress);
for (const file of ['TODO.md', 'docs/remediation-verification.md']) await writeFile(file, (await readFile(file, 'utf8')).trimEnd() + '\n\n' + progress);
process.stdout.write('T11 text export progress recorded; overall task remains incomplete.\n');
