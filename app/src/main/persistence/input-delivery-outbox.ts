import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runtimeCommandSchema } from '@ariadne/protocol/public';
import { z } from 'zod';
import type { InputDeliveryCommand, InputDeliveryOutboxRecord, InputDeliveryOutboxStageRequest } from '@shared/contract';
import { parseInputDeliveryOutboxBatch } from '@shared/schemas';
import type { SecretCipher } from './secret-cipher';
import { unrestrictedMainWrites, type MainWriteAdmission } from '../data-management/main-maintenance-gate';

const MAX_RECORDS = 100;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_NEW_CIPHERTEXT_BYTES = 32 * 1024 * 1024;
const storageKeySchema = z.string().regex(/^[a-f0-9]{64}$/u);
const commandIdSchema = z.string().trim().min(1).max(256);
const encryptedRecordSchema = z.object({ ciphertext: z.string().min(1).max(8 * 1024 * 1024), createdAt: z.string().datetime() }).strict();
const outboxFileSchema = z.object({ schemaVersion: z.literal(1), records: z.record(storageKeySchema, encryptedRecordSchema) }).strict()
  .refine(file => Object.keys(file.records).length <= MAX_RECORDS);
const secretRecordSchema = z.object({ commandId: commandIdSchema, command: runtimeCommandSchema,
  draftSubmissionId: z.string().uuid().optional(), createdAt: z.string().datetime() }).strict();
type OutboxFile = z.infer<typeof outboxFileSchema>;

/** One Main-only encrypted input sender outbox. It retains original Runtime
 * envelopes, including the whole new-session batch, but never dispatches.
 * Core's journal remains the authority for command outcomes. */
