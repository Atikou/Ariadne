import { readFile, writeFile } from 'node:fs/promises';
const heading = '## T11 精确版本附件清理与共享维护边界进展（2026-10-07）';
const progress = `${heading}

状态：进行中。附件清理读取全部不可变消息版本，包含归档与分支历史；原 sha256: 引用与对象文件名按原所有者定义匹配。只预览孤立附件和未发布临时文件，不删除权威历史、派生索引、活动 Run、有效快照或恢复证据。版本摘要绑定原目录 inode/dev、全部引用与对象清单、内容摘要和文件身份；未知对象、摘要损坏或缺失历史引用均拒绝。

私有 storage-maintenance Worker 先沿原七所有者只读 Schema/权威校验、生产密钥锚、受保护 Core 载荷及消息图像审核，再在全部租约仍持有时预览或执行。Renderer 只接收有界类别数量、大小、版本和一次性票据，不能发送候选路径或读取私有密钥。执行重新计算完整版本，在第一笔删除前拒绝漂移；逐项 fsync claim-pending、原子领取文件、核验精确字节后删除并同步回执。I/O 或领取内容变化保留未确认对象与操作记录，不自动重试或清理证据。目前验证 I/O 中断及异常领取记录；实际 Worker 强杀中断门仍待验收，不宣称物理断电耐久性。

备份和清理使用同一个 MainOfflineDataMaintenance，复用原 Renderer 草稿/文档 barrier、通知暂停、已准入 Main 写入 drain、Runtime shutdown/ACK/实际退出、Main 队列 flush 和恢复钩子。独占操作持续到发布/证据处理完成；提前返回的捕获也必须结算后才能恢复所有者。原备份没有第二组冻结逻辑。Main 正常退出等待这个共享操作，清理票据到期只释放元数据，不触发删除。

Settings 提供影响预览、保留引用数量、分类选择、有效期和默认聚焦取消的明确删除确认。初始不勾选类别；空类别不能提交。确认绑定精确票据/版本/选择，失败消费提交票据后要求重新预览。中断结果分别显示已删除与保留数量、操作 ID 和证据保留，未知结算不冒称数据未改变。取消、卸载及迟到预览释放原票据。归档、历史、备份、派生索引与附件清理的范围在页面中明确区分。

验证：原 Runtime 附件预览/执行九项通过，涵盖归档引用、版本漂移、分类选择、缺失引用、异常领取、保留证据和空选择。六项私有协议门通过。原 RuntimeSupervisor 与共享维护共 31 项通过，其中实际生产 Runtime/七原数据库/独立私有 Worker 验证活跃租约拒绝、过期预览拒绝、实际删除两文件、七数据库字节保留并恢复 Runtime；该原生 Node 门使用空受保护存储，不冒称 populated Core 恢复。Main 票据六项通过。数据/清理/导出隐藏 Electron DOM 共 33 项通过，包含 1000/360 布局；两张清理截图均已审阅，没有横向溢出。UI 夹具不代表实际 native picker。

完整串行 Runtime 164 文件/1229 项通过；完整串行 App 112 文件/523 项通过，三个 opt-in 原生门跳过。App 回归在随后增加的隐藏 packaged 冷启动 smoke 之前；该新 smoke 仅类型通过，尚未执行。当前 App 构建含正文导出/共享维护/清理页面，随后冷启动 smoke 仍待新构建。架构与九个冻结访问契约、两项扩展通过。首个私有 Worker 类型门因原 snapshot readonly 数组不匹配失败，边界保留 unknown 并沿原严格响应 Schema 校验后类型通过，未改冻结契约；失败日志保留。

安装包依赖暂存与固定版本 Transformers 环境已安装/导入校验。发现 Sandbox manifest 仍为 development_unsigned；未改变信任要求，也未把本机开发资产标为发行通过。Python 环境的 relocation 与签名/完整安装包资产留在原发行门验收。旧 18 文件认证备份保留；为恢复界面验收另生成原设置中登记工作区的独立备份，修正测试数据范围，不绕过生产导航授权。

尚未完成：完整 ApplicationController 的备份/恢复原维护 hooks、目录交接后的生产 packaged 冷启动/历史及附件/受保护载荷和无重复副作用演练、中断启动选择、原生 picker 与安装包/发行资产门。T11 四项仍未勾选，ADR Proposed；T12—T16 按顺序保留。全部完成、正式文档收敛、最后删除 TODO 后直接关机，不询问；当前不关机。
`;
const documents = ['TODO.md', 'docs/remediation-verification.md'];
const texts = await Promise.all(documents.map(file => readFile(file, 'utf8')));
if (texts.some(text => text.includes(heading))) throw new Error('Cleanup progress already recorded.');
const matrixPath = 'docs/verification-matrix.json', matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
const row = matrix.rows.find(item => item.module === 'same-machine-backup-and-recovery');
if (!row) throw new Error('Backup matrix row missing.');
for (const source of ['runtime/src/adapters/persistence/OfflineConversationAttachmentMaintenance.ts',
  'runtime/src/adapters/persistence/OfflineConversationAttachmentCleanup.ts', 'app/src/main/data-management/main-offline-data-maintenance.ts',
  'app/src/main/data-management/data-attachment-cleanup-service.ts', 'app/src/main/smoke/data-recovery-smoke.ts'])
  if (!row.source.includes(source)) row.source.push(source);
