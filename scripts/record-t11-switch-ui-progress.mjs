import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const heading = '## T11 受控目录切换、恢复预览与占用统计进展（2026-10-07）';
const progress = `${heading}

状态：进行中。Main 现有数据库、持久化队列、Renderer 草稿 barrier 和原 Runtime 正常 shutdown/ACK/实际退出已接入恢复提交。切换辅助进程单独打包为 Node CJS，保持 detached 生命周期，必须获得原 Main 实际进程退出码 0、一次 arm 和原目录独占 OS lease 后才能校验并切换。取消、非零退出、未知关闭结果保留原目录与恢复证据。释放自己的 Windows 持锁进程时等待实际 close，随后才重启应用。

切换 journal 记录确切 inode/dev 身份、候选/保留目录、认证 Manifest 摘要和阶段；处理 rename 与记录之间的进程崩溃，不删除或合并目录。正常启动发现未结算记录时，先切换到独立恢复选择 profile，不启动原 Application/Actor；只能选择原目录或再核验摘要的新目录。该启动选择的完整原生交互尚待验收，不能把 journal 单元测试视为真实物理断电耐久性证明。

真实原生进程门使用当前格式 18 文件备份：Electron 退出 7 时辅助进程退出 1、原目录不变；退出 0 时辅助进程实际完成切换、18 文件摘要匹配、原目录保留。该门未创建完整 ApplicationController 或 Renderer，原所有者 shutdown 另由 Runtime/Main 集成门覆盖；完整应用冷启动读取与原生选择器验收仍未完成。

严格恢复核验发现 ready 所报 Public Projection 版本仍是基础 3，而实际原数据库已正常升级为 4。已修正原 AgentEntityHandle readiness 的版本来源，DataBackupService 发布前核对七个数据库实测版本与 Runtime 冻结边界；旧不一致备份保持原样并拒绝，重新生成当前 Schema 的独立原生测试备份。13 项原 Runtime readiness 检查通过。

Settings 已接入 Main 原生备份/恢复选择器、严格 preload/IPC、15 分钟一次性恢复票据、范围预览、默认聚焦取消的恢复确认、忙碌防重复以及卸载后迟到预览回收。Main 保留路径/解密暂存所有权；取消、到期、过期提交与正常退出清理本操作暂存。候选组装失败消费票据并保留失败候选证据，不关闭原所有者。原生服务生命周期门单独通过，涵盖实际 OS 密钥保护/原 Main 读取/Runtime 只读载荷校验；UI 夹具不代替完整 Main 交互。

数据占用沿原封闭文件清单统计数据库及 WAL/SHM、消息图像、私有数据、未发布附件临时文件的逻辑长度。明确这是运行时采样，非分配簇大小或一致性快照；不遍历整个 userData/工作区，不统计兄弟恢复目录。三个文件系统测试核对精确分类/总和、必需文件缺失、未知对象和 junction 拒绝。初次第三项测试使用 rm 删除空目录失败，改为 rmdir 后三项通过；原失败日志保留。

验证：App 最新整套串行回归为 108 文件/504 项通过、3 个 opt-in 原生门跳过；该回归在占用统计加入前，不能冒称统计也经整套验证。新统计单独 3 项通过，数据页 14 项隐藏 Electron DOM 检查（包含 1000/360 布局）通过，截图已生成；此前两种恢复预览截图已审阅。最新包含等待 lease 释放和占用的 App 类型/构建通过；架构门在占用统计加入前通过。原生恢复生命周期及 13 项 OS lease/journal 检查通过；无架构例外或超时放宽。

尚未完成：完整应用的已恢复数据冷启动/历史、附件、受保护状态与不重复副作用演练；中断恢复选择实际门；会话导出；按类别和精确版本给出影响预览并执行清理；完整窗口/原生 picker 与安装包资产验证；最新全量/冻结契约复验。T11 四框仍未勾选，ADR 0045 保持 Proposed，T12—T16 按原顺序保留。全部任务与最终验收完成后收敛正式文档，最后删除 TODO，再直接关机，不询问；当前不关机。
`;
for (const file of ['TODO.md', 'docs/remediation-verification.md']) {
  const target = path.join(project, file), previous = await readFile(target, 'utf8'), start = previous.indexOf(heading);
  if (start !== -1 && previous.indexOf('\n## ', start + heading.length) !== -1) throw new Error('Progress section is no longer the final section.');
  await writeFile(target, (start === -1 ? previous.trimEnd() + '\n\n' : previous.slice(0, start)) + progress, 'utf8');
}
await writeFile(path.join(project, 'artifacts/todo-remediation/t11-switch-ui-progress.md'), progress, 'utf8');
const target = path.join(project, 'docs/verification-matrix.json'), matrix = JSON.parse(await readFile(target, 'utf8'));
const item = matrix.rows.find(entry => entry.module === 'same-machine-backup-and-recovery');
if (!item) throw new Error('Backup verification entry missing.');
for (const file of ['app/src/main/data-management/data-restore-service.ts', 'app/src/main/data-management/data-root-switch-journal.ts',
  'app/src/main/data-management/restore-candidate.ts', 'app/src/main/data-management/data-usage.ts',
  'app/src/main/runtime/data-root-switch-process.ts', 'app/src/main/runtime/data-root-switch-worker.ts',
  'app/src/main/runtime/data-root-owner-lease.ts', 'app/src/main/runtime/windows-parent-exit-observer.ts',
  'app/src/main/runtime/data-root-recovery-startup.ts', 'app/src/shared/data-management.ts',
  'app/src/renderer/src/modules/settings/DataManagementSettings.tsx']) if (!item.source.includes(file)) item.source.push(file);
for (const file of ['t11-native-authenticated-root-switch-current-schema.json', 't11-native-authenticated-root-switch-detached-helper-tests.log',
  't11-actual-projection-schema-readiness-tests.log', 't11-native-preview-lifecycle-tests.log', 't11-awaited-lease-handoff-tests.log',
  't11-data-settings-full-app-serial-tests.log', 't11-owned-usage-types.log', 't11-owned-usage-corrected-tests.log',
  't11-owned-usage-renderer-ui-tests.log', 't11-awaited-helper-owned-usage-build.log', 't11-current-data-ui-architecture.log', 't11-switch-ui-progress.md']) {
  const evidence = 'artifacts/todo-remediation/' + file; if (!item.evidence.includes(evidence)) item.evidence.push(evidence);
}
item.notes = 'T11 incomplete. Authenticated current-schema native root switching passes actual clean/nonzero Electron exit and exact 18-file digests; original root retained. Original owner shutdown has separate integration evidence. Settings preview lifecycle, one-use expiry cleanup, typed Main-only paths, explicit confirmation and logical owner-file usage implemented. Native preview lifecycle passes; 13 lease/journal checks; App 108/504 passes before usage changes; usage 3 filesystem cases and 14 hidden Electron DOM checks pass. These do not prove full Application restored cold start, original native picker, interruption choice, export or versioned cleanup. Packaged helper assets and latest complete/frozen regression still pending. No deadline or architecture exceptions relaxed; shutdown only after every TODO task and final acceptance.';
await writeFile(target, JSON.stringify(matrix, null, 2) + '\n', 'utf8');
process.stdout.write('T11 switch/UI progress recorded; task remains incomplete.\n');
