import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  AgentRunCommandService,
  DefaultAgentEffectContinuationPlanner,
  digestAgentCommittedDirective,
  digestAgentTurnInput,
  summarizeAgentTurnInput,
  type AgentEffectContinuationPlan,
  type AgentJsonValue,
  type AgentRun,
  type AgentRunBinding,
  type AgentRunCheckpointCommit,
  type AgentRunCommandCommit,
  type AgentRunTransaction,
  type AgentRunUnitOfWork,
  type AgentTerminalEffectResultEvidence,
  type AgentTurnInputMessage,
  type AgentTurnInputSnapshotV1
} from '@ariadne/agent-core';
import { afterEach, describe, expect, it } from 'vitest';

import { Sha256AgentEffectInputDigester } from
  '../src/adapters/persistence/Sha256AgentEffectInputDigester.js';
import { AesGcmAgentPersistencePayloadCodec } from
  '../src/adapters/persistence/AesGcmAgentPersistencePayloadCodec.js';
import { SqliteAgentRunUnitOfWork } from
  '../src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import { resolveAgentControlDatabasePath } from
  '../src/adapters/persistence/agentControlDbSchema.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import { AgentEffectContinuationController } from
  '../src/control/execution/AgentEffectContinuationController.js';

const RUN_ID = 'run-effect-continuation-sqlite';
const SOURCE_TURN_ID = 'turn-effect-continuation-source';
const SOURCE_ATTEMPT_ID = 'attempt-effect-continuation-source';
const EFFECT_ID = 'effect-effect-continuation-sqlite';
const TOOL_CALL_ID = 'tool-call-effect-continuation-sqlite';
const TOOL_CATALOG = {
  catalogId: 'catalog-effect-continuation-sqlite',
  revision: 1,
  digest: `sha256:${'3'.repeat(64)}`
} as const;
const PINNED_TOOL = {
  ...TOOL_CATALOG,
  toolName: 'workspace.read',
  toolVersion: '1.0.0',
  providerId: 'ariadne.builtin',
  contractDigest: `sha256:${'4'.repeat(64)}`
} as const;
const AVAILABLE_TOOLS = [{
  tool: PINNED_TOOL,
  capabilityIds: ['workspace.read']
}] as const;
const EFFECT_INPUT: AgentJsonValue = {
  path: 'src/continuation.ts',
  operation: 'read'
};
const EFFECT_RESULT: AgentJsonValue = {
  found: true,
  lineCount: 17
};
const SECOND_EFFECT_ID = 'effect-effect-continuation-sqlite-second';
const SECOND_TOOL_CALL_ID = 'tool-call-effect-continuation-sqlite-second';
const SECOND_EFFECT_INPUT: AgentJsonValue = {
  path: 'src/continuation-second.ts',
  operation: 'read'
};
const SECOND_EFFECT_RESULT: AgentJsonValue = {
  found: true,
  lineCount: 29
};

const roots: string[] = [];
const openUnits = new Set<SqliteAgentRunUnitOfWork>();

