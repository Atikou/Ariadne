import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { runtimeCommandSchema } from '@ariadne/protocol/public';
import type { RuntimeCommand } from '@ariadne/protocol/public';
import { z } from 'zod';

import type {
  AgentInputDeliveryOutboxRecord,
  AgentInputDeliveryOutboxStageRequest
} from '@shared/contract';
import type { SecretCipher } from './secret-cipher';

type AgentInboxEnqueueCommand = Extract<
  RuntimeCommand,
  { readonly kind: 'agent.inbox.enqueue.v3' }
>;

const MAX_RECORDS = 100;
const MAX_CIPHERTEXT_BYTES = 1024 * 1024;
const storageKeySchema = z.string().regex(/^[a-f0-9]{64}$/u);
const commandIdSchema = z.string().trim().min(1).max(256);
const encryptedRecordSchema = z.object({
  ciphertext: z.string().min(1).max(MAX_CIPHERTEXT_BYTES),
  createdAt: z.string().datetime()
}).strict();
const outboxFileSchema = z.object({
  schemaVersion: z.literal(1),
  records: z.record(storageKeySchema, encryptedRecordSchema)
}).strict();
const secretRecordSchema = z.object({
  commandId: commandIdSchema,
  command: runtimeCommandSchema,
  createdAt: z.string().datetime()
}).strict();

type OutboxFile = z.infer<typeof outboxFileSchema>;

/**
 * Main-only encrypted sender outbox for Agent inbox commands whose transport
 * settlement is not yet known. Runtime's command journal and Agent inbox stay
 * authoritative; this store exists only to retain the exact retry envelope
 * across Renderer or desktop-process loss and never dispatches by itself.
 */
export class AgentInputDeliveryOutbox {
  private file: OutboxFile = { schemaVersion: 1, records: {} };
  private initialized = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher,
    private readonly now: () => Date = () => new Date()
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      this.file = outboxFileSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')));
      this.readRecords(this.file);
    } catch (error) {
      if (!isMissingFile(error)) {
        throw new Error('agent_input_delivery_outbox_invalid', { cause: error });
      }
      await this.persist(this.file);
    }
    this.initialized = true;
  }

  list(): AgentInputDeliveryOutboxRecord[] {
    this.assertInitialized();
    return this.readRecords(this.file);
  }

  async stage(
    request: AgentInputDeliveryOutboxStageRequest
  ): Promise<AgentInputDeliveryOutboxRecord> {
    this.assertInitialized();
    const commandId = commandIdSchema.parse(request.commandId);
    const command = requireInboxCommand(runtimeCommandSchema.parse(request.command));
    const storageKey = commandStorageKey(commandId);
    return this.mutate((current) => {
      const existing = current.records[storageKey];
      if (existing !== undefined) {
        const record = this.readRecord(storageKey, existing);
        if (canonicalRecordCommand(record) !== canonicalCommand(command)) {
          throw new Error('agent_input_delivery_outbox_command_conflict');
        }
        return { next: current, result: record, persist: false };
      }
      if (Object.keys(current.records).length >= MAX_RECORDS) {
        throw new Error('agent_input_delivery_outbox_capacity_exceeded');
      }

      const createdAt = this.now().toISOString();
      const secret = secretRecordSchema.parse({ commandId, command, createdAt });
      const encrypted = encryptedRecordSchema.parse({
        ciphertext: this.cipher.encrypt(JSON.stringify(secret)),
        createdAt
      });
      return {
        next: {
          ...current,
          records: { ...current.records, [storageKey]: encrypted }
        },
        result: toPublicRecord(secret),
        persist: true
      };
    });
  }

  async settle(commandIdInput: string): Promise<void> {
    this.assertInitialized();
    const commandId = commandIdSchema.parse(commandIdInput);
    const storageKey = commandStorageKey(commandId);
    await this.mutate((current) => {
      if (current.records[storageKey] === undefined) {
        return { next: current, result: undefined, persist: false };
      }
      const records = { ...current.records };
      delete records[storageKey];
      return {
        next: { ...current, records },
        result: undefined,
        persist: true
      };
    });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private readRecords(file: OutboxFile): AgentInputDeliveryOutboxRecord[] {
    return Object.entries(file.records)
      .map(([storageKey, encrypted]) => this.readRecord(storageKey, encrypted))
      .sort((left, right) => (
        left.createdAt.localeCompare(right.createdAt)
        || left.commandId.localeCompare(right.commandId)
      ));
  }

  private readRecord(
    storageKey: string,
    encrypted: z.infer<typeof encryptedRecordSchema>
  ): AgentInputDeliveryOutboxRecord {
    const secret = secretRecordSchema.parse(JSON.parse(this.cipher.decrypt(encrypted.ciphertext)));
    if (
      secret.createdAt !== encrypted.createdAt
      || commandStorageKey(secret.commandId) !== storageKey
    ) throw new Error('agent_input_delivery_outbox_identity_mismatch');
    return toPublicRecord(secret);
  }

  private async mutate<T>(
    operation: (current: OutboxFile) => {
      readonly next: OutboxFile;
      readonly result: T;
      readonly persist: boolean;
    }
  ): Promise<T> {
    let result: T | undefined;
    const queued = this.writeQueue.then(async () => {
      const mutation = operation(this.file);
      const parsed = outboxFileSchema.parse(mutation.next);
      if (mutation.persist) await this.persist(parsed);
      this.file = parsed;
      result = mutation.result;
    });
    this.writeQueue = queued;
    await queued;
    return result as T;
  }

  private async persist(file: OutboxFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    await rename(temporary, this.filePath);
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('agent_input_delivery_outbox_not_initialized');
  }
}

function requireInboxCommand(command: RuntimeCommand): AgentInboxEnqueueCommand {
  if (command.kind !== 'agent.inbox.enqueue.v3') {
    throw new Error('agent_input_delivery_outbox_command_unsupported');
  }
  return command;
}

function toPublicRecord(secret: z.infer<typeof secretRecordSchema>): AgentInputDeliveryOutboxRecord {
  return {
    commandId: secret.commandId,
    command: structuredClone(requireInboxCommand(secret.command)),
    createdAt: secret.createdAt
  };
}

function canonicalRecordCommand(record: AgentInputDeliveryOutboxRecord): string {
  return canonicalCommand(record.command);
}

function canonicalCommand(command: AgentInboxEnqueueCommand): string {
  return JSON.stringify(runtimeCommandSchema.parse(command));
}

function commandStorageKey(commandId: string): string {
  return createHash('sha256').update(commandId, 'utf8').digest('hex');
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
