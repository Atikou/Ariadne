import { readFileSync, writeFileSync } from 'node:fs';
const proof = JSON.parse(readFileSync('artifacts/todo-remediation/t11-native-authenticated-protected-profile-recovery.json', 'utf8'));
if (!proof.accepted.ok || proof.accepted.runtime.validation !== 'current-recovery' || proof.accepted.runtime.protectedArtifacts !== 5
  || proof.accepted.runtime.referencedAttachments !== 1 || proof.accepted.checkedPrivateFiles !== 9 || proof.validatedFiles !== 18
  || !proof.encryptedBundleUnpacked || !proof.sourceFilesUnchanged || !proof.validStageFilesUnchanged
  || !proof.corruptedSealedKeyRejected || !proof.retiredAgentSchemaRejectedAndPreserved) throw new Error('Native recovery proof is incomplete.');
const matrixPath = 'docs/verification-matrix.json', matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
const row = matrix.rows.find(row => row.module === 'same-machine-backup-and-recovery');
if (!row) throw new Error('Backup matrix row is missing.');
for (const source of ['app/src/main/runtime/electron-backup-validation-process.ts', 'app/src/main/runtime/electron-backup-validation-worker.ts',
  'app/src/main/runtime/electron-backup-validation-contract.ts', 'app/src/main/data-management/main-recovery-validation.ts',
  'runtime/src/adapters/persistence/OfflineConversationRecoveryAudit.ts', 'packages/protocol/src/host/agent-persistence-key-ring.ts'])
  if (!row.source.includes(source)) row.source.push(source);
for (const evidence of ['t11-main-readonly-current-owner-tests-fixed.log', 't11-main-current-owners-full-app-serial-tests.log',
  't11-original-readonly-full-runtime-serial-tests.log', 't11-current-protected-recovery-final-protocol-tests.log',
  't11-private-recovery-and-quit-owner-targeted-tests.log', 't11-native-protected-backup-source-acknowledged-delivery.json',
  't11-native-authenticated-protected-profile-recovery.json', 't11-native-authenticated-protected-profile-recovery-tests.log',
  't11-native-isolated-recovery-architecture.log', 't11-native-durable-handoff-fixture-types.log']) {
  const path = 'artifacts/todo-remediation/' + evidence; if (!row.evidence.includes(path)) row.evidence.push(path);
}
row.notes = 'T11 remains incomplete. Actual native OS-sealed Main files, production Runtime, original synthetic Core/Conversation commands and controlled 18-file encrypted backup now pass independent extraction/read-only validation: nine Main files, five protected Core artifacts, one normalized message image; wrong sealed-key material and retired Agent schema rejected; source/valid stage bytes unchanged. All owner leases held through decryption, no actors during validation. Fixture Renderer/notification hooks have no window and do not prove interactive maintenance. Full recoverable directory switch/restart, export/statistics/cleanup preview and UI remain unfinished. Original Runtime full serial 163 files/1220 tests; App full serial 106/487 before later validator/quit changes; latest scoped six files/41 tests and Protocol full 20/108 pass. No timeout or architecture baseline relaxed. Shutdown only after all TODO tasks complete.';
writeFileSync(matrixPath, JSON.stringify(matrix, null, 2) + '\n');
const heading = '## T11 独立原生加密备份与只读恢复验证（2026-10-06）';
const progress = `${heading}

状态：进行中。私有 validate-recovery 请求复用原密钥环契约并绑定本操作 ID；原七所有者租约保持到逐条保护载荷审计结束，密钥 Buffer 和 AES codec 在释放前清零／销毁。Conversation 恢复复用原不可变消息解析与正文摘要校验、Saga 行读取以及原图像存储的大小／摘要／媒体格式检查。Main 原所有者增加不初始化、不迁移、不修复的现行格式只读入口，原通知 SQLite 同样只读检查 Schema 和每行身份／时间／尝试状态。

隔离 Electron 子进程使用单独的 Local State 副本和原 safeStorage cipher，不将待恢复目录作为 Chromium 可写 profile；全部私有响应绑定请求并等到实际进程关闭。正常退出先等待已准入备份操作完成，避免提前关闭原通知连接／Runtime 或摧毁 profile。Main／Runtime 进程桥接留在原 Main runtime 边界；未修改桌面结构规则或架构基线。

原生独立证据：t11-native-protected-backup-source-acknowledged-delivery.json 使用真实 Windows 安全存储密钥、生产 Runtime 和原 Core／Conversation 命令的明确合成输入，原 DataBackupService 正常冻结／恢复并原子发布 18 文件、1092240 字节的认证加密备份。独立 t11-native-authenticated-protected-profile-recovery-tests.log 一项通过；对应 JSON 核验九个 Main 文件、五个保护载荷和一张正规化消息图像。真实 Electron 解密成功；有效恢复文件与源文件字节不变，损坏的 OS 密钥环密文及 Agent schema 7 被拒绝并保留。验证期间未启动 Actor／工具／调度，没有物理操作。源夹具的 Renderer／通知维护 hooks 没有窗口；不将其写为生产交互维护或真实模型质量验收。

回归：原 Runtime 全量串行 t11-original-readonly-full-runtime-serial-tests.log 163 文件／1220 项通过；App 全量串行 t11-main-current-owners-full-app-serial-tests.log 106 文件／487 项通过（在后续原生 validator 和退出等待改动之前）。最新 t11-private-recovery-and-quit-owner-targeted-tests.log 六文件／41 项，t11-current-protected-recovery-final-protocol-tests.log 20 文件／108 项、原生夹具类型与架构均通过。原并行全量的 SQLite／大账本默认时限失败，隔离及串行复验通过；没有加长源测试时限。较早类型错误、TEMP 8.3 映射和原生失败日志全部保留。

早期 T10 开发 profile 在恢复密钥锚阶段正确拒绝：它使用 strict-json-v1、没有生产密钥锚，不能作为加密恢复证据。新原生合成 Core 夹具首次在 Electron 主机直接调用 Node Core，后移回 Node 所有者；未链接 Saga 的终态 Run、未确认的合成 handoff 送达分别被原冷启动边界拒绝。现通过原 Saga 请求／链接及原精确 outbox claim／ACK 完成夹具事实，再由实际 Runtime 重开并处理结果，未改产品检查放行失败样本。

尚未完成：可恢复目录切换／中断选择／切换后完整重启读取，Settings 交互入口、会话导出、占用统计和版本化清理预览。ADR 0045 保持 Proposed，T11 四框不勾选；T12—T16 及 T01／T04／T07 原独立门仍待完成。全部完成后收敛正式文档、最后删除 TODO，再直接关机，不询问。
`;
writeFileSync('artifacts/todo-remediation/t11-native-profile-validation-progress.md', progress);
for (const path of ['TODO.md', 'docs/remediation-verification.md']) {
  const text = readFileSync(path, 'utf8'); if (text.includes(heading)) throw new Error('Progress already recorded: ' + path);
  writeFileSync(path, text.trimEnd() + '\n\n' + progress);
}
