import { readFile, writeFile } from 'node:fs/promises';
const record = await readFile('artifacts/todo-remediation/t11-foundation-record.md', 'utf8');
let todo = await readFile('TODO.md', 'utf8');
if (todo.includes('## T11 受控维护与备份基础开始')) throw new Error('T11 foundations already recorded.');
todo = todo.replace('| T11 | 5.2：数据管理与恢复 | T02、T03、T05、T07、T08 的存储范围确定 | 未开始 |',
  '| T11 | 5.2：数据管理与恢复 | T02、T03、T05、T07、T08 的存储范围确定 | 进行中 |');
await writeFile('TODO.md', todo + record);
await writeFile('docs/remediation-verification.md', (await readFile('docs/remediation-verification.md', 'utf8')) + record);
const matrix = JSON.parse(await readFile('docs/verification-matrix.json', 'utf8'));
matrix.currentGate.reason = 't10_complete_t11_in_progress_overall_incomplete';
matrix.currentGate.notes = 'T10 scoped acceptance complete. T11 foundations are in progress; complete backup/restore, T12–T16 and independent gates remain unfinished. Shutdown only after full completion.';
matrix.rows.push({ module: 'same-machine-backup-and-recovery', status: 'partial', unit: 'verified', integration: 'partial',
  realModel: 'not_applicable', realWindow: 'not_accepted', realMachine: 'partial',
  source: ['app/src/main/runtime/runtime-supervisor.ts', 'app/src/main/data-management/backup-manifest.ts',
    'app/src/main/data-management/backup-object-seal.ts', 'app/src/main/data-management/windows-backup-key-protector.ts',
    'app/src/main/data-management/runtime-snapshot-worker.ts', 'runtime/src/adapters/persistence/OfflineRuntimeBackupOwner.ts',
    'runtime/src/entry/storage-maintenance-process.ts', 'docs/adr/0045-controlled-same-machine-backup-and-recovery.md'],
  evidence: ['artifacts/todo-remediation/t11-maintenance-manifest-owner-tests.log',
    'artifacts/todo-remediation/t11-authenticated-backup-object-tests.log',
    'artifacts/todo-remediation/t11-offline-sqlite-owner-backup-tests.log',
    'artifacts/todo-remediation/t11-backup-foundation-frozen-contracts.log'],
  notes: 'Foundation checks only: real Runtime shutdown/resume, leased offline SQLite/WAL and attachment capture, authenticated object encryption and actual Windows DPAPI. Main-wide freeze/flush, bundle publication, protected-data restore, isolated Runtime validation, directory switch, UI and complete recovery drill remain unfinished.' });
await writeFile('docs/verification-matrix.json', JSON.stringify(matrix, null, 2) + '\n');