export class InputDeliveryOutbox {
  private file: OutboxFile = { schemaVersion: 1, records: {} };
  private initialized = false;
  private failed = false;
  private writeQueue: Promise<void> = Promise.resolve();
  constructor(private readonly filePath: string, private readonly cipher: SecretCipher, private readonly now: () => Date = () => new Date(),
    private readonly writes: MainWriteAdmission = unrestrictedMainWrites) {}
  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      if ((await stat(this.filePath)).size > MAX_FILE_BYTES) throw new Error('input_delivery_outbox_file_capacity_exceeded');
      this.file = outboxFileSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')));
      this.readRecords(this.file);
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        this.failed = true; console.warn('Input delivery secure storage is unavailable; the original file was preserved.'); return;
      }
      // A missing file has no unsettled envelope. First stage creates the file;
      // initialization must not make an unavailable optional sender stop Main.
    }
    this.initialized = true;
  }
  list(): InputDeliveryOutboxRecord[] { this.assertAvailable(); return this.readRecords(this.file); }
  async stage(request: InputDeliveryOutboxStageRequest): Promise<InputDeliveryOutboxRecord> { return (await this.stageBatch([request]))[0]!; }
  async stageBatch(input: readonly InputDeliveryOutboxStageRequest[]): Promise<InputDeliveryOutboxRecord[]> {
    this.assertAvailable(); const requests = parseInputDeliveryOutboxBatch(input);
    return this.mutate(current => {
      const records = { ...current.records }, results: InputDeliveryOutboxRecord[] = []; let changed = false;
      for (const request of requests) {
        const command = requireInputCommand(request.command), key = commandStorageKey(request.commandId), existing = records[key];
        if (existing) {
          const record = this.readRecord(key, existing);
          if (canonicalCommand(record.command) !== canonicalCommand(command) || record.draftSubmissionId !== request.draftSubmissionId)
            throw new Error('input_delivery_outbox_command_conflict');
          results.push(record); continue;
        }
        if (Object.keys(records).length >= MAX_RECORDS) throw new Error('input_delivery_outbox_capacity_exceeded');
        const createdAt = this.now().toISOString(), secret = secretRecordSchema.parse({ ...request, command, createdAt });
        records[key] = encryptedRecordSchema.parse({ ciphertext: this.cipher.encrypt(JSON.stringify(secret)), createdAt });
        results.push(toRecord(secret)); changed = true;
      }
      // Valid current-format backlogs remain readable and can be drained. They
      // cannot grow beyond the bounded new-write budget.
      if (changed && Object.values(records).reduce((sum, row) => sum + Buffer.byteLength(row.ciphertext), 0) > MAX_NEW_CIPHERTEXT_BYTES)
        throw new Error('input_delivery_outbox_attachment_capacity_exceeded');
      return { next: { ...current, records }, result: results, persist: changed };
    });
  }
  async settle(commandIdInput: string): Promise<void> {
    this.assertAvailable(); const key = commandStorageKey(commandIdSchema.parse(commandIdInput));
    await this.mutate(current => { const records = { ...current.records }, exists = records[key] !== undefined; delete records[key];
      return { next: { ...current, records }, result: undefined, persist: exists }; });
  }
  async flush(): Promise<void> { await this.writeQueue; }
  validateBackup(raw: string): void {
    if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw new Error('input_delivery_outbox_file_capacity_exceeded');
    this.readRecords(outboxFileSchema.parse(JSON.parse(raw)));
  }
  private readRecords(file: OutboxFile): InputDeliveryOutboxRecord[] {
    return Object.entries(file.records).map(([key, row]) => this.readRecord(key, row))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.commandId.localeCompare(right.commandId));
  }
  private readRecord(key: string, encrypted: z.infer<typeof encryptedRecordSchema>): InputDeliveryOutboxRecord {
    const secret = secretRecordSchema.parse(JSON.parse(this.cipher.decrypt(encrypted.ciphertext)));
    if (secret.createdAt !== encrypted.createdAt || commandStorageKey(secret.commandId) !== key) throw new Error('input_delivery_outbox_identity_mismatch');
    return toRecord(secret);
  }
  private async mutate<T>(operation: (current: OutboxFile) => { next: OutboxFile; result: T; persist: boolean }): Promise<T> {
    return this.writes.write(async () => {
    let result!: T;
    const queued = this.writeQueue.then(async () => {
      this.assertAvailable(); const mutation = operation(this.file), parsed = outboxFileSchema.parse(mutation.next);
      if (mutation.persist) {
        try { await this.persist(parsed); } catch { this.failed = true; throw new Error('input_delivery_outbox_persistence_failed'); }
      }
      this.file = parsed; result = mutation.result;
    });
    // Identity rejection must not poison valid subsequent work. Physical write
    // failure instead latches unavailable, preserving unknown disk state.
    this.writeQueue = queued.catch(() => undefined); await queued; return result;
    });
  }
  private async persist(file: OutboxFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true }); const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file)}\n`, { encoding: 'utf8', mode: 0o600, flush: true }); await rename(temporary, this.filePath);
  }
  private assertAvailable(): void { if (!this.initialized || this.failed) throw new Error('input_delivery_outbox_unavailable'); }
}
function requireInputCommand(command: z.infer<typeof runtimeCommandSchema>): InputDeliveryCommand {
  if (command.kind !== 'agent.inbox.enqueue' && command.kind !== 'conversation.session.create' && command.kind !== 'conversation.message.accept')
    throw new Error('input_delivery_outbox_command_unsupported');
  return command;
}
function toRecord(secret: z.infer<typeof secretRecordSchema>): InputDeliveryOutboxRecord {
  return { commandId: secret.commandId, command: structuredClone(requireInputCommand(secret.command)), createdAt: secret.createdAt,
    ...(secret.draftSubmissionId === undefined ? {} : { draftSubmissionId: secret.draftSubmissionId }) };
}
function canonicalCommand(command: InputDeliveryCommand): string { return JSON.stringify(runtimeCommandSchema.parse(command)); }
function commandStorageKey(commandId: string): string { return createHash('sha256').update(commandId, 'utf8').digest('hex'); }