for (const name of ['t11-guarded-orphan-execution-tests.log', 't11-private-cleanup-protocol-tests.log',
  't11-shared-owner-cleanup-private-worker-tests.log', 't11-cleanup-ticket-lifecycle-tests.log',
  't11-attachment-cleanup-renderer-ui-tests.log', 't11-cleanup-current-full-runtime-serial-tests.log',
  't11-cleanup-current-full-app-serial-tests.log', 't11-cleanup-frozen-contracts.log', 't11-cleanup-main-settings-architecture.log',
  't11-text-export-shared-cleanup-current-app-build.log', 't11-package-transformers-runtime-setup.log']) {
  const file = 'artifacts/todo-remediation/' + name; if (!row.evidence.includes(file)) row.evidence.push(file);
}
row.notes += ' Exact-version explicit orphan/unpublished attachment cleanup now runs under the original seven validated owner leases and the shared Main/Renderer/Runtime maintenance barrier. Interrupted claims and receipts are retained. Current Runtime serial 164 files/1229 tests and App serial 112 files/523 tests pass (3 native opt-in skips); hidden data/cleanup/export DOM 33 pass, both cleanup widths visually reviewed. Full packaged Application recovery/native picker/interrupt-choice and release assets remain incomplete; existing Sandbox is development_unsigned and trust requirements are not relaxed.';
matrix.generatedAt = '2026-10-07';
await writeFile(matrixPath, JSON.stringify(matrix, null, 2) + '\n');
await writeFile('artifacts/todo-remediation/t11-cleanup-progress.md', progress);
for (let index = 0; index < documents.length; index++) await writeFile(documents[index], texts[index].trimEnd() + '\n\n' + progress);
const adr = 'docs/adr/0045-controlled-same-machine-backup-and-recovery.md';
await writeFile(adr, (await readFile(adr, 'utf8')).trimEnd() + '\n\n## Explicit attachment cleanup and current regression, 2026-10-07\n\n'
  + 'Text-only authorized same-C Session export and exact-version orphan/unpublished attachment cleanup are now implemented. Cleanup audits every immutable message version and preserves archived/lineage references. The storage-only worker validates all seven original owners, encrypted payloads and referenced images before inspecting or settling candidates while holding every lease. Candidate paths and keys stay private. Each atomic claim is durably recorded before exact-byte verification and deletion; uncertain claimed bytes and all receipts remain evidence, without automatic replay. Main uses the same original-owner maintenance coordinator for backup and cleanup. Its one-use fifteen-minute metadata preview binds version and selected categories; the UI requires explicit category selection and a cancel-focused irreversible-deletion confirmation.\n\n'
  + 'Current full serial Runtime regression passes 164 files/1229 tests; App passes 112 files/523 tests with three native opt-in skips, before the subsequently added packaged cold-start smoke. Nine attachment plan/execution checks, six private protocol checks, 31 original Runtime/shared-barrier checks and six ticket lifecycle checks pass. Hidden data/cleanup/export Renderer checks pass 33 cases including both widths, and both cleanup screenshots were reviewed. Architecture and frozen nine access/two extension contracts pass. Existing Sandbox distribution is development_unsigned and release trust requirements remain unchanged. Full packaged Application recovery, native picker/interrupt-choice and release asset acceptance remain incomplete; this ADR stays Proposed.\n');
process.stdout.write('T11 explicit cleanup progress recorded; overall goal remains incomplete.\n');
