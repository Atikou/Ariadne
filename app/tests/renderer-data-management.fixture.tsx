import { useState } from 'react';
import type { AriadneApi } from '../src/shared/contract';
import type { DataRestorePreview, DataCleanupCommit, DataCleanupPreview, DataCleanupResult } from '../src/shared/data-management';
import { DataManagementSettings } from '../src/renderer/src/modules/settings/DataManagementSettings';

type Request = { kind: 'backup' | 'inspect' | 'commit'; ticket?: string; resolve(value: unknown): void; reject(error: Error): void };
const requests: Request[] = [], discarded: string[] = [];
type CleanupRequest = { kind: 'inspect' | 'commit'; request?: DataCleanupCommit; resolve(value: unknown): void; reject(error: Error): void };
const cleanupRequests: CleanupRequest[] = [], cleanupDiscarded: string[] = [];
const fixtureApi: AriadneApi['dataManagement'] = {
  inspectCleanup: () => new Promise((resolve, reject) => cleanupRequests.push({ kind: 'inspect', resolve: value => resolve(value as DataCleanupPreview), reject })),
  commitCleanup: request => new Promise((resolve, reject) => cleanupRequests.push({ kind: 'commit', request, resolve: value => resolve(value as DataCleanupResult), reject })),
  discardCleanup: async request => { cleanupDiscarded.push(request.ticket); },
  exportSession: async () => ({ messages: 2, bytes: 1024, attachmentReferences: 0 }),
  measureUsage: async () => ({ measuredAt: new Date().toISOString(), measurement: 'owned-file-logical-bytes',
    databases: { files: 7, bytes: 1_090_000 }, attachments: { files: 1, bytes: 80 }, privateFiles: { files: 10, bytes: 2160 },
    derivedCaches: { files: 0, bytes: 0 },
    unpublishedAttachments: { files: 0, bytes: 0 }, totalBytes: 1_092_240 }),
  createBackup: () => new Promise((resolve, reject) => requests.push({ kind: 'backup', resolve: value => resolve(value as Awaited<ReturnType<AriadneApi['dataManagement']['createBackup']>>), reject })),
  inspectRestore: () => new Promise((resolve, reject) => requests.push({ kind: 'inspect', resolve: value => resolve(value as DataRestorePreview | null), reject })),
  commitRestore: request => new Promise((resolve, reject) => requests.push({ kind: 'commit', ticket: request.ticket, resolve: () => resolve(), reject })),
  discardRestore: async request => { discarded.push(request.ticket); }
};
export function DataManagementFixture({ page }: { page: string }): React.JSX.Element | null {
  const [visible, setVisible] = useState(true);
  Object.assign(window, { __dataFixture: {
    count: () => requests.length, kinds: () => requests.map(request => request.kind), discarded: () => [...discarded],
    cleanupRequests: () => cleanupRequests.map(({ kind, request }) => ({ kind, request })), cleanupDiscarded: () => [...cleanupDiscarded],
    rejectCleanup: (index: number) => cleanupRequests[index]!.reject(new Error('Synthetic cleanup not settled.')),
    resolveCleanup: (index: number, mode: 'completed' | 'interrupted' | 'empty' = 'completed') => {
      const pending = cleanupRequests[index]!, ticket = '00000000-0000-4000-8000-' + String(index + 100).padStart(12, '0');
      if (pending.kind === 'inspect') pending.resolve({ ticket, version: 'a'.repeat(64), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        referencedObjects: 1, orphanObjects: mode === 'empty' ? 0 : 1, orphanBytes: mode === 'empty' ? 0 : 80,
        unpublishedObjects: mode === 'empty' ? 0 : 1, unpublishedBytes: mode === 'empty' ? 0 : 7 });
      else {
        const selected = pending.request!.selected, files = selected.length,
          bytes = (selected.includes('orphan-attachment') ? 80 : 0) + (selected.includes('unpublished-attachment') ? 7 : 0);
        pending.resolve({ operationId: ticket, status: mode === 'interrupted' ? 'interrupted' : 'completed',
          filesDeleted: mode === 'interrupted' ? 0 : files, bytesDeleted: mode === 'interrupted' ? 0 : bytes,
          filesRetained: mode === 'interrupted' ? files : 0, auditRecorded: true });
      }
    },
    hide: () => setVisible(false), show: () => setVisible(true),
    reject: (index: number) => requests[index]!.reject(new Error('Synthetic fixture validation failure.')),
    resolve: (index: number, cancelled = false) => {
      const request = requests[index]!;
      if (cancelled) { request.resolve(null); return; }
      const ticket = '00000000-0000-4000-8000-' + String(index + 1).padStart(12, '0');
      request.resolve(request.kind === 'backup' ? { backupId: ticket, files: 18, bytes: 1_092_240 } : {
        ticket, backupId: ticket, version: 1, createdAt: '2026-10-06T10:00:00.000Z', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        files: 18, bytes: 1_092_240, protectedArtifacts: 5, referencedAttachments: 1, recoveryScope: 'same-machine-current-user'
      });
    }
  } });
  return page === 'data-management' ? <div className="settings-content-scroll" style={{ height: '100%', overflow: 'auto', padding: 18 }}>
    <p>【UI 夹具】不访问用户数据，不实际备份或恢复。</p>{visible && <DataManagementSettings api={fixtureApi} />}
  </div> : null;
}
