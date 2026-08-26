import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  AgentRunCommandService,
  digestAgentCommittedDirective,
  digestAgentTurnInput,
  sha256AgentControlData,
  summarizeAgentTurnInput,
  type AgentCommittedDirective,
  type AgentRunBinding,
  type AgentRunCheckpointCommit,
  type AgentTurnInputSnapshotV1
} from '@ariadne/agent-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AesGcmAgentPersistencePayloadCodec
} from '../src/adapters/persistence/AesGcmAgentPersistencePayloadCodec.js';
import { Sha256AgentEffectInputDigester } from '../src/adapters/persistence/Sha256AgentEffectInputDigester.js';
import { SqliteAgentRunUnitOfWork } from '../src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import { resolveAgentControlDatabasePath } from '../src/adapters/persistence/agentControlDbSchema.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import {
  ProtectedAgentTerminalAssistantContentResolver
} from '../src/composition/ProtectedAgentTerminalAssistantContentResolver.js';

const roots: string[] = [];
const units = new Set<SqliteAgentRunUnitOfWork>();

afterEach(async () => {
  await Promise.all([...units].map(closeUnit));
  units.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('protected committed Directive payloads', () => {
  it('keeps response body/path out of aggregate, receipt, Event, Outbox, and every SQLite page', async () => {
    const root = createRoot();
    const codec = encryptedCodec();
    const unit = openUnit(root, codec);
    const commands = new AgentRunCommandService(unit);
    await admitAndStartAttempt(commands, 'run-response');

    const rawResponse = 'Result stored at C:\\Users\\Alice\\private-result.txt';
    const contentDigest = await sha256AgentControlData(rawResponse);
    const directive: AgentCommittedDirective = {
      kind: 'respond',
      contentRef: 'directive-artifact-response-one',
      contentDigest
    };
    const directiveDigest = await digestAgentCommittedDirective(directive);
    const command = {
      kind: 'run.record_inference_attempt_result' as const,
      commandId: 'command-response-result',
      runId: 'run-response',
      expectedVersion: 2,
      occurredAt: at(2),
      turnId: 'turn-response',
      attemptId: 'attempt-response',
      result: {
        status: 'succeeded' as const,
        directive,
        directiveDigest
      }
    };
    const artifacts = {
      checkpoint: checkpointCommit(3, at(2), 'response-result'),
      turnInputPayloads: [],
      effectPayloads: [],
      directivePayloads: [{
        artifactId: directive.contentRef,
        kind: 'response_content' as const,
        directiveDigest,
        contentDigest,
        payload: rawResponse,
        recordedAt: at(2)
      }]
    };
    const result = await commands.execute(command, artifacts);
    expect(JSON.stringify(result)).not.toContain(rawResponse);
    expect(result.run.state.status).toBe('completed');
    await expect(
      new ProtectedAgentTerminalAssistantContentResolver(unit)
        .resolveTerminalAssistantContent(result.run)
    ).resolves.toBe(rawResponse);
    expect(await commands.execute(command, artifacts)).toMatchObject({ replayed: true });

    const database = databaseOf(unit);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(count(database, 'agent_v3_directive_payloads')).toBe(1);
    expect(readAllDatabaseText(database)).not.toContain(rawResponse);
    const receipt = await unit.loadCommittedCommandReceipt(command.commandId);
    expect(JSON.stringify(receipt)).not.toContain(rawResponse);
    await expect(unit.loadDirectivePayload({
      runId: 'run-response',
      artifactId: directive.contentRef,
      kind: 'response_content',
      directiveDigest,
      contentDigest
    })).resolves.toBe(rawResponse);
    await expect(unit.loadDirectivePayload({
      runId: 'run-response-drift',
      artifactId: directive.contentRef,
      kind: 'response_content',
      directiveDigest,
      contentDigest
    })).rejects.toThrow(/lookup_mismatch/);

    database.prepare(
      'DELETE FROM agent_v3_directive_payloads WHERE artifact_id=?'
    ).run(directive.contentRef);
    await expect(unit.loadCommittedCommandReceipt(command.commandId))
      .rejects.toThrow(/directive_payloads.*missing/);
    codec.destroy();
  });

  it('rejects credential-shaped response artifacts before the result command writes anything', async () => {
    const root = createRoot();
    const codec = encryptedCodec();
    const unit = openUnit(root, codec);
    const commands = new AgentRunCommandService(unit);
    await admitAndStartAttempt(commands, 'run-secret');
    const rawSecret = 'sk-this-secret-must-not-enter-agent-control';
    const contentDigest = await sha256AgentControlData(rawSecret);
    const directive: AgentCommittedDirective = {
      kind: 'respond',
      contentRef: 'directive-artifact-secret-rejected',
      contentDigest
    };
    const directiveDigest = await digestAgentCommittedDirective(directive);
    await expect(commands.execute({
      kind: 'run.record_inference_attempt_result',
      commandId: 'command-secret-result-rejected',
      runId: 'run-secret',
      expectedVersion: 2,
      occurredAt: at(2),
      turnId: 'turn-secret',
      attemptId: 'attempt-secret',
      result: { status: 'succeeded', directive, directiveDigest }
    }, {
      checkpoint: checkpointCommit(3, at(2), 'secret-result'),
      turnInputPayloads: [],
      effectPayloads: [],
      directivePayloads: [{
        artifactId: directive.contentRef,
        kind: 'response_content',
        directiveDigest,
        contentDigest,
        payload: rawSecret,
        recordedAt: at(2)
      }]
    })).rejects.toThrow(/credentials|authorization/i);

    const database = databaseOf(unit);
    expect(countWhere(
      database,
      'agent_v3_commands',
      'command_id',
      'command-secret-result-rejected'
    )).toBe(0);
    expect(count(database, 'agent_v3_directive_payloads')).toBe(0);
    expect(readAllDatabaseText(database)).not.toContain(rawSecret);
    expect(await unit.transaction((transaction) => transaction.loadRun('run-secret')))
      .toMatchObject({ version: 2, state: { status: 'running' } });
    codec.destroy();
  });

  it('persists and replays two protected Effect inputs for one command and Run', async () => {
    const root = createRoot();
    const unit = openUnit(root);
    const commands = new AgentRunCommandService(unit);
    await admitAndStartAttempt(commands, 'run-two-tools');
    const digester = new Sha256AgentEffectInputDigester();
    const inputs = [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] as const;
    const effectIds = ['effect-two-tools-a', 'effect-two-tools-b'] as const;
    const inputDigests = inputs.map((input, index) =>
      digester.digest(input, {
        runId: 'run-two-tools',
        effectId: effectIds[index]!
      })
    );
    const directive: AgentCommittedDirective = {
      kind: 'invoke_tools',
      invocations: effectIds.map((effectId, index) => ({
        effectId,
        toolCallId: `tool-call-${String(index + 1)}`,
        tool: pinnedTool(),
        idempotencyKey: `idempotency-${String(index + 1)}`,
        capabilityIds: ['workspace.read'],
        scope: ['src'],
        inputDigest: inputDigests[index]!
      }))
    };
    const directiveDigest = await digestAgentCommittedDirective(directive);
    const command = {
      kind: 'run.record_inference_attempt_result' as const,
      commandId: 'command-two-tool-result',
      runId: 'run-two-tools',
      expectedVersion: 2,
      occurredAt: at(2),
      turnId: 'turn-two-tools',
      attemptId: 'attempt-two-tools',
      result: { status: 'succeeded' as const, directive, directiveDigest }
    };
    const artifacts = {
      checkpoint: checkpointCommit(3, at(2), 'two-tool-result'),
      turnInputPayloads: [],
      effectPayloads: effectIds.map((effectId, index) => ({
        kind: 'record_input' as const,
        effectId,
        inputDigest: inputDigests[index]!,
        input: inputs[index]!,
        recordedAt: at(2)
      }))
    };
    const result = await commands.execute(command, artifacts);
    expect(result.run.effects).toHaveLength(2);
    expect(await commands.execute(command, artifacts)).toMatchObject({ replayed: true });
    const database = databaseOf(unit);
    expect(count(database, 'agent_v3_effect_payloads')).toBe(2);
    expect(countWhere(
      database,
      'agent_v3_effect_payloads',
      'input_command_id',
      command.commandId
    )).toBe(2);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

async function admitAndStartAttempt(
  commands: AgentRunCommandService,
  runId: string
): Promise<void> {
  const suffix = runId.slice('run-'.length);
  const runBinding = binding(runId);
  if (runBinding.objectiveRef.kind !== 'conversation_message') {
    throw new Error('expected_conversation_objective');
  }
  const turnId = `turn-${suffix}`;
  const cause = {
    kind: 'conversation_objective' as const,
    messageId: runBinding.objectiveRef.messageId,
    messageVersion: runBinding.objectiveRef.messageVersion,
    contentDigest: runBinding.objectiveRef.contentDigest
  };
  const turnInput: AgentTurnInputSnapshotV1 = {
    format: 'ariadne.agent-turn-input',
    schemaVersion: 1,
    runId,
    turnId,
    cause,
    authorityRef: {
      kind: 'conversation_message',
      sessionId: runBinding.sessionId,
      workspaceId: runBinding.workspace.workspaceId,
      messageId: runBinding.objectiveRef.messageId,
      messageVersion: runBinding.objectiveRef.messageVersion,
      contentDigest: runBinding.objectiveRef.contentDigest
    },
    messages: [{
      kind: 'text',
      role: 'user',
      content: `Process protected directive ${suffix}.`
    }],
    availableTools: [{
      tool: pinnedTool(),
      capabilityIds: ['workspace.read']
    }]
  };
  const input = {
    messages: turnInput.messages,
    availableTools: turnInput.availableTools
  };
  const inputDigest = await digestAgentTurnInput(input);
  await commands.execute({
    kind: 'run.admit',
    commandId: `command-admit-${suffix}`,
    runId,
    occurredAt: at(0),
    binding: runBinding,
    turn: {
      cause,
      turnId,
      attemptId: `attempt-${suffix}`,
      providerIdempotencyKey: `provider-key-${suffix}`,
      inputDigest,
      inputSummary: summarizeAgentTurnInput(input)
    }
  }, {
    checkpoint: checkpointCommit(1, at(0), 'admitted'),
    turnInputPayloads: [{
      turnId,
      inputDigest,
      payload: turnInput,
      recordedAt: at(0)
    }],
    effectPayloads: []
  });
  await commands.execute({
    kind: 'run.start_inference_attempt',
    commandId: `command-start-attempt-${suffix}`,
    runId,
    expectedVersion: 1,
    occurredAt: at(1),
    turnId: `turn-${suffix}`,
    attemptId: `attempt-${suffix}`
  }, {
    checkpoint: checkpointCommit(2, at(1), 'inference-started'),
    turnInputPayloads: [],
    effectPayloads: []
  });
}

function binding(runId: string): AgentRunBinding {
  return {
    bindingVersion: 3,
    sessionId: 'session-directive-test',
    objectiveRef: {
      kind: 'conversation_message',
      messageId: `message-${runId}`,
      messageVersion: 1,
      contentDigest: `sha256:${'1'.repeat(64)}`
    },
    workspace: {
      workspaceId: 'workspace-directive-test',
      revision: 1,
      grantDigest: `sha256:${'2'.repeat(64)}`,
      access: 'read',
      scopeIds: ['src']
    },
    model: {
      providerId: 'provider-test',
      modelId: 'model-test',
      settingsRevision: 1
    },
    policy: {
      policyId: 'policy-test',
      revision: 1,
      permissionMode: 'trusted'
    },
    capabilities: [{ capabilityId: 'workspace.read', scopeIds: ['src'] }],
    toolCatalog: {
      catalogId: 'catalog-directive-test',
      revision: 1,
      digest: `sha256:${'3'.repeat(64)}`,
      allowedToolNames: ['workspace.read']
    },
    budget: {
      grantId: `grant-${runId}`,
      runId,
      vector: {
        modelTurns: 10,
        toolCalls: 5,
        readCalls: 5,
        writeCalls: 0,
        shellCalls: 0,
        costMicrousd: 1_000_000
      },
      deadlineAt: '2031-01-01T00:00:00.000Z',
      source: { kind: 'root' }
    }
  };
}

function pinnedTool() {
  return {
    catalogId: 'catalog-directive-test',
    revision: 1,
    digest: `sha256:${'3'.repeat(64)}`,
    toolName: 'workspace.read',
    toolVersion: '1.0.0',
    providerId: 'ariadne.builtin',
    contractDigest: `sha256:${'5'.repeat(64)}`
  } as const;
}

function checkpointCommit(
  checkpointVersion: number,
  createdAt: string,
  phase: string
): AgentRunCheckpointCommit {
  return {
    checkpointVersion,
    createdAt,
    payload: {
      format: 'ariadne.agent-checkpoint',
      schemaVersion: 1,
      engineContinuation: { phase },
      modelContext: []
    }
  };
}

function encryptedCodec(): AesGcmAgentPersistencePayloadCodec {
  let nonce = 1;
  return new AesGcmAgentPersistencePayloadCodec(
    'test-key',
    [{ keyId: 'test-key', key: new Uint8Array(32).fill(7) }],
    (size) => {
      const value = Buffer.alloc(size);
      value.writeUInt32BE(nonce, size - 4);
      nonce += 1;
      return value;
    }
  );
}

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-protected-directive-'));
  roots.push(root);
  return root;
}

function openUnit(
  root: string,
  codec?: AesGcmAgentPersistencePayloadCodec
): SqliteAgentRunUnitOfWork {
  const unit = new SqliteAgentRunUnitOfWork(root, codec);
  units.add(unit);
  return unit;
}

async function closeUnit(unit: SqliteAgentRunUnitOfWork): Promise<void> {
  if (!units.delete(unit)) return;
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    await unit.close(context);
  } finally {
    context.dispose();
  }
}

function databaseOf(unit: SqliteAgentRunUnitOfWork): DatabaseSync {
  return (unit as unknown as { database: DatabaseSync }).database;
}

function count(database: DatabaseSync, table: string): number {
  return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  }).count);
}

function countWhere(
  database: DatabaseSync,
  table: string,
  column: string,
  value: string
): number {
  return Number((database.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`
  ).get(value) as { count: number }).count);
}

function readAllDatabaseText(database: DatabaseSync): string {
  const tables = (database.prepare(
    `SELECT name FROM sqlite_master
     WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).all() as Array<{ name: string }>).map((row) => row.name);
  return tables.map((table) =>
    JSON.stringify(database.prepare(`SELECT * FROM ${table}`).all())
  ).join('\n');
}

function at(offsetSeconds: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, 0, offsetSeconds)).toISOString();
}