afterEach(async () => {
  await Promise.all([...openUnits].map(closeUnitWithDeadline));
  openUnits.clear();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('SQLite Effect-result continuation authority', () => {
  it('loads protected evidence and commits through the production continuation owner', async () => {
    const fixture = await createSettledToolTurn('succeeded');
    const recovery = await fixture.unit.listActiveRuns();
    const item = recovery.items.find((candidate) => candidate.run.runId === RUN_ID);
    if (item?.ready !== true || item.phase !== 'resumable') {
      throw new Error('expected_ready_effect_continuation');
    }

    const receipt = await new AgentEffectContinuationController(
      fixture.unit,
      fixture.unit
    ).continueSettledBatch(item, new AbortController().signal);

    expect(receipt).toEqual({
      receiptVersion: 1,
      commandId: fixture.plan.command.commandId,
      runId: RUN_ID,
      runVersion: fixture.settledRun.version + 1,
      turnId: fixture.plan.command.turn.turnId,
      attemptId: fixture.plan.command.turn.attemptId,
      replayed: false
    });
  });

  it('commits, replays, and reopens one exact protected continuation', async () => {
    const fixture = await createSettledToolTurn('succeeded');

    const committed = await fixture.commands.execute(
      fixture.plan.command,
      fixture.plan.artifacts
    );

    expect(committed).toMatchObject({
      replayed: false,
      run: {
        version: fixture.settledRun.version + 1,
        state: { status: 'running' }
      }
    });
    expect(committed.run.turns).toHaveLength(2);
    expect(committed.run.turns.at(-1)?.intention.cause).toEqual(
      fixture.plan.command.turn.cause
    );
    await expect(fixture.commands.execute(
      fixture.plan.command,
      fixture.plan.artifacts
    )).resolves.toMatchObject({ replayed: true });

    const durable = await fixture.unit.loadTurnInputPayload({
      runId: RUN_ID,
      turnId: fixture.plan.command.turn.turnId,
      inputDigest: fixture.plan.command.turn.inputDigest
    });
    expect(durable).toEqual(fixture.plan.turnInput);
    expect(effectResultMessages(durable)).toEqual([{
      kind: 'effect_result',
      effectId: EFFECT_ID,
      toolCallId: TOOL_CALL_ID,
      status: 'succeeded',
      result: EFFECT_RESULT
    }]);

    await closeUnit(fixture.unit);
    const reopened = openUnit(fixture.root);
    const recovery = await reopened.listActiveRuns();
    const item = recovery.items.find((candidate) => candidate.run.runId === RUN_ID);
    if (item?.ready !== true || item.phase !== 'resumable') {
      throw new Error('expected_ready_reopened_continuation');
    }
    const reference = item.turnInputPayloads.find(
      (candidate) => candidate.turnId === fixture.plan.command.turn.turnId
    );
    if (reference === undefined) {
      throw new Error('expected_reopened_continuation_input');
    }
    await expect(reopened.loadTurnInputPayload(reference))
      .resolves.toEqual(fixture.plan.turnInput);
  });

  it('rejects re-digested result and historical-prefix forgeries before any write', async () => {
    const fixture = await createSettledToolTurn('succeeded');
    const forged = await replaceContinuationResult(fixture.plan, {
      found: false,
      lineCount: 17
    });
    expect(forged.command.turn.inputDigest)
      .not.toBe(fixture.plan.command.turn.inputDigest);
    const database = databaseOf(fixture.unit);
    const before = agentControlRows(database);

    await expect(fixture.commands.execute(forged.command, forged.artifacts))
      .rejects.toThrow(/turn_input_digest_mismatch|snapshot|durable|authority/i);

    expect(agentControlRows(database)).toEqual(before);
    expect(commandCount(database, forged.command.commandId)).toBe(0);
    expect(turnInputCount(database, forged.command.turn.turnId)).toBe(0);

    const driftedPrefix = await replaceContinuationTextPrefix(
      fixture.plan,
      'A forged historical instruction.'
    );
    expect(driftedPrefix.command.turn.inputDigest)
      .not.toBe(fixture.plan.command.turn.inputDigest);
    await expect(fixture.commands.execute(
      driftedPrefix.command,
      driftedPrefix.artifacts
    )).rejects.toThrow(
      /turn_input_(?:digest|cause)_mismatch|snapshot|prefix|authority|exactly extend/i
    );
    expect(agentControlRows(database)).toEqual(before);
    expect(commandCount(database, driftedPrefix.command.commandId)).toBe(0);
    expect(turnInputCount(database, driftedPrefix.command.turn.turnId)).toBe(0);
  });

  it('rejects a direct commit in a new transaction without its authority proof', async () => {
    const fixture = await createSettledToolTurn('succeeded');
    const capture = new CapturingAgentRunUnitOfWork(fixture.unit);
    const before = agentControlRows(databaseOf(fixture.unit));

    await new AgentRunCommandService(capture).execute(
      fixture.plan.command,
      fixture.plan.artifacts
    );
    expect(agentControlRows(databaseOf(fixture.unit))).toEqual(before);

    const captured = capture.requireCommit();
    await expect(fixture.unit.transaction((transaction) =>
      transaction.commitCommand(captured)
    )).rejects.toThrow(/missing.*authority proof/i);

    expect(agentControlRows(databaseOf(fixture.unit))).toEqual(before);
    expect(commandCount(databaseOf(fixture.unit), captured.commandId)).toBe(0);
    expect(turnInputCount(
      databaseOf(fixture.unit),
      fixture.plan.command.turn.turnId
    )).toBe(0);
  });

  it('persists cancellation only as the exact synthetic result and no result row', async () => {
    const fixture = await createSettledToolTurn('cancelled');
    const cancellation = effectResultMessages(fixture.plan.turnInput);
    expect(cancellation).toEqual([{
      kind: 'effect_result',
      effectId: EFFECT_ID,
      toolCallId: TOOL_CALL_ID,
      status: 'cancelled',
      result: {
        kind: 'ariadne.effect-cancellation',
        schemaVersion: 1,
        reason: 'user_cancelled'
      }
    }]);
    expect(readEffectResultColumns(databaseOf(fixture.unit))).toEqual({
      result_command_id: null,
      result_run_version: null,
      result_codec_id: null,
      result_payload_json: null
    });

    const malformed = await replaceContinuationResult(fixture.plan, {
      kind: 'ariadne.effect-cancellation',
      schemaVersion: 1,
      reason: 'user_cancelled',
      unexpected: true
    });
    const before = agentControlRows(databaseOf(fixture.unit));
    await expect(fixture.commands.execute(malformed.command, malformed.artifacts))
      .rejects.toThrow(/turn_input_(?:digest|cause)_mismatch|cancellation|snapshot/i);
    expect(agentControlRows(databaseOf(fixture.unit))).toEqual(before);

    await expect(fixture.commands.execute(
      fixture.plan.command,
      fixture.plan.artifacts
    )).resolves.toMatchObject({ replayed: false });
    expect(readEffectResultColumns(databaseOf(fixture.unit))).toEqual({
      result_command_id: null,
      result_run_version: null,
      result_codec_id: null,
      result_payload_json: null
    });
    await expect(fixture.unit.loadTurnInputPayload({
      runId: RUN_ID,
      turnId: fixture.plan.command.turn.turnId,
      inputDigest: fixture.plan.command.turn.inputDigest
    })).resolves.toEqual(fixture.plan.turnInput);
  });

  it('proves two cumulative batches and rejects prior-result drift on Turn 3 load and replay', async () => {
    const fixture = await createSettledToolTurn('succeeded');
    const firstContinuation = await fixture.commands.execute(
      fixture.plan.command,
      fixture.plan.artifacts
    );
    const secondTurnId = fixture.plan.command.turn.turnId;
    const secondAttemptId = fixture.plan.command.turn.attemptId;

    const secondInferenceStarted = await fixture.commands.execute({
      kind: 'run.start_inference_attempt',
      commandId: 'command-start-second-continuation-inference',
      runId: RUN_ID,
      expectedVersion: firstContinuation.run.version,
      occurredAt: at(5),
      turnId: secondTurnId,
      attemptId: secondAttemptId
    }, checkpointArtifacts(
      firstContinuation.run.state.checkpointVersion + 1,
      at(5),
      'second_inference_started'
    ));

    const secondInputDigest = new Sha256AgentEffectInputDigester().digest(
      SECOND_EFFECT_INPUT,
      { runId: RUN_ID, effectId: SECOND_EFFECT_ID }
    );
    const secondDirective = {
      kind: 'invoke_tools' as const,
      invocations: [{
        effectId: SECOND_EFFECT_ID,
        toolCallId: SECOND_TOOL_CALL_ID,
        tool: PINNED_TOOL,
        idempotencyKey: `${RUN_ID}:${SECOND_TOOL_CALL_ID}`,
        capabilityIds: ['workspace.read'],
        scope: ['src/continuation-second.ts'],
        inputDigest: secondInputDigest
      }]
    };
    const secondDirectiveDigest = await digestAgentCommittedDirective(secondDirective);
    const secondDirectiveCommitted = await fixture.commands.execute({
      kind: 'run.record_inference_attempt_result',
      commandId: 'command-record-second-continuation-directive',
      runId: RUN_ID,
      expectedVersion: secondInferenceStarted.run.version,
      occurredAt: at(6),
      turnId: secondTurnId,
      attemptId: secondAttemptId,
      result: {
        status: 'succeeded',
        directive: secondDirective,
        directiveDigest: secondDirectiveDigest
      }
    }, {
      checkpoint: checkpoint(
        secondInferenceStarted.run.state.checkpointVersion + 1,
        at(6),
        'second_directive_committed'
      ),
      turnInputPayloads: [],
      effectPayloads: [{
        kind: 'record_input',
        effectId: SECOND_EFFECT_ID,
        inputDigest: secondInputDigest,
        input: SECOND_EFFECT_INPUT,
        recordedAt: at(6)
      }]
    });
    expect(secondDirectiveCommitted.run.effects.find(
      (effect) => effect.effectId === SECOND_EFFECT_ID
    )?.state.status).toBe('authorized');

    const secondEffectStarted = await fixture.commands.execute({
      kind: 'run.start_effect',
      commandId: 'command-start-second-continuation-effect',
      runId: RUN_ID,
      expectedVersion: secondDirectiveCommitted.run.version,
      occurredAt: at(7),
      effectId: SECOND_EFFECT_ID
    }, checkpointArtifacts(
      secondDirectiveCommitted.run.state.checkpointVersion + 1,
      at(7),
      'second_effect_started'
    ));
    const secondEffectSettled = await fixture.commands.execute({
      kind: 'run.record_effect_result',
      commandId: 'command-record-second-continuation-result',
      runId: RUN_ID,
      expectedVersion: secondEffectStarted.run.version,
      occurredAt: at(8),
      effectId: SECOND_EFFECT_ID,
      result: {
        status: 'succeeded',
        outputRef: 'artifact:second-continuation-result'
      }
    }, {
      checkpoint: checkpoint(
        secondEffectStarted.run.state.checkpointVersion + 1,
        at(8),
        'second_effect_result'
      ),
      turnInputPayloads: [],
      effectPayloads: [{
        kind: 'record_result',
        effectId: SECOND_EFFECT_ID,
        inputDigest: secondInputDigest,
        result: SECOND_EFFECT_RESULT,
        recordedAt: at(8)
      }]
    });

    const durableSecondTurn = await fixture.unit.loadTurnInputPayload({
      runId: RUN_ID,
      turnId: secondTurnId,
      inputDigest: fixture.plan.command.turn.inputDigest
    });
    const thirdPlan = await new DefaultAgentEffectContinuationPlanner().plan({
      run: secondEffectSettled.run,
      sourceTurnInput: durableSecondTurn,
      effectResults: [{
        kind: 'protected_result',
        runId: RUN_ID,
        effectId: SECOND_EFFECT_ID,
        toolCallId: SECOND_TOOL_CALL_ID,
        inputDigest: secondInputDigest,
        status: 'succeeded',
        result: SECOND_EFFECT_RESULT
      }]
    });
    const secondResultMessage = {
      kind: 'effect_result' as const,
      effectId: SECOND_EFFECT_ID,
      toolCallId: SECOND_TOOL_CALL_ID,
      status: 'succeeded' as const,
      result: SECOND_EFFECT_RESULT
    };
    expect(thirdPlan.turnInput.messages).toEqual([
      ...durableSecondTurn.messages,
      secondResultMessage
    ]);
    expect(effectResultMessages(thirdPlan.turnInput)).toEqual([{
      kind: 'effect_result',
      effectId: EFFECT_ID,
      toolCallId: TOOL_CALL_ID,
      status: 'succeeded',
      result: EFFECT_RESULT
    }, secondResultMessage]);

    await expect(fixture.commands.execute(
      thirdPlan.command,
      thirdPlan.artifacts
    )).resolves.toMatchObject({ replayed: false });
    await expect(fixture.unit.loadTurnInputPayload({
      runId: RUN_ID,
      turnId: thirdPlan.command.turn.turnId,
      inputDigest: thirdPlan.command.turn.inputDigest
    })).resolves.toEqual(thirdPlan.turnInput);
    await expect(fixture.commands.execute(
      thirdPlan.command,
      thirdPlan.artifacts
    )).resolves.toMatchObject({ replayed: true });

    const database = databaseOf(fixture.unit);
    tamperStrictJsonEffectResult(database, EFFECT_ID, {
      found: false,
      lineCount: 17
    });
    const afterTamper = agentControlRows(database);
    await expect(fixture.unit.loadTurnInputPayload({
      runId: RUN_ID,
      turnId: thirdPlan.command.turn.turnId,
      inputDigest: thirdPlan.command.turn.inputDigest
    })).rejects.toThrow();
    await expect(fixture.commands.execute(
      thirdPlan.command,
      thirdPlan.artifacts
    )).rejects.toThrow();
    expect(agentControlRows(database)).toEqual(afterTamper);
  });

  it.each(['ciphertext', 'aad'] as const)(
    'blocks recovery and replay after protected result %s tampering',
    async (tamperKind) => {
      const firstCodec = encryptedCodec();
      const fixture = await createSettledToolTurn('succeeded', firstCodec);
      await fixture.commands.execute(fixture.plan.command, fixture.plan.artifacts);
      await closeUnit(fixture.unit);
      firstCodec.destroy();

      tamperProtectedEffectResult(fixture.root, tamperKind);

      const reopenedCodec = encryptedCodec();
      const reopened = openUnit(fixture.root, reopenedCodec);
      try {
        const before = agentControlRows(databaseOf(reopened));
        const recovery = await reopened.listActiveRuns();
        const item = recovery.items.find((candidate) => candidate.run.runId === RUN_ID);
        expect(item).toMatchObject({ ready: false });
        await expect(reopened.loadTurnInputPayload({
          runId: RUN_ID,
          turnId: fixture.plan.command.turn.turnId,
          inputDigest: fixture.plan.command.turn.inputDigest
        })).rejects.toThrow();
        await expect(new AgentRunCommandService(reopened).execute(
          fixture.plan.command,
          fixture.plan.artifacts
        )).rejects.toThrow();
        expect(agentControlRows(databaseOf(reopened))).toEqual(before);
      } finally {
        await closeUnit(reopened);
        reopenedCodec.destroy();
      }
    }
  );
});

type SettledOutcome = 'succeeded' | 'cancelled';

interface SettledToolTurnFixture {
  readonly root: string;
  readonly unit: SqliteAgentRunUnitOfWork;
  readonly commands: AgentRunCommandService;
  readonly settledRun: AgentRun;
  readonly plan: AgentEffectContinuationPlan;
}

async function createSettledToolTurn(
  outcome: SettledOutcome,
  codec?: AesGcmAgentPersistencePayloadCodec
): Promise<SettledToolTurnFixture> {
  const root = createRoot();
  const unit = openUnit(root, codec);
  const commands = new AgentRunCommandService(unit);
  const runBinding = binding();
  const cause = {
    kind: 'conversation_objective' as const,
    messageId: runBinding.objectiveRef.kind === 'conversation_message'
      ? runBinding.objectiveRef.messageId
      : 'impossible',
    messageVersion: 1,
    contentDigest: runBinding.objectiveRef.kind === 'conversation_message'
      ? runBinding.objectiveRef.contentDigest
      : 'impossible'
  };
  const sourceInput: AgentTurnInputSnapshotV1 = {
    format: 'ariadne.agent-turn-input',
    schemaVersion: 1,
    runId: RUN_ID,
    turnId: SOURCE_TURN_ID,
    cause,
    authorityRef: {
      kind: 'conversation_message',
      sessionId: runBinding.sessionId,
      workspaceId: runBinding.workspace.workspaceId,
      messageId: cause.messageId,
      messageVersion: cause.messageVersion,
      contentDigest: cause.contentDigest
    },
    messages: [{
      kind: 'text',
      role: 'user',
      content: 'Read the continuation fixture.'
    }],
    availableTools: AVAILABLE_TOOLS
  };
  const sourceModelInput = {
    messages: sourceInput.messages,
    availableTools: sourceInput.availableTools
  };
  const sourceInputDigest = await digestAgentTurnInput(sourceModelInput);
  await commands.execute({
    kind: 'run.admit',
    commandId: 'command-admit-effect-continuation',
    runId: RUN_ID,
    occurredAt: at(0),
    binding: runBinding,
    turn: {
      cause,
      turnId: SOURCE_TURN_ID,
      attemptId: SOURCE_ATTEMPT_ID,
      providerIdempotencyKey: 'provider-effect-continuation-source',
      inputDigest: sourceInputDigest,
      inputSummary: summarizeAgentTurnInput(sourceModelInput)
    }
  }, {
    checkpoint: checkpoint(1, at(0), 'admitted'),
    turnInputPayloads: [{
      turnId: SOURCE_TURN_ID,
      inputDigest: sourceInputDigest,
      payload: sourceInput,
      recordedAt: at(0)
    }],
    effectPayloads: []
  });
  await commands.execute({
    kind: 'run.start_inference_attempt',
    commandId: 'command-start-effect-continuation-inference',
    runId: RUN_ID,
    expectedVersion: 1,
    occurredAt: at(1),
    turnId: SOURCE_TURN_ID,
    attemptId: SOURCE_ATTEMPT_ID
  }, checkpointArtifacts(2, at(1), 'inference_started'));

  const inputDigest = new Sha256AgentEffectInputDigester().digest(EFFECT_INPUT, {
    runId: RUN_ID,
    effectId: EFFECT_ID
  });
  const directive = {
    kind: 'invoke_tools' as const,
    invocations: [{
      effectId: EFFECT_ID,
      toolCallId: TOOL_CALL_ID,
      tool: PINNED_TOOL,
      idempotencyKey: `${RUN_ID}:${TOOL_CALL_ID}`,
      capabilityIds: ['workspace.read'],
      scope: ['src/continuation.ts'],
      inputDigest
    }]
  };
  const directiveDigest = await digestAgentCommittedDirective(directive);
  const directiveResult = await commands.execute({
    kind: 'run.record_inference_attempt_result',
    commandId: 'command-record-effect-continuation-directive',
    runId: RUN_ID,
    expectedVersion: 2,
    occurredAt: at(2),
    turnId: SOURCE_TURN_ID,
    attemptId: SOURCE_ATTEMPT_ID,
    result: {
      status: 'succeeded',
      directive,
      directiveDigest
    }
  }, {
    checkpoint: checkpoint(3, at(2), 'directive_committed'),
    turnInputPayloads: [],
    effectPayloads: [{
      kind: 'record_input',
      effectId: EFFECT_ID,
      inputDigest,
      input: EFFECT_INPUT,
      recordedAt: at(2)
    }]
  });
  expect(directiveResult.run.effects[0]?.state.status).toBe('authorized');

  await commands.execute({
    kind: 'run.start_effect',
    commandId: 'command-start-effect-continuation-effect',
    runId: RUN_ID,
    expectedVersion: 3,
    occurredAt: at(3),
    effectId: EFFECT_ID
  }, checkpointArtifacts(4, at(3), 'effect_started'));

  const result = await commands.execute({
    kind: 'run.record_effect_result',
    commandId: 'command-record-effect-continuation-result',
    runId: RUN_ID,
    expectedVersion: 4,
    occurredAt: at(4),
    effectId: EFFECT_ID,
    result: outcome === 'succeeded'
      ? { status: 'succeeded', outputRef: 'artifact:continuation-result' }
      : { status: 'cancelled', reason: 'user_cancelled' }
  }, {
    checkpoint: checkpoint(5, at(4), 'effect_result'),
    turnInputPayloads: [],
    effectPayloads: outcome === 'succeeded'
      ? [{
          kind: 'record_result',
          effectId: EFFECT_ID,
          inputDigest,
          result: EFFECT_RESULT,
          recordedAt: at(4)
        }]
      : []
  });
  const durableSourceInput = await unit.loadTurnInputPayload({
    runId: RUN_ID,
    turnId: SOURCE_TURN_ID,
    inputDigest: sourceInputDigest
  });
  const effect = result.run.effects.find((candidate) => candidate.effectId === EFFECT_ID);
  if (effect === undefined || effect.state.status !== outcome) {
    throw new Error('expected_terminal_effect_fixture');
  }
  const evidence: AgentTerminalEffectResultEvidence = outcome === 'succeeded'
    ? {
        kind: 'protected_result',
        runId: RUN_ID,
        effectId: EFFECT_ID,
        toolCallId: TOOL_CALL_ID,
        inputDigest,
        status: 'succeeded',
        result: EFFECT_RESULT
      }
    : {
        kind: 'aggregate_cancelled',
        runId: RUN_ID,
        effectId: EFFECT_ID,
        toolCallId: TOOL_CALL_ID,
        inputDigest,
        status: 'cancelled',
        reason: effect.state.reason
      };
  const plan = await new DefaultAgentEffectContinuationPlanner().plan({
    run: result.run,
    sourceTurnInput: durableSourceInput,
    effectResults: [evidence]
  });
  return {
    root,
    unit,
    commands,
    settledRun: result.run,
    plan
  };
}

async function replaceContinuationResult(
  plan: AgentEffectContinuationPlan,
  result: AgentJsonValue
): Promise<AgentEffectContinuationPlan> {
  let replaced = false;
  const messages = plan.turnInput.messages.map((message): AgentTurnInputMessage => {
    if (message.kind !== 'effect_result') return message;
    replaced = true;
    return { ...message, result };
  });
  if (!replaced) throw new Error('expected_effect_result_message');
  return redigestContinuation(plan, messages);
}

async function replaceContinuationTextPrefix(
  plan: AgentEffectContinuationPlan,
  content: string
): Promise<AgentEffectContinuationPlan> {
  let replaced = false;
  const messages = plan.turnInput.messages.map((message): AgentTurnInputMessage => {
    if (replaced || message.kind !== 'text') return message;
    replaced = true;
    return { ...message, content };
  });
  if (!replaced) throw new Error('expected_text_prefix_message');
  return redigestContinuation(plan, messages);
}

async function redigestContinuation(
  plan: AgentEffectContinuationPlan,
  messages: readonly AgentTurnInputMessage[]
): Promise<AgentEffectContinuationPlan> {
  const turnInput: AgentTurnInputSnapshotV1 = {
    ...plan.turnInput,
    messages
  };
  const modelInput = {
    messages: turnInput.messages,
    availableTools: turnInput.availableTools
  };
  const inputDigest = await digestAgentTurnInput(modelInput);
  const command = {
    ...plan.command,
    turn: {
      ...plan.command.turn,
      inputDigest,
      inputSummary: summarizeAgentTurnInput(modelInput)
    }
  };
  const turnInputCommit = {
    ...plan.turnInputCommit,
    inputDigest,
    payload: turnInput
  };
  return {
    ...plan,
    command,
    turnInput,
    turnInputCommit,
    artifacts: {
      ...plan.artifacts,
      turnInputPayloads: [turnInputCommit]
    }
  };
}

class CapturingAgentRunUnitOfWork implements AgentRunUnitOfWork {
  private captured: AgentRunCommandCommit | undefined;

  public constructor(private readonly delegate: AgentRunUnitOfWork) {}

  public transaction<T>(
    operation: (transaction: AgentRunTransaction) => Promise<T>
  ): Promise<T> {
    return this.delegate.transaction((transaction) => {
      const proxy = new Proxy(transaction, {
        get: (target, property) => {
          if (property === 'commitCommand') {
            return async (commit: AgentRunCommandCommit): Promise<void> => {
              this.captured = commit;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function'
            ? value.bind(target) as unknown
            : value;
        }
      });
      return operation(proxy);
    });
  }

  public requireCommit(): AgentRunCommandCommit {
    if (this.captured === undefined) throw new Error('expected_captured_commit');
    return this.captured;
  }
}

function binding(): AgentRunBinding {
  return {
    bindingVersion: 3,
    sessionId: 'session-effect-continuation-sqlite',
    objectiveRef: {
      kind: 'conversation_message',
      messageId: 'message-effect-continuation-sqlite',
      messageVersion: 1,
      contentDigest: `sha256:${'1'.repeat(64)}`
    },
    workspace: {
      workspaceId: 'workspace-effect-continuation-sqlite',
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
      ...TOOL_CATALOG,
      allowedToolNames: ['workspace.read']
    },
    budget: {
      grantId: 'grant-effect-continuation-sqlite',
      runId: RUN_ID,
      vector: {
        modelTurns: 8,
        toolCalls: 4,
        readCalls: 4,
        writeCalls: 0,
        shellCalls: 0,
        costMicrousd: 1_000_000
      },
      deadlineAt: '2031-01-01T00:00:00.000Z',
      source: { kind: 'root' }
    }
  };
}

function checkpointArtifacts(
  checkpointVersion: number,
  createdAt: string,
  phase: string
): {
  readonly checkpoint: AgentRunCheckpointCommit;
  readonly turnInputPayloads: readonly [];
  readonly effectPayloads: readonly [];
} {
  return {
    checkpoint: checkpoint(checkpointVersion, createdAt, phase),
    turnInputPayloads: [],
    effectPayloads: []
  };
}

function checkpoint(
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
      modelContext: null
    }
  };
}

function effectResultMessages(
  snapshot: AgentTurnInputSnapshotV1
): readonly Extract<AgentTurnInputMessage, { readonly kind: 'effect_result' }>[] {
  return snapshot.messages.filter(
    (message): message is Extract<
      AgentTurnInputMessage,
      { readonly kind: 'effect_result' }
    > => message.kind === 'effect_result'
  );
}

function databaseOf(unit: SqliteAgentRunUnitOfWork): DatabaseSync {
  return (unit as unknown as { readonly database: DatabaseSync }).database;
}

function agentControlRows(database: DatabaseSync): readonly unknown[] {
  const tables = (database.prepare(
    `SELECT name FROM sqlite_master
     WHERE type='table'
       AND (name='agent_control_metadata' OR name LIKE 'agent_v3_%')
     ORDER BY name`
  ).all() as Array<{ readonly name: string }>).map((row) => row.name);
  const rows = tables.map((table) => ({
    table,
    rows: database.prepare(
      `SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`
    ).all()
  }));
  const sequence = database.prepare(
    `SELECT name, seq FROM sqlite_sequence
     WHERE name LIKE 'agent_v3_%' ORDER BY name`
  ).all();
  return [...rows, { table: 'sqlite_sequence', rows: sequence }];
}

function commandCount(database: DatabaseSync, commandId: string): number {
  return Number((database.prepare(
    'SELECT COUNT(*) AS count FROM agent_v3_commands WHERE command_id=?'
  ).get(commandId) as { readonly count: number }).count);
}

function turnInputCount(database: DatabaseSync, turnId: string): number {
  return Number((database.prepare(
    'SELECT COUNT(*) AS count FROM agent_v3_turn_inputs WHERE turn_id=?'
  ).get(turnId) as { readonly count: number }).count);
}

function readEffectResultColumns(database: DatabaseSync): {
  readonly result_command_id: string | null;
  readonly result_run_version: number | null;
  readonly result_codec_id: string | null;
  readonly result_payload_json: string | null;
} {
  const row = database.prepare(
    `SELECT result_command_id, result_run_version,
            result_codec_id, result_payload_json
     FROM agent_v3_effect_payloads
     WHERE run_id=? AND effect_id=?`
  ).get(RUN_ID, EFFECT_ID) as {
    readonly result_command_id: string | null;
    readonly result_run_version: number | null;
    readonly result_codec_id: string | null;
    readonly result_payload_json: string | null;
  } | undefined;
  if (row === undefined) throw new Error('expected_effect_payload_row');
  return row;
}

function tamperStrictJsonEffectResult(
  database: DatabaseSync,
  effectId: string,
  result: AgentJsonValue
): void {
  const update = database.prepare(
    `UPDATE agent_v3_effect_payloads
     SET result_payload_json=?
     WHERE run_id=? AND effect_id=? AND result_payload_json IS NOT NULL`
  ).run(JSON.stringify(result), RUN_ID, effectId);
  if (Number(update.changes) !== 1) {
    throw new Error('expected_strict_json_effect_result');
  }
}

function tamperProtectedEffectResult(
  root: string,
  kind: 'ciphertext' | 'aad'
): void {
  const database = new DatabaseSync(resolveAgentControlDatabasePath(root));
  try {
    database.exec('PRAGMA foreign_keys=ON');
    const row = database.prepare(
      `SELECT input_digest, result_command_id, result_run_version, result_payload_json
       FROM agent_v3_effect_payloads
       WHERE run_id=? AND effect_id=?`
    ).get(RUN_ID, EFFECT_ID) as {
      readonly input_digest: string;
      readonly result_command_id: string | null;
      readonly result_run_version: number | null;
      readonly result_payload_json: string | null;
    } | undefined;
    if (
      row?.result_command_id === null
      || row?.result_run_version === null
      || row?.result_payload_json === null
      || row === undefined
    ) {
      throw new Error('expected_protected_effect_result');
    }
    if (kind === 'ciphertext') {
      const envelope = JSON.parse(row.result_payload_json) as Record<string, unknown>;
      if (typeof envelope.ciphertext !== 'string') {
        throw new Error('expected_encrypted_result_ciphertext');
      }
      envelope.ciphertext = flipBase64Byte(envelope.ciphertext);
      database.prepare(
        `UPDATE agent_v3_effect_payloads SET result_payload_json=?
         WHERE run_id=? AND effect_id=?`
      ).run(JSON.stringify(envelope), RUN_ID, EFFECT_ID);
    } else {
      const wrongContextCodec = encryptedCodec();
      try {
        const encoded = wrongContextCodec.encode(EFFECT_RESULT, {
          kind: 'effect_result',
          runId: RUN_ID,
          commandId: 'wrong-effect-result-aad-owner',
          runVersion: row.result_run_version,
          effectId: EFFECT_ID,
          inputDigest: row.input_digest
        });
        database.prepare(
          `UPDATE agent_v3_effect_payloads SET result_payload_json=?
           WHERE run_id=? AND effect_id=?`
        ).run(JSON.stringify(encoded.payload), RUN_ID, EFFECT_ID);
      } finally {
        wrongContextCodec.destroy();
      }
    }
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    database.close();
  }
}

function flipBase64Byte(value: string): string {
  const bytes = Buffer.from(value, 'base64');
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return bytes.toString('base64');
}

function encryptedCodec(): AesGcmAgentPersistencePayloadCodec {
  return new AesGcmAgentPersistencePayloadCodec(
    'effect-continuation-test-key',
    [{
      keyId: 'effect-continuation-test-key',
      key: Buffer.alloc(32, 37)
    }]
  );
}

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-effect-continuation-sqlite-'));
  roots.push(root);
  return root;
}

function openUnit(
  root: string,
  codec?: AesGcmAgentPersistencePayloadCodec
): SqliteAgentRunUnitOfWork {
  const unit = new SqliteAgentRunUnitOfWork(root, codec);
  openUnits.add(unit);
  return unit;
}

async function closeUnit(unit: SqliteAgentRunUnitOfWork): Promise<void> {
  if (!openUnits.delete(unit)) return;
  await closeUnitWithDeadline(unit);
}

async function closeUnitWithDeadline(
  unit: SqliteAgentRunUnitOfWork
): Promise<void> {
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    await unit.close(context);
  } finally {
    context.dispose();
  }
}

function at(offsetSeconds: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, 0, offsetSeconds)).toISOString();
}
