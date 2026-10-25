import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { fileDraftCatalogSchema, fileDraftReplaceSchema, type FileDraftCatalog, type FileDraftReplace } from '@shared/file-drafts';
import type { SecretCipher } from './secret-cipher';
import { writeAtomicPrivateFile } from './atomic-private-file';
import { unrestrictedMainWrites, type MainWriteAdmission } from '../data-management/main-maintenance-gate';

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const storedSchema = z.object({ format: z.literal('ariadne-file-drafts.v1'), ciphertext: z.string().min(1).max(MAX_FILE_BYTES) }).strict();

/** Private file editing state; this owner never writes a workspace document. */
export class FileDraftRepository {
  private catalog: FileDraftCatalog = { revision: 0, records: [] };
  private ready = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly filePath: string, private readonly cipher: SecretCipher,
    private readonly writes: MainWriteAdmission = unrestrictedMainWrites) {}
  async initialize(): Promise<void> {
    this.ready = false;
    try {
      if ((await stat(this.filePath)).size > MAX_FILE_BYTES) throw new Error('file_draft_file_too_large');
      const stored = storedSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')));
      this.catalog = fileDraftCatalogSchema.parse(JSON.parse(this.cipher.decrypt(stored.ciphertext))); this.ready = true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') this.ready = true;
      else console.warn('File draft storage is unavailable; the original file is retained and writes are disabled.');
    }
  }
  async list(): Promise<FileDraftCatalog> { await this.queue; this.assertReady(); return structuredClone(this.catalog); }
  replace(input: FileDraftReplace): Promise<FileDraftCatalog> {
    return this.writes.write(async () => {
    const request = fileDraftReplaceSchema.parse(input);
    const task = this.queue.then(async () => {
      this.assertReady();
      if (request.expectedRevision !== this.catalog.revision) throw new Error('file_draft_revision_conflict');
      for (const row of request.records) {
        const previous = this.catalog.records.find(old => old.draftId === row.draftId);
        if (!previous) continue;
        if (row.revision < previous.revision || previous.workspaceId !== row.workspaceId
          || (row.revision === previous.revision && JSON.stringify(row) !== JSON.stringify(previous))) throw new Error('file_draft_editing_revision_conflict');
        if (previous.pendingMutation && row.pendingMutation && (previous.pendingMutation.commandId !== row.pendingMutation.commandId
          || JSON.stringify(previous.pendingMutation.command) !== JSON.stringify(row.pendingMutation.command))) throw new Error('file_draft_mutation_identity_conflict');
      }
      const next = fileDraftCatalogSchema.parse({ revision: this.catalog.revision + 1, records: request.records });
      const raw = JSON.stringify(storedSchema.parse({ format: 'ariadne-file-drafts.v1', ciphertext: this.cipher.encrypt(JSON.stringify(next)) })) + '\n';
      if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw new Error('file_draft_capacity_exceeded');
      try { await writeAtomicPrivateFile(this.filePath, raw); }
      catch { this.ready = false; throw new Error('file_draft_storage_unavailable'); }
      this.catalog = next; return structuredClone(next);
    });
    this.queue = task.then(() => undefined, () => undefined); return task;
    });
  }
  flush(): Promise<void> { return this.queue; }
  validateBackup(raw: string): void {
    if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw new Error('file_draft_file_too_large');
    const stored = storedSchema.parse(JSON.parse(raw)); fileDraftCatalogSchema.parse(JSON.parse(this.cipher.decrypt(stored.ciphertext)));
  }
  private assertReady(): void { if (!this.ready) throw new Error('file_draft_storage_unavailable'); }
}
