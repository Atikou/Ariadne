import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  AgentJsonValue,
  AgentPersistencePayloadCodec,
  EncodedAgentPersistencePayload
} from '@ariadne/agent-core';

import type {
  AgentSubagentSessionOwner,
  AgentSubagentSessionRecord,
  AgentSubagentSessionStore
} from '../../control/ports/AgentSubagentSessionStore.js';

interface StoredSessionEnvelope {
  readonly schemaVersion: 1;
  readonly ownerDigest: string;
  readonly codecId: string;
  readonly payload: AgentJsonValue;
}

/**
 * Immutable provider-private session bindings. One Child Run can bind exactly
 * one remote session; an existing different binding fails closed.
 */
export class FileAgentSubagentSessionStore implements AgentSubagentSessionStore {
  private readonly directory: string;

  public constructor(
    dataRoot: string,
    private readonly codec: AgentPersistencePayloadCodec
  ) {
    this.directory = path.resolve(dataRoot, 'agent-control', 'subagent-sessions');
  }

  public async read(
    owner: AgentSubagentSessionOwner
  ): Promise<AgentSubagentSessionRecord | null> {
    const ownerDigest = digestOwner(owner);
    let text: string;
    try {
      text = await readFile(this.recordPath(ownerDigest), 'utf8');
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    const envelope = parseEnvelope(text, ownerDigest);
    const decoded = this.codec.decode({
      codecId: envelope.codecId,
      payload: envelope.payload
    }, persistenceContext(owner, ownerDigest));
    return parseRecord(decoded, owner);
  }

  public async bind(record: AgentSubagentSessionRecord): Promise<void> {
    assertRecord(record);
    const ownerDigest = digestOwner(record);
    const existing = await this.read(record);
    if (existing !== null) {
      if (
        existing.remoteSessionId !== record.remoteSessionId
        || existing.reconnectMethod !== record.reconnectMethod
      ) throw new Error('subagent_session_binding_conflict');
      return;
    }
    await mkdir(this.directory, { recursive: true });
    const encoded = this.codec.encode({
      remoteRef: record.remoteSessionId,
      reconnectMethod: record.reconnectMethod,
      createdAt: record.createdAt
    }, persistenceContext(record, ownerDigest));
    const envelope: StoredSessionEnvelope = {
      schemaVersion: 1,
      ownerDigest,
      codecId: encoded.codecId,
      payload: encoded.payload
    };
    try {
      await writeFile(
        this.recordPath(ownerDigest),
        `${JSON.stringify(envelope)}\n`,
        { encoding: 'utf8', flag: 'wx' }
      );
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const raced = await this.read(record);
      if (
        raced?.remoteSessionId !== record.remoteSessionId
        || raced.reconnectMethod !== record.reconnectMethod
      ) throw new Error('subagent_session_binding_conflict');
    }
  }

  public async remove(owner: AgentSubagentSessionOwner): Promise<void> {
    try {
      await unlink(this.recordPath(digestOwner(owner)));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  private recordPath(ownerDigest: string): string {
    return path.join(this.directory, `${ownerDigest.slice('sha256:'.length)}.json`);
  }
}

function persistenceContext(owner: AgentSubagentSessionOwner, ownerDigest: string) {
  return {
    kind: 'subagent_session' as const,
    runId: owner.runId,
    commandId: `subagent-session-${ownerDigest.slice('sha256:'.length, 32)}`,
    runVersion: 0
  };
}

function digestOwner(owner: AgentSubagentSessionOwner): string {
  assertOwner(owner);
  return `sha256:${createHash('sha256').update(JSON.stringify({
    runId: owner.runId,
    workspaceId: owner.workspaceId,
    providerId: owner.providerId,
    configurationDigest: owner.configurationDigest
  }), 'utf8').digest('hex')}`;
}

function parseEnvelope(text: string, ownerDigest: string): StoredSessionEnvelope {
  const value = JSON.parse(text) as Partial<StoredSessionEnvelope>;
  if (
    value.schemaVersion !== 1
    || value.ownerDigest !== ownerDigest
    || typeof value.codecId !== 'string'
    || value.payload === undefined
  ) throw new Error('subagent_session_envelope_invalid');
  return value as StoredSessionEnvelope;
}

function parseRecord(
  value: AgentJsonValue,
  owner: AgentSubagentSessionOwner
): AgentSubagentSessionRecord {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('subagent_session_payload_invalid');
  }
  const record = value as Record<string, AgentJsonValue>;
  const candidate: AgentSubagentSessionRecord = {
    ...owner,
    remoteSessionId: String(record.remoteRef ?? ''),
    reconnectMethod: record.reconnectMethod === 'resume' ? 'resume' : 'load',
    createdAt: String(record.createdAt ?? '')
  };
  assertRecord(candidate);
  if (record.reconnectMethod !== candidate.reconnectMethod) {
    throw new Error('subagent_session_payload_invalid');
  }
  return candidate;
}

function assertRecord(record: AgentSubagentSessionRecord): void {
  assertOwner(record);
  if (
    record.remoteSessionId.length === 0
    || record.remoteSessionId.length > 4_096
    || /[\u0000\r\n]/u.test(record.remoteSessionId)
    || (record.reconnectMethod !== 'resume' && record.reconnectMethod !== 'load')
    || !Number.isFinite(Date.parse(record.createdAt))
  ) throw new Error('subagent_session_record_invalid');
}

function assertOwner(owner: AgentSubagentSessionOwner): void {
  if (
    owner.runId.length === 0
    || owner.workspaceId.length === 0
    || owner.providerId.length === 0
    || !/^sha256:[a-f0-9]{64}$/u.test(owner.configurationDigest)
  ) throw new Error('subagent_session_owner_invalid');
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
